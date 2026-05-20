"""Image ingest pipeline.

A single upload fans out into a directory of derivatives suited to the front-end
`<picture>` markup:

    uploads/{uuid}/
        original.jpg     ← EXIF-stripped, oriented copy at full resolution
        3200.avif        ← AVIF rendition at each width ≤ source
        1920.avif
        1280.avif
        640.avif
        320.avif
        3200.jpg         ← JPEG fallback at the two largest widths
        1280.jpg

Why these choices:

* AVIF is the primary delivery format (≥95% of 2026 traffic supports it). Quality
  65 with libaom film-grain synthesis (``denoise-noise-level``) ends up roughly
  half the size of equivalent JPEG while keeping grain on film scans and X100VI
  frames from turning into smeared mush.
* Two JPEG widths cover the AVIF-less tail (mostly iOS 15). Five AVIF widths
  give browsers room to pick the closest fit for the device DPR × CSS-width.
* The original is kept so we can re-encode later if codecs improve, without
  having to ask uploaders to send the file again.

Dimensions and a single dominant colour are returned alongside the storage id so
the model can render `aspect-ratio` and a placeholder background — both of which
eliminate layout shift before pixels arrive.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Optional
from uuid import uuid4
import io

from PIL import Image as PILImage, ImageOps, UnidentifiedImageError
from fastapi import HTTPException, UploadFile

from .config import get_settings

settings = get_settings()


# Widths we emit. Tuned to the two real surfaces — viewport-sized feed slides
# (sizes="100vw") and the 2-to-5-column archive masonry (sizes ≈ 20–50vw).
# Browsers pick the smallest entry that satisfies CSS-px × DPR for the slot.
AVIF_WIDTHS: tuple[int, ...] = (320, 640, 1280, 1920, 3200)
JPEG_WIDTHS: tuple[int, ...] = (1280, 3200)

AVIF_QUALITY = 65
AVIF_SPEED = 4  # 0 = best, 10 = fastest. 4 is the usual quality/CPU sweet spot.
JPEG_QUALITY = 85

ALLOWED_CONTENT_TYPES = frozenset(
    {"image/jpeg", "image/jpg", "image/png", "image/tiff", "image/heic", "image/heif"}
)


@dataclass(frozen=True)
class ProcessedImage:
    """Result of processing a single upload."""

    storage_id: str  # UUID hex — directory name under UPLOAD_FOLDER
    width: int  # canonical width after EXIF orientation
    height: int
    dominant_color: str  # "#rrggbb"


def _dominant_color(img: PILImage.Image) -> str:
    """Average colour of the image, returned as #rrggbb.

    A single tone is the right placeholder for this site's restrained aesthetic
    — blurhash would be visual noise behind a 100ms paint. Pillow's 1×1 thumb is
    a clean average without the overhead of a k-means pass.
    """
    swatch = img.convert("RGB").resize((1, 1), PILImage.Resampling.LANCZOS)
    r, g, b = swatch.getpixel((0, 0))
    return f"#{r:02x}{g:02x}{b:02x}"


def _resized(img: PILImage.Image, width: int) -> PILImage.Image:
    """Return img resized so its width is `width`, preserving aspect ratio."""
    if img.width == width:
        return img
    ratio = width / img.width
    new_size = (width, max(1, round(img.height * ratio)))
    return img.resize(new_size, PILImage.Resampling.LANCZOS)


def _save_avif(img: PILImage.Image, path: Path) -> None:
    # `denoise-noise-level` triggers libaom's grain-table generation: detail is
    # encoded once, then synthesized back on decode. Crucial for film scans
    # where smoothing out the grain reads as a quality regression.
    img.save(
        path,
        format="AVIF",
        quality=AVIF_QUALITY,
        speed=AVIF_SPEED,
        subsampling="4:2:0",
        advanced={"denoise-noise-level": "8"},
    )


def _save_jpeg(img: PILImage.Image, path: Path) -> None:
    img.save(
        path,
        format="JPEG",
        quality=JPEG_QUALITY,
        progressive=True,
        optimize=True,
    )


def _target_widths(max_w: int) -> tuple[list[int], list[int]]:
    """Return the (avif, jpeg) width ladders, capped at the source width.

    We never upscale — a smaller-than-target source just truncates the ladder,
    so legacy 1600px uploads end up with widths up to 1600 and nothing above.
    Sorted ascending; encoders iterate descending so the largest (slowest)
    encode lands first and the bar visibly moves on every step after that.
    """
    return (
        sorted({min(w, max_w) for w in AVIF_WIDTHS}),
        sorted({min(w, max_w) for w in JPEG_WIDTHS}),
    )


def _encode_derivatives(source: PILImage.Image, out_dir: Path) -> None:
    """Write all AVIF + JPEG derivatives whose target width fits the source.

    Used by the one-shot migration CLI. The upload pipeline interleaves these
    same encodes with progress events — see ``iter_process_image_bytes``.
    """
    avif_widths, jpeg_widths = _target_widths(source.width)
    for width in sorted(avif_widths, reverse=True):
        _save_avif(_resized(source, width), out_dir / f"{width}.avif")
    for width in sorted(jpeg_widths, reverse=True):
        _save_jpeg(_resized(source, width), out_dir / f"{width}.jpg")


def _open_oriented(data: bytes) -> PILImage.Image:
    """Open `data`, apply EXIF orientation, return a fresh metadata-free RGB image.

    `ImageOps.exif_transpose` is the canonical replacement for the hand-rolled
    rotation cascade — it handles all eight EXIF orientations and returns a copy
    without the orientation tag, so downstream encoders won't double-rotate.
    """
    img = PILImage.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img)
    if img.mode != "RGB":
        img = img.convert("RGB")
    # `Image.new + putdata` from the old pipeline scrubbed metadata at the cost
    # of an extra allocation and pass over every pixel. Re-opening from a fresh
    # buffer is both faster and complete — JPEG/AVIF saves below won't carry any
    # of the source's EXIF/XMP/ICC unless we explicitly pass them.
    return img


def iter_process_image_bytes(
    image_data: bytes, *, content_type: Optional[str] = None
) -> Iterator[dict]:
    """Stream the upload pipeline as a sequence of phase events.

    Each yielded dict has a ``phase`` key — "decode", "original", "avif",
    "jpeg", "complete", or "error" — plus a ``status`` of "active" or "done"
    for the in-progress phases. The terminal event is one of:

    * ``{"phase": "complete", "storage_id", "width", "height", "dominant_color"}``
    * ``{"phase": "error", "status_code", "detail"}``

    Errors are yielded rather than raised because the upload route streams these
    events to the browser inside a chunked HTTP response — once the response has
    started, an exception can't reach the client cleanly. Callers that want the
    old throw-on-failure contract should use ``process_image_bytes``, which
    drains this generator.
    """
    if len(image_data) > settings.MAX_FILE_SIZE:
        yield {
            "phase": "error",
            "status_code": 400,
            "detail": f"File too large. Max size is {settings.MAX_FILE_SIZE // (1024 * 1024)} MB.",
        }
        return

    if content_type and content_type not in ALLOWED_CONTENT_TYPES:
        yield {
            "phase": "error",
            "status_code": 400,
            "detail": "Unsupported file format. Allowed: JPEG, PNG, TIFF, HEIC/HEIF.",
        }
        return

    yield {"phase": "decode", "status": "active"}

    try:
        oriented = _open_oriented(image_data)
    except UnidentifiedImageError:
        yield {
            "phase": "error",
            "status_code": 400,
            "detail": "Error processing image. Unsupported or corrupted file.",
        }
        return

    # Cap the source at MAX_DIMENSION here so the saved "original" already
    # respects site-wide limits. Anything beyond would only ever be downsampled
    # for delivery anyway — there's no reason to hold onto a 24-megapixel file.
    longest = max(oriented.width, oriented.height)
    if longest > settings.MAX_DIMENSION:
        scale = settings.MAX_DIMENSION / longest
        oriented = oriented.resize(
            (round(oriented.width * scale), round(oriented.height * scale)),
            PILImage.Resampling.LANCZOS,
        )

    avif_widths, jpeg_widths = _target_widths(oriented.width)

    yield {
        "phase": "decode",
        "status": "done",
        "width": oriented.width,
        "height": oriented.height,
        "avif_widths": avif_widths,
        "jpeg_widths": jpeg_widths,
    }

    storage_id = uuid4().hex
    out_dir = Path(settings.UPLOAD_FOLDER) / storage_id
    out_dir.mkdir(parents=True, exist_ok=False)

    def _cleanup() -> None:
        # Roll back the directory on partial failure so we don't end up with
        # half-encoded sets that the serving route would 200 with missing tiers.
        for p in out_dir.glob("*"):
            p.unlink(missing_ok=True)
        try:
            out_dir.rmdir()
        except OSError:
            pass

    try:
        yield {"phase": "original", "status": "active"}
        _save_jpeg(oriented, out_dir / "original.jpg")
        yield {"phase": "original", "status": "done"}

        # Largest first: gives the user the slowest encode out of the way
        # first so the checklist visibly moves on every step after that.
        for width in sorted(avif_widths, reverse=True):
            yield {"phase": "avif", "status": "active", "width": width}
            _save_avif(_resized(oriented, width), out_dir / f"{width}.avif")
            yield {"phase": "avif", "status": "done", "width": width}

        for width in sorted(jpeg_widths, reverse=True):
            yield {"phase": "jpeg", "status": "active", "width": width}
            _save_jpeg(_resized(oriented, width), out_dir / f"{width}.jpg")
            yield {"phase": "jpeg", "status": "done", "width": width}
    except Exception:
        _cleanup()
        yield {
            "phase": "error",
            "status_code": 500,
            "detail": "An error occurred while processing the image.",
        }
        return

    yield {
        "phase": "complete",
        "storage_id": storage_id,
        "width": oriented.width,
        "height": oriented.height,
        "dominant_color": _dominant_color(oriented),
    }


def process_image_bytes(
    image_data: bytes, *, content_type: Optional[str] = None
) -> ProcessedImage:
    """Throw-on-failure wrapper around the streaming pipeline.

    Used by ``process_and_save_image`` (and through it the migration CLI) where
    the caller doesn't care about per-phase progress and just wants a synchronous
    ``ProcessedImage`` or an ``HTTPException``.
    """
    for event in iter_process_image_bytes(image_data, content_type=content_type):
        if event["phase"] == "error":
            raise HTTPException(
                status_code=event["status_code"], detail=event["detail"]
            )
        if event["phase"] == "complete":
            return ProcessedImage(
                storage_id=event["storage_id"],
                width=event["width"],
                height=event["height"],
                dominant_color=event["dominant_color"],
            )
    # iter_process_image_bytes always emits a terminal event; this is here to
    # satisfy type checkers and surface the bug loudly if it ever doesn't.
    raise HTTPException(status_code=500, detail="Image pipeline did not terminate.")


async def process_and_save_image(
    file: UploadFile, user_id: int, content_type: Optional[str] = None
) -> ProcessedImage:
    """Async entry point used by the migration CLI. `user_id` is no longer
    encoded into the filename — the storage id is a bare UUID and ownership lives
    only in the database."""
    image_data = await file.read()
    actual_content_type = content_type or file.content_type
    return process_image_bytes(image_data, content_type=actual_content_type)
