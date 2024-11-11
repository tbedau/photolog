from fastapi import APIRouter, Depends, Request, File, UploadFile, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.templating import Jinja2Templates
from sqlmodel import Session, select

from ..database import get_session
from ..models import User, Image
from ..security import get_current_user
from ..config import get_settings
from ..image_processing import process_and_save_image

# Load settings and configure router and templates
settings = get_settings()
router = APIRouter(tags=["images"])
templates = Jinja2Templates(directory="templates")


@router.get("/", response_class=HTMLResponse)
async def index(request: Request, session: Session = Depends(get_session)):
    """
    Displays the main page with a list of images, paginated.

    Args:
        request: The HTTP request object.
        session: Database session dependency.

    Returns:
        TemplateResponse: The main page with a list of images.
    """
    page = 1
    offset = (page - 1) * settings.IMAGES_PER_PAGE
    images = session.exec(
        select(Image)
        .order_by(Image.upload_date.desc())
        .offset(offset)
        .limit(settings.IMAGES_PER_PAGE)
    ).all()

    more_images_available = len(images) == settings.IMAGES_PER_PAGE
    next_page = page + 1 if more_images_available else None

    return templates.TemplateResponse(
        "index.html", {"request": request, "images": images, "next_page": next_page}
    )


@router.get("/upload", response_class=HTMLResponse)
async def upload_page(request: Request, current_user: User = Depends(get_current_user)):
    """
    Renders the upload page for authenticated users.

    Args:
        request: The HTTP request object.
        current_user: The currently authenticated user.

    Returns:
        TemplateResponse: The upload page.
    """
    return templates.TemplateResponse("upload.html", {"request": request})


@router.post("/upload")
async def upload_image(
    request: Request,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """
    Processes and saves an uploaded image, then stores its metadata in the database.

    Args:
        request: The HTTP request object.
        file: The uploaded image file.
        current_user: The currently authenticated user.
        session: Database session dependency.

    Returns:
        JSONResponse: Success response with redirect header or error message.
    """
    try:
        # Process and save the image
        filename = await process_and_save_image(file, user_id=current_user.id)

        # Save image metadata to the database
        image = Image(
            filename=filename, original_filename=file.filename, user_id=current_user.id
        )
        session.add(image)
        session.commit()

        return JSONResponse(content={"success": True}, headers={"HX-Redirect": "/"})

    except HTTPException as e:
        # Return an error message if HTTPException occurs
        return templates.TemplateResponse(
            "partials/error_message.html",
            {"request": request, "error_message": e.detail},
            status_code=200,
        )
    except Exception as e:
        # Handle unexpected exceptions
        return templates.TemplateResponse(
            "partials/error_message.html",
            {"request": request, "error_message": f"An unexpected error occurred: {e}"},
            status_code=200,
        )


@router.get("/load_images", response_class=HTMLResponse)
async def load_images(
    request: Request, page: int = 1, session: Session = Depends(get_session)
):
    """
    Loads a page of images for infinite scrolling or pagination.

    Args:
        request: The HTTP request object.
        page: The current page number.
        session: Database session dependency.

    Returns:
        TemplateResponse: Partial HTML with a list of images for the requested page.
    """
    offset = (page - 1) * settings.IMAGES_PER_PAGE
    images = session.exec(
        select(Image)
        .order_by(Image.upload_date.desc())
        .offset(offset)
        .limit(settings.IMAGES_PER_PAGE)
    ).all()

    more_images_available = len(images) == settings.IMAGES_PER_PAGE
    next_page = page + 1 if more_images_available else None

    return templates.TemplateResponse(
        "partials/image_list.html",
        {"request": request, "images": images, "next_page": next_page},
    )


@router.get("/images/{filename}")
async def get_image(filename: str, session: Session = Depends(get_session)):
    """
    Serves a stored image file if the file exists.

    Args:
        filename: The unique filename of the stored image.
        session: Database session dependency.

    Returns:
        FileResponse: The image file response.

    Raises:
        HTTPException: If the image is not found or the filename is invalid.
    """
    # Validate the filename to prevent path traversal
    if ".." in filename or "/" in filename:
        raise HTTPException(status_code=404, detail="Image not found")

    # Check if the image exists in the database
    image = session.exec(select(Image).where(Image.filename == filename)).first()

    if not image:
        raise HTTPException(status_code=404, detail="Image not found")

    # Construct the full path to the image file
    file_path = settings.UPLOAD_FOLDER / filename

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Image file not found")

    return FileResponse(
        file_path,
        media_type="image/jpeg",
        filename=image.filename,
        headers={"Content-Disposition": "inline"},
    )
