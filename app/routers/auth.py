from datetime import timedelta
import logging

from fastapi import APIRouter, Depends, Request, Response, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlmodel import Session

from ..database import get_session
from ..security import authenticate_user, create_access_token, get_current_user
from ..config import get_settings

logger = logging.getLogger(__name__)

settings = get_settings()
router = APIRouter(tags=["authentication"])
templates = Jinja2Templates(directory="templates")

# Per-IP brute-force brake. Argon2id is already slow, but a hard ceiling keeps
# a determined attacker from saturating CPU on the only password endpoint.
limiter = Limiter(key_func=get_remote_address)


def _set_auth_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=settings.cookie_name,
        value=token,
        max_age=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="strict",
        path="/",
    )


def _clear_auth_cookie(response: Response) -> None:
    response.delete_cookie(
        key=settings.cookie_name,
        path="/",
        secure=settings.cookie_secure,
        httponly=True,
        samesite="strict",
    )


@router.get("/login", response_class=HTMLResponse)
async def login_page(request: Request, session: Session = Depends(get_session)):
    """Render the login form, or bounce to /upload if a valid session is present."""
    if request.cookies.get(settings.cookie_name):
        try:
            if await get_current_user(request=request, session=session):
                return RedirectResponse(
                    url="/upload", status_code=status.HTTP_302_FOUND
                )
        except HTTPException:
            pass
    return templates.TemplateResponse(request, "login.html")


@router.post("/token")
@limiter.limit("5/minute")
async def login(
    request: Request,
    form_data: OAuth2PasswordRequestForm = Depends(),
    session: Session = Depends(get_session),
):
    """Verify credentials, issue a JWT, set it as a hardened cookie."""
    user = authenticate_user(form_data.username, form_data.password, session)
    if not user:
        logger.warning(
            "login_failed username=%s ip=%s",
            form_data.username,
            get_remote_address(request),
        )
        # Generic message — no user-existence distinction, no internal detail.
        # The 401 trips AuthRedirectMiddleware only for HTML navigations; the
        # login JS sends Accept: application/json, so it sees the JSON body.
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={"error": "Incorrect username or password"},
        )

    logger.info("login_success username=%s", user.username)
    access_token = create_access_token(
        data={"sub": user.username},
        expires_delta=timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES),
    )
    response = JSONResponse(content={"success": True, "redirect": "/upload"})
    _set_auth_cookie(response, access_token)
    return response


@router.post("/logout")
async def logout():
    """POST-only logout — GET would let prefetchers and crawlers sign people out."""
    response = RedirectResponse(url="/", status_code=status.HTTP_303_SEE_OTHER)
    _clear_auth_cookie(response)
    return response
