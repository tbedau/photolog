import os
from pathlib import Path
from contextlib import asynccontextmanager
import logging
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from fastapi.middleware.cors import CORSMiddleware

from app.database import init_db
from app.config import get_settings
from app.middleware import AuthRedirectMiddleware, SecurityHeadersMiddleware
from app.routers import auth, images

# Configure the logger
logger = logging.getLogger(__name__)


def create_app() -> FastAPI:
    """Creates and configures the FastAPI app for the image upload service."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Startup actions
        init_db()
        os.makedirs(settings.UPLOAD_FOLDER, exist_ok=True)
        os.chmod(settings.UPLOAD_FOLDER, 0o750)
        yield

    app = FastAPI(
        title="Photolog",
        description="A simple service for uploading and displaying images.",
        lifespan=lifespan,
    )

    settings = get_settings()

    # Configure allowed CORS origins
    origins = [
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "https://photolog.tillmannbedau.de",
        "https://photolog.tillbedau.de",
    ]

    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(AuthRedirectMiddleware)

    static_path = Path("static").resolve()
    uploads_path = settings.UPLOAD_FOLDER.resolve()

    if not uploads_path.is_relative_to(static_path):
        app.mount(
            "/static", StaticFiles(directory=static_path, html=True), name="static"
        )
    else:
        logger.error(
            "Upload directory must be outside of static directory for security reasons."
        )
        raise ValueError(
            "Insecure static file configuration - upload directory is inside static path."
        )

    app.include_router(auth.router)
    app.include_router(images.router)

    @app.exception_handler(404)
    async def custom_404_handler(_, __):
        return RedirectResponse("/")

    return app


app = create_app()
