import secrets

from fastapi import Request
from fastapi.responses import RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware

from .config import get_settings

_settings = get_settings()


# 2 years; clients that have seen this once won't downgrade in that window.
_HSTS = "max-age=63072000; includeSubDomains"


def _csp(nonce: str) -> str:
    # No 'unsafe-inline' anywhere on scripts: each inline `<script>` must carry
    # the request's nonce. `style-src-attr 'unsafe-inline'` is the narrow
    # exception that keeps per-image dominant-colour `style="--dom:#…"` working
    # without re-enabling inline `<style>` blocks.
    return (
        "default-src 'self'; "
        f"script-src 'self' 'nonce-{nonce}'; "
        "style-src 'self'; "
        "style-src-attr 'unsafe-inline'; "
        "img-src 'self' data:; "
        "font-src 'self'; "
        "connect-src 'self'; "
        "frame-ancestors 'none'; "
        "form-action 'self'; "
        "base-uri 'none'; "
        "object-src 'none'"
    )


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Generate a per-request CSP nonce and apply security headers."""

    async def dispatch(self, request: Request, call_next):
        # Set the nonce *before* the handler runs so templates can read it.
        nonce = secrets.token_urlsafe(16)
        request.state.csp_nonce = nonce

        skip = request.url.path in {"/docs", "/redoc", "/openapi.json"}

        response = await call_next(request)
        if skip:
            return response

        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
        response.headers["Permissions-Policy"] = (
            "accelerometer=(), camera=(), geolocation=(), gyroscope=(), "
            "magnetometer=(), microphone=(), payment=(), usb=()"
        )
        response.headers["Content-Security-Policy"] = _csp(nonce)

        # HSTS is meaningless over HTTP, and browsers ignore it anyway.
        if _settings.cookie_secure:
            response.headers["Strict-Transport-Security"] = _HSTS

        return response


class AuthRedirectMiddleware(BaseHTTPMiddleware):
    """When a browser hits a 401, send them to /login instead of a JSON error."""

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)

        if response.status_code == 401 and "text/html" in request.headers.get(
            "accept", ""
        ):
            return RedirectResponse(url="/login")

        return response
