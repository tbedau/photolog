import os
from pathlib import Path
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

    app = FastAPI(
        title="Photolog",
        description="A simple service for uploading and displaying images.",
    )

    settings = get_settings()

    # Configure allowed CORS origins
    origins = [
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "https://photolog.tillmannbedau.de",
        "https://photolog.tillbedau.de",
    ]

    # Add middleware for CORS, security headers, and authentication redirection
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(AuthRedirectMiddleware)

    # Mount static files directory and verify security of the upload path
    static_path = Path("static").resolve()
    uploads_path = settings.UPLOAD_FOLDER.resolve()

    # Check if `uploads_path` is a subdirectory of `static_path`
    if not uploads_path.is_relative_to(static_path):
        # Static files serve only HTML and static content
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

    # Include routers for authentication and image management
    app.include_router(auth.router)
    app.include_router(images.router)

    # Startup event to initialize database and upload directory
    @app.on_event("startup")
    def on_startup():
        init_db()
        os.makedirs(settings.UPLOAD_FOLDER, exist_ok=True)

        # Restrict permissions to upload directory (owner and group access only)
        os.chmod(settings.UPLOAD_FOLDER, 0o750)

    # Custom 404 handler to redirect to home on not found errors
    @app.exception_handler(404)
    async def custom_404_handler(_, __):
        return RedirectResponse("/")

    return app


# Instantiate the application
app = create_app()
