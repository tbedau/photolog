import os
from fastapi import Request
from fastapi.responses import RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Middleware to add security-related headers to each response."""
    
    async def dispatch(self, request: Request, call_next):
        # Skip adding security headers for Swagger UI and OpenAPI routes
        if request.url.path in ["/docs", "/openapi.json"]:
            return await call_next(request)
        
        response = await call_next(request)
        
        # Security headers for enhanced security
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        
        # Content Security Policy (CSP)
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "img-src 'self' data:; "
            "script-src 'self' 'unsafe-inline' https://unpkg.com; "
            "style-src 'self' 'unsafe-inline'; "
            "connect-src 'self'; "
            "frame-ancestors 'none'; "
            "form-action 'self'; "
            "base-uri 'self';"
        )
        
        return response

class AuthRedirectMiddleware(BaseHTTPMiddleware):
    """Middleware to redirect unauthorized users to the login page if accessing HTML content."""
    
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        
        # Redirect to login if unauthorized and HTML content is requested
        if response.status_code == 401 and "text/html" in request.headers.get("accept", ""):
            return RedirectResponse(url="/login")
        
        return response

class SecureStaticFilesMiddleware(BaseHTTPMiddleware):
    """
    Middleware to secure access to uploaded files, protecting against path traversal and unauthorized access.
    
    Args:
        app: The FastAPI application instance.
        upload_path (str): Path to the directory where uploads are stored.
    """
    
    def __init__(self, app, upload_path: str):
        super().__init__(app)
        self.upload_path = upload_path

    async def dispatch(self, request: Request, call_next):
        # Ensure uploaded files are securely accessed
        if request.url.path.startswith("/static/uploads/"):
            filename = os.path.basename(request.url.path)
            
            # Protect against path traversal attempts
            if ".." in filename or "/" in filename:
                return RedirectResponse("/")
            
            # Verify if the file exists within the upload directory
            file_path = os.path.join(self.upload_path, filename)
            if not os.path.exists(file_path):
                return RedirectResponse("/")
        
        return await call_next(request)
