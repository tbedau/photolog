import logging
import re
from datetime import date as date_cls, datetime, time, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile

logger = logging.getLogger(__name__)
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    RedirectResponse,
)
from fastapi.templating import Jinja2Templates
from sqlmodel import Session, select
import pytz

from ..config import get_settings
from ..database import get_session
from ..image_processing import (
    AVIF_WIDTHS,
    JPEG_WIDTHS,
    process_and_save_image,
)
from ..models import Image, User
from ..security import get_current_user

settings = get_settings()
router = APIRouter(tags=["images"])
templates = Jinja2Templates(directory="templates")


# Storage ids are 32-char hex UUIDs. Anything else is path traversal bait, or a
# leftover from the pre-migration flat layout — both 404.
_STORAGE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
# Derivative specs are bare width digits or the literal "original".
_SPEC_RE = re.compile(r"^(\d{2,4}|original)$")

# Long, immutable: storage paths embed an irreversible UUID, so a fresh URL is
# always issued when content changes. One year is the spec's effective max.
_IMMUTABLE_CACHE = "public, max-age=31536000, immutable"


def _picture_data(image: Image) -> dict:
    """Build the srcset/sizes/dimensions payload for one `<picture>` element.

    Centralising this means the template stays declarative — it just spreads the
    dict onto attributes — and the front-end and back-end can't drift on which
    widths actually exist on disk for any given image.
    """

    max_w = image.width or max(AVIF_WIDTHS)
    avif_widths = sorted({min(w, max_w) for w in AVIF_WIDTHS})
    jpeg_widths = sorted({min(w, max_w) for w in JPEG_WIDTHS})

    storage_id = image.filename

    def srcset(widths: list[int], ext: str) -> str:
        return ", ".join(f"/i/{storage_id}/{w}.{ext} {w}w" for w in widths)

    # `src` is only the last-resort fallback (every modern browser actually
    # picks from `srcset`). Bias to the smaller JPEG so a hypothetical
    # srcset-less client downloads less, not more.
    fallback_w = jpeg_widths[0] if jpeg_widths else max_w
    return {
        "avif_srcset": srcset(avif_widths, "avif"),
        "jpeg_srcset": srcset(jpeg_widths, "jpg"),
        "fallback_src": f"/i/{storage_id}/{fallback_w}.jpg",
        "width": image.width or 0,
        "height": image.height or 0,
        "dominant_color": image.dominant_color or "#1a1a1a",
    }


templates.env.filters["picture"] = _picture_data


@router.get("/", response_class=HTMLResponse)
async def index(request: Request, session: Session = Depends(get_session)):
    """Front page: the most recent N photos as a snap-scroll feed."""
    images = session.exec(
        select(Image)
        .order_by(Image.upload_date.desc())
        .limit(settings.FRONTPAGE_PHOTO_COUNT)
    ).all()

    return templates.TemplateResponse(request, "index.html", {"images": images})


@router.get("/archive", response_class=HTMLResponse)
async def archive(request: Request, session: Session = Depends(get_session)):
    """Archive: every photo, grouped by month, newest first."""
    images = session.exec(select(Image).order_by(Image.upload_date.desc())).all()

    months: list[dict] = []
    for image in images:
        key = (image.upload_date.year, image.upload_date.month)
        if not months or months[-1]["_key"] != key:
            months.append(
                {
                    "_key": key,
                    "label": image.upload_date.strftime("%B %Y"),
                    "images": [],
                }
            )
        months[-1]["images"].append(image)

    return templates.TemplateResponse(request, "archive.html", {"months": months})


@router.get("/{year:int}/{month:int}/{day:int}", response_class=HTMLResponse)
async def photo_detail(
    year: int,
    month: int,
    day: int,
    request: Request,
    session: Session = Depends(get_session),
):
    """Permalink: the photo for a given day, with prev/next links to navigate the timeline."""
    try:
        target = date_cls(year, month, day)
    except ValueError:
        raise HTTPException(status_code=404)

    tz = pytz.timezone(settings.TIMEZONE)
    day_start = tz.localize(datetime.combine(target, time.min))
    day_end = tz.localize(datetime.combine(target + timedelta(days=1), time.min))

    image = session.exec(
        select(Image)
        .where(Image.upload_date >= day_start)
        .where(Image.upload_date < day_end)
        .order_by(Image.upload_date.desc())
    ).first()

    if not image:
        raise HTTPException(status_code=404)

    prev_image = session.exec(
        select(Image)
        .where(Image.upload_date < day_start)
        .order_by(Image.upload_date.desc())
    ).first()

    next_image = session.exec(
        select(Image)
        .where(Image.upload_date >= day_end)
        .order_by(Image.upload_date.asc())
    ).first()

    return templates.TemplateResponse(
        request,
        "detail.html",
        {"image": image, "prev": prev_image, "next": next_image},
    )


