import asyncio
import io
import shutil
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import typer
from fastapi import HTTPException, UploadFile
from PIL import Image as PILImage, ImageOps
from sqlmodel import select

from app.config import get_settings
from app.database import get_session, init_db
from app.image_processing import (
    AVIF_WIDTHS,
    JPEG_WIDTHS,
    process_and_save_image,
)
from app.image_processing import (
    _dominant_color,
    _encode_derivatives,
    _save_jpeg,
)
from app.models import Image, User
from app.security import hash_password

app = typer.Typer()
settings = get_settings()


class CustomUploadFile(UploadFile):
    def __init__(self, filename: str, content_type: str, file: io.BytesIO):
        super().__init__(filename=filename, file=file)
        self.content_type = content_type


def get_db_session():
    with next(get_session()) as session:
        yield session


@app.command()
def init():
    """
    Initialize the database and create tables.
    """
    init_db()
    typer.echo("Database initialized.")


@app.command()
def create_user(username: str):
    """
    Create a new user with the specified username. Prompts for password securely.
    """
    session = next(get_db_session())
    existing_user = session.exec(select(User).where(User.username == username)).first()
    if existing_user:
        typer.echo("User with this username already exists.")
        return

    password = typer.prompt("Enter password", hide_input=True)
    hashed_password = hash_password(password)
    user = User(username=username, hashed_password=hashed_password)
    session.add(user)
    session.commit()
    typer.echo(f"User '{username}' created successfully.")


@app.command()
def upload_image(username: str, file_path: str):
    """
    Upload an image for a user, specified by their username.
    Uses the same validation as the regular API endpoint.

    Args:
        username: The username of the user uploading the image.
        file_path: The path to the image file to upload.
    """
    session = next(get_db_session())
    user = session.exec(select(User).where(User.username == username)).first()
    if not user:
        typer.echo("User not found.")
        return

    file_path = Path(file_path)
    if not file_path.exists() or not file_path.is_file():
        typer.echo("File does not exist.")
        return

    extension = file_path.suffix.lower()
    content_type = None
    if extension in [".jpg", ".jpeg"]:
        content_type = "image/jpeg"
    elif extension == ".png":
        content_type = "image/png"
    elif extension == ".tiff":
        content_type = "image/tiff"
    else:
        typer.echo("Unsupported file format.")
        return

    file_content = file_path.read_bytes()
    file = UploadFile(filename=file_path.name, file=io.BytesIO(file_content))

    try:
        processed = asyncio.run(
            process_and_save_image(file, user_id=user.id, content_type=content_type)
        )

        image = Image(
            filename=processed.storage_id,
            original_filename=file_path.name,
            user_id=user.id,
            width=processed.width,
            height=processed.height,
            dominant_color=processed.dominant_color,
        )
        session.add(image)
        session.commit()

        typer.echo(
            f"Image '{file_path.name}' uploaded successfully for user '{username}'."
        )

    except HTTPException as e:
        typer.echo(f"Error: {e.detail}")
    except Exception as e:
        typer.echo(f"An unexpected error occurred: {e}")


@app.command()
def delete_image(filename: str):
    """Delete an image by its storage id (or legacy flat filename)."""
    session = next(get_db_session())
    storage_id = filename.split("_", 1)[0].removesuffix(".jpg")

    image = session.exec(select(Image).where(Image.filename == storage_id)).first()
    if not image:
        typer.echo("Image not found.")
        return

    # New layout: per-image directory. Fall back to the legacy flat file path
    # so this command keeps working on a database that hasn't been migrated yet.
    storage_dir = settings.UPLOAD_FOLDER / image.filename
    if storage_dir.is_dir():
        shutil.rmtree(storage_dir)
    else:
        legacy = settings.UPLOAD_FOLDER / filename
        if legacy.exists():
            legacy.unlink()

    session.delete(image)
    session.commit()
    typer.echo(f"Image '{filename}' deleted successfully.")


@app.command()
def clean_images():
    """
    Delete all images from the database and remove image files from storage.
    """
    session = next(get_db_session())
    images = session.exec(select(Image)).all()

    for image in images:
        storage_dir = settings.UPLOAD_FOLDER / image.filename
        if storage_dir.is_dir():
            shutil.rmtree(storage_dir)
        session.delete(image)

    session.commit()
    typer.echo("All images deleted from database and storage.")


