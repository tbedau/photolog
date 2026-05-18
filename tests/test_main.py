import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.mark.anyio
async def test_root():
    # base_url=http://testserver matches Starlette's default and is on the
    # TrustedHostMiddleware allowlist.
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as ac:
        response = await ac.get("/")
    assert response.status_code == 200