@router.get("/upload", response_class=HTMLResponse)
async def upload_page(request: Request, current_user: User = Depends(get_current_user)):
    return templates.TemplateResponse(request, "upload.html")


@router.post("/upload")
async def upload_image(
    request: Request,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Process and save an uploaded image, enforcing the daily upload cap.

    Returns a small JSON envelope consumed by ``static/js/auth.js`` — success
    carries the post-upload redirect target, failure carries a human-readable
    ``error`` string and the appropriate HTTP status.
    """
    tz = pytz.timezone(settings.TIMEZONE)
    now = datetime.now(tz)

    start_of_day = datetime.combine(now.date(), time.min, tzinfo=tz)
    end_of_day = datetime.combine(now.date(), time.max, tzinfo=tz)

    daily_upload_count = len(
        session.exec(
            select(Image)
            .where(Image.user_id == current_user.id)
            .where(Image.upload_date >= start_of_day)
            .where(Image.upload_date <= end_of_day)
        ).all()
    )

    if daily_upload_count >= settings.MAX_UPLOADS_PER_DAY:
        return JSONResponse(
            status_code=429,
            content={
                "error": f"You have reached your daily upload limit of {settings.MAX_UPLOADS_PER_DAY} image(s)."
            },
        )

    try:
        processed = await process_and_save_image(file, user_id=current_user.id)

        image = Image(
            filename=processed.storage_id,
            original_filename=file.filename,
            user_id=current_user.id,
            width=processed.width,
            height=processed.height,
            dominant_color=processed.dominant_color,
        )
        session.add(image)
        session.commit()

        return JSONResponse(content={"success": True, "redirect": "/"})

    except HTTPException as e:
        return JSONResponse(status_code=e.status_code, content={"error": e.detail})
    except Exception:
        logger.exception("upload_failed user_id=%s", current_user.id)
        return JSONResponse(
            status_code=500,
            content={"error": "An unexpected error occurred while processing the image."},
        )


@router.get("/i/{storage_id}/{spec}.{ext}")
async def get_derivative(
    storage_id: str,
    spec: str,
    ext: str,
    session: Session = Depends(get_session),
):
    """Serve one derivative of a stored image.

    URL shape: ``/i/{32-hex}/{width|original}.{avif|jpg}``. The path is the only
    way to address a file — the DB just records which storage id belongs to which
    `Image` row, so traversal is impossible even if the regex check is wrong.
    """
    if not _STORAGE_ID_RE.match(storage_id) or not _SPEC_RE.match(spec):
        raise HTTPException(status_code=404)
    if ext not in {"avif", "jpg"}:
        raise HTTPException(status_code=404)

    image = session.exec(select(Image).where(Image.filename == storage_id)).first()
    if not image:
        raise HTTPException(status_code=404)

    file_path = settings.UPLOAD_FOLDER / storage_id / f"{spec}.{ext}"
    if not file_path.exists():
        raise HTTPException(status_code=404)

    media_type = "image/avif" if ext == "avif" else "image/jpeg"
    return FileResponse(
        file_path,
        media_type=media_type,
        headers={
            "Cache-Control": _IMMUTABLE_CACHE,
            "Content-Disposition": "inline",
        },
    )


@router.get("/images/{filename}")
async def get_legacy_image(
    filename: str, session: Session = Depends(get_session)
) -> RedirectResponse:
    """301 the pre-migration flat URLs onto a canonical derivative.

    Old shape was `{uuid}_{user_id}.jpg`. We pull the uuid prefix, look up the
    row, and redirect to a sensible mid-tier JPEG — clients with an old link
    cached in their history still resolve, search engines see one source of
    truth, and we keep no flat-layout serving code around.
    """
    if ".." in filename or "/" in filename:
        raise HTTPException(status_code=404)

    storage_id = filename.split("_", 1)[0].removesuffix(".jpg")
    if not _STORAGE_ID_RE.match(storage_id):
        raise HTTPException(status_code=404)

    image: Optional[Image] = session.exec(
        select(Image).where(Image.filename == storage_id)
    ).first()
    if not image:
        raise HTTPException(status_code=404)

    fallback_w = min(JPEG_WIDTHS[-1], image.width or JPEG_WIDTHS[-1])
    return RedirectResponse(
        url=f"/i/{storage_id}/{fallback_w}.jpg",
        status_code=301,
    )
