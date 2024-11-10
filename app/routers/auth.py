from datetime import timedelta
from fastapi import APIRouter, Depends, Request, Response, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from sqlmodel import Session

from ..database import get_session
from ..security import authenticate_user, create_access_token, get_current_user
from ..config import get_settings

# Load settings and configure router and templates
settings = get_settings()
router = APIRouter(tags=["authentication"])
templates = Jinja2Templates(directory="templates")

@router.get("/login", response_class=HTMLResponse)
async def login_page(request: Request, session: Session = Depends(get_session)):
    """
    Renders the login page or redirects to the upload page if the user is already authenticated.

    Args:
        request: The HTTP request object.
        session: Database session dependency.

    Returns:
        TemplateResponse: Login page if user is not authenticated.
        RedirectResponse: Redirect to upload page if already authenticated.
    """
    if request.cookies.get(settings.COOKIE_NAME):
        try:
            current_user = await get_current_user(request=request, session=session)
            if current_user:
                return RedirectResponse(url="/upload", status_code=status.HTTP_302_FOUND)
        except HTTPException:
            pass  # Ignore errors and proceed to login page
    return templates.TemplateResponse("login.html", {"request": request})

@router.post("/token")
async def login(
    request: Request,
    response: Response,
    form_data: OAuth2PasswordRequestForm = Depends(),
    session: Session = Depends(get_session),
):
    """
    Authenticates the user and returns a JSON response with a redirect header.
    
    Args:
        request: The HTTP request object.
        response: The HTTP response object.
        form_data: The OAuth2 password request form containing user credentials.
        session: Database session dependency.

    Returns:
        JSONResponse: Response indicating success or failure, with a redirect header on success.
    """
    # Authenticate the user
    user = authenticate_user(form_data.username, form_data.password, session)
    if not user:
        # Render error message if authentication fails
        return templates.TemplateResponse(
            "partials/error_message.html",
            {"request": request, "error_message": "Incorrect username or password"},
            status_code=200
        )

    # Create access token and set expiration
    access_token_expires = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.username}, expires_delta=access_token_expires
    )
    
    # Set token as an HTTP-only cookie
    response = JSONResponse(
        content={"success": True}, 
        headers={"HX-Redirect": "/upload"}
    )
    response.set_cookie(
        key=settings.COOKIE_NAME,
        value=access_token,
        httponly=True,
        secure=False,  # Ensure cookie is secure in production (HTTPS only)
        samesite="Strict"  # Prevent CSRF
    )
    return response

@router.get("/logout")
async def logout():
    """
    Logs the user out by deleting the authentication cookie and redirecting to the home page.

    Returns:
        RedirectResponse: Redirects to the home page after logout.
    """
    response = RedirectResponse(url="/", status_code=status.HTTP_302_FOUND)
    response.delete_cookie(settings.COOKIE_NAME)
    return response
