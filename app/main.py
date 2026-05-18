import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.responses import JSONResponse

from app.database import init_db
from app.config import get_settings
from app.middleware import AuthRedirectMiddleware, SecurityHeadersMiddleware
from app.routers import auth, images

logger = logging.getLogger(__name__)


def create_app() -> FastAPI:
    """Creates and configures the FastAPI app for the image upload service."""

    settings = get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        init_db()
        os.makedirs(settings.UPLOAD_FOLDER, exist_ok=True)
        os.chmod(settings.UPLOAD_FOLDER, 0o750)
        yield

    # /docs and /openapi.json are off in production — this is a single-admin
    # site with no public API surface, no reason to advertise routes.
    docs_kwargs = (
        {} if settings.ENVIRONMENT == "development" else {"docs_url": None, "redoc_url": None, "openapi_url": None}
    )
    app = FastAPI(
        title="Photolog",
        description="A simple service for uploading and displaying images.",
        lifespan=lifespan,
        **docs_kwargs,
    )

    # No CORS middleware: this is a server-rendered HTML site with no
    # cross-origin clients. Allowing credentialed CORS would only widen the
    # surface for free.
    #
    # Host allowlist is strict in production; wide open in development so that
    # `fastapi dev --host 0.0.0.0` is reachable from a phone on the same LAN
    # (the Host header will be the laptop's 192.168.x.x).
    allowed_hosts = (
        ["*"] if settings.ENVIRONMENT == "development"
        else list(settings.ALLOWED_HOSTS)
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(AuthRedirectMiddleware)
    app.add_middleware(SlowAPIMiddleware)

    app.state.limiter = auth.limiter

    @app.exception_handler(RateLimitExceeded)
    async def _rate_limit_handler(request: Request, exc: RateLimitExceeded):
        return JSONResponse(
            status_code=429,
            content={"detail": "Too many requests"},
            headers={"Retry-After": "60"},
        )

    static_path = Path("static").resolve()
    uploads_path = settings.UPLOAD_FOLDER.resolve()

    if uploads_path.is_relative_to(static_path):
        raise ValueError(
            "Insecure static file configuration - upload directory is inside static path."
        )
    app.mount("/static", StaticFiles(directory=static_path, html=True), name="static")

    app.include_router(auth.router)
    app.include_router(images.router)

    @app.exception_handler(404)
    async def custom_404_handler(request: Request, _):
        # Only redirect HTML navigations. API/asset 404s stay 404 so tools,
        # crawlers, and the browser cache behave honestly.
        if "text/html" in request.headers.get("accept", ""):
            return RedirectResponse("/")
        return JSONResponse(status_code=404, content={"detail": "Not Found"})

    return app


app = create_app()