def _migrate_one(args: tuple[Path, str, int]) -> dict:
    """Worker that runs in a child process.

    Takes the legacy flat path plus the (already known) storage id, lays out the
    per-image directory, and returns metadata for the main process to write to
    the DB. Pure file work — no DB handles travel between processes.
    """
    legacy_path, storage_id, image_id = args
    uploads = Path(settings.UPLOAD_FOLDER)
    target_dir = uploads / storage_id

    # If the target dir already has derivatives, this row was migrated in a
    # previous run — read the metadata back instead of re-encoding.
    original = target_dir / "original.jpg"
    if original.exists():
        with PILImage.open(original) as img:
            return {
                "image_id": image_id,
                "storage_id": storage_id,
                "width": img.width,
                "height": img.height,
                "dominant_color": _dominant_color(img),
                "reencoded": False,
            }

    if not legacy_path.exists():
        return {"image_id": image_id, "missing": True}

    target_dir.mkdir(parents=True, exist_ok=True)

    # The legacy file has already been EXIF-stripped + auto-rotated by the old
    # pipeline, so we can treat it directly as the master. Renaming preserves
    # it at its current generation; re-saving would add an extra lossy pass
    # for no benefit on the bytes themselves.
    img = PILImage.open(legacy_path)
    img = ImageOps.exif_transpose(img)
    if img.mode != "RGB":
        img = img.convert("RGB")

    _encode_derivatives(img, target_dir)

    width, height = img.width, img.height
    color = _dominant_color(img)
    img.close()

    # Move the legacy file into the per-image directory as the master. Only
    # safe after the derivatives have been written.
    legacy_path.rename(original)

    return {
        "image_id": image_id,
        "storage_id": storage_id,
        "width": width,
        "height": height,
        "dominant_color": color,
        "reencoded": True,
    }


@app.command()
def migrate_images(
    workers: int = typer.Option(4, help="Parallel encoder processes."),
    dry_run: bool = typer.Option(False, help="Plan the work without touching files."),
):
    """Convert every legacy flat-layout image into the new per-image directory
    with full AVIF + JPEG derivative ladder. Idempotent — re-run anytime.

    For each `Image` row, the legacy file `uploads/{uuid}_{user_id}.jpg` is
    re-encoded into `uploads/{uuid}/`, the row's `filename` becomes the bare
    UUID, and `width`/`height`/`dominant_color` are filled.
    """
    session = next(get_db_session())
    images = session.exec(select(Image).order_by(Image.id)).all()

    jobs: list[tuple[Path, str, int]] = []
    skipped = 0
    for image in images:
        # Already migrated rows store the bare UUID in `filename`. Legacy rows
        # store `{uuid}_{user_id}.jpg`. Either way the UUID is the prefix.
        storage_id = image.filename.split("_", 1)[0].removesuffix(".jpg")
        legacy_path = settings.UPLOAD_FOLDER / image.filename

        target_dir = settings.UPLOAD_FOLDER / storage_id
        if (target_dir / "original.jpg").exists() and image.width and image.height:
            skipped += 1
            continue

        jobs.append((legacy_path, storage_id, image.id))

    typer.echo(
        f"To migrate: {len(jobs)} image(s). Already done: {skipped}. "
        f"Total: {len(images)}."
    )
    if dry_run or not jobs:
        return

    if workers <= 1:
        results = [_migrate_one(j) for j in jobs]
    else:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(_migrate_one, j) for j in jobs]
            results = []
            for i, fut in enumerate(as_completed(futures), 1):
                r = fut.result()
                results.append(r)
                typer.echo(f"  [{i}/{len(jobs)}] image {r['image_id']}")

    missing = sum(1 for r in results if r.get("missing"))
    written = sum(1 for r in results if r.get("reencoded"))
    typer.echo(f"Re-encoded {written}, missing-on-disk {missing}.")

    # Apply DB updates in the main process — child processes don't share the
    # engine, and SQLite is happiest with one writer anyway.
    for r in results:
        if r.get("missing"):
            continue
        row = session.exec(select(Image).where(Image.id == r["image_id"])).first()
        if not row:
            continue
        row.filename = r["storage_id"]
        row.width = r["width"]
        row.height = r["height"]
        row.dominant_color = r["dominant_color"]
        session.add(row)
    session.commit()
    typer.echo("Database updated.")


if __name__ == "__main__":
    app()
