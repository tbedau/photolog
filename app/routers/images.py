from fastapi import APIRouter, Depends, Request, File, UploadFile, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.templating import Jinja2Templates
from sqlmodel import Session, select
from datetime import date as date_cls, datetime, time, timedelta
import pytz

from ..database import get_session
from ..models import User, Image
from ..security import get_current_user
from ..config import get_settings
from ..image_processing import process_and_save_image

settings = get_settings()
router = APIRouter(tags=["images"])
templates = Jinja2Templates(directory="templates")


@router.get("/", response_class=HTMLResponse)
async def index(request: Request, session: Session = Depends(get_session)):
    """Front page: the most recent N photos as a snap-scroll feed."""
    images = session.exec(
        select(Image)
        .order_by(Image.upload_date.desc())
        .limit(settings.FRONTPAGE_PHOTO_COUNT)
    ).all()

    return templates.TemplateResponse(
        request, "index.html", {"images": images}
    )


@router.get("/archive", response_class=HTMLResponse)
async def archive(request: Request, session: Session = Depends(get_session)):
    """Archive: every photo, grouped by month, newest first."""
    images = session.exec(
        select(Image).order_by(Image.upload_date.desc())
    ).all()

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

    return templates.TemplateResponse(
        request, "archive.html", {"months": months}
    )


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
    """Process and save an uploaded image, enforcing the daily upload cap."""
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
        return templates.TemplateResponse(
            request,
            "partials/error_message.html",
            {
                "error_message": f"You have reached your daily upload limit of {settings.MAX_UPLOADS_PER_DAY} image(s).",
            },
            status_code=200,
        )

    try:
        filename = await process_and_save_image(file, user_id=current_user.id)

        image = Image(
            filename=filename, original_filename=file.filename, user_id=current_user.id
        )
        session.add(image)
        session.commit()

        return JSONResponse(content={"success": True}, headers={"HX-Redirect": "/"})

    except HTTPException as e:
        return templates.TemplateResponse(
            request,
            "partials/error_message.html",
            {"error_message": e.detail},
            status_code=200,
        )
    except Exception as e:
        return templates.TemplateResponse(
            request,
            "partials/error_message.html",
            {"error_message": f"An unexpected error occurred: {e}"},
            status_code=200,
        )


@router.get("/images/{filename}")
async def get_image(filename: str, session: Session = Depends(get_session)):
    """Serve a stored image file by filename."""
    # Guard against path traversal
    if ".." in filename or "/" in filename:
        raise HTTPException(status_code=404, detail="Image not found")

    image = session.exec(select(Image).where(Image.filename == filename)).first()
    if not image:
        raise HTTPException(status_code=404, detail="Image not found")

    file_path = settings.UPLOAD_FOLDER / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Image file not found")

    return FileResponse(
        file_path,
        media_type="image/jpeg",
        filename=image.filename,
        headers={"Content-Disposition": "inline"},
    )
