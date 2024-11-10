import io
import asyncio
import typer
from sqlmodel import select
from pathlib import Path
from fastapi import HTTPException, UploadFile
from app.database import get_session, init_db
from app.models import User, Image
from app.security import hash_password
from app.config import get_settings
from app.image_processing import process_and_save_image

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
def create_user(username: str, password: str):
    """
    Create a new user with the specified username and password.
    """
    session = next(get_db_session())
    existing_user = session.exec(select(User).where(User.username == username)).first()
    if existing_user:
        typer.echo("User with this username already exists.")
        return

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

    # Determine the content type based on the file extension
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

    # Prepare the file as an UploadFile object for processing
    file_content = file_path.read_bytes()
    file = UploadFile(filename=file_path.name, file=io.BytesIO(file_content))

    try:
        # Run the async process_and_save_image function with the content_type
        filename = asyncio.run(process_and_save_image(file, user_id=user.id, content_type=content_type))
        
        # Save image metadata to the database
        image = Image(
            filename=filename,
            original_filename=file_path.name,
            user_id=user.id
        )
        session.add(image)
        session.commit()
        
        typer.echo(f"Image '{file_path.name}' uploaded successfully for user '{username}'.")

    except HTTPException as e:
        typer.echo(f"Error: {e.detail}")
    except Exception as e:
        typer.echo(f"An unexpected error occurred: {e}")

@app.command()
def delete_image(filename: str):
    """
    Delete an image by its filename.
    """
    session = next(get_db_session())
    image = session.exec(select(Image).where(Image.filename == filename)).first()
    if not image:
        typer.echo("Image not found.")
        return

    file_path = settings.UPLOAD_FOLDER / image.filename
    if file_path.exists():
        file_path.unlink()

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
        file_path = settings.UPLOAD_FOLDER / image.filename
        if file_path.exists():
            file_path.unlink()
        session.delete(image)

    session.commit()
    typer.echo("All images deleted from database and storage.")

if __name__ == "__main__":
    app()
