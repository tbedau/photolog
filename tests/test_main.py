import io
from datetime import datetime, timedelta

import pytest
import pytz
from PIL import Image as PILImage
from httpx import ASGITransport, AsyncClient
from sqlmodel import Session, SQLModel, create_engine

from app import image_processing
from app.config import get_settings
from app.image_processing import iter_process_image_bytes, process_image_bytes
from app.main import app
from app.models import Image as ImageRow
from app.routers.images import _daily_cap_error


@pytest.fixture
def jpeg_bytes() -> bytes:
    """A 1200×800 JPEG — large enough to exercise multiple ladder tiers but
    small enough that libaom encodes it in well under a second."""
    img = PILImage.new("RGB", (1200, 800), color=(50, 100, 200))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


@pytest.fixture
def small_jpeg_bytes() -> bytes:
    """A 500×333 JPEG that truncates both width ladders to two AVIF tiers and
    one JPEG tier — the legacy-upload case the pipeline has to handle."""
    img = PILImage.new("RGB", (500, 333), color=(10, 10, 10))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


@pytest.fixture
def tmp_uploads(tmp_path, monkeypatch):
    """Redirect the pipeline's UPLOAD_FOLDER at a per-test tmp dir so tests
    can't leak derivatives into the real uploads tree."""
    monkeypatch.setattr(image_processing.settings, "UPLOAD_FOLDER", tmp_path)
    return tmp_path


@pytest.mark.anyio
async def test_root():
    # base_url=http://testserver matches Starlette's default and is on the
    # TrustedHostMiddleware allowlist.
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as ac:
        response = await ac.get("/")
    assert response.status_code == 200


def test_iter_pipeline_happy_path(jpeg_bytes, tmp_uploads):
    events = list(iter_process_image_bytes(jpeg_bytes, content_type="image/jpeg"))

    assert events[-1]["phase"] == "complete"
    complete = events[-1]
    assert complete["width"] == 1200
    assert complete["height"] == 800
    assert complete["dominant_color"].startswith("#")
    assert len(complete["storage_id"]) == 32

    decode_done = next(
        e for e in events if e["phase"] == "decode" and e.get("status") == "done"
    )
    # 1200px source caps the 1280/1920/3200 tiers down to one 1200 entry.
    assert decode_done["avif_widths"] == [320, 640, 1200]
    assert decode_done["jpeg_widths"] == [1200]

    # Every declared output width has an active→done pair, in that order.
    for w in decode_done["avif_widths"]:
        avif = [
            e for e in events if e["phase"] == "avif" and e.get("width") == w
        ]
        assert [e["status"] for e in avif] == ["active", "done"], (
            f"AVIF width {w}: {avif}"
        )
    for w in decode_done["jpeg_widths"]:
        jpeg = [
            e for e in events if e["phase"] == "jpeg" and e.get("width") == w
        ]
        assert [e["status"] for e in jpeg] == ["active", "done"], (
            f"JPEG width {w}: {jpeg}"
        )

    # And every declared output file actually exists on disk.
    storage_dir = tmp_uploads / complete["storage_id"]
    assert (storage_dir / "original.jpg").exists()
    for w in decode_done["avif_widths"]:
        assert (storage_dir / f"{w}.avif").exists()
    for w in decode_done["jpeg_widths"]:
        assert (storage_dir / f"{w}.jpg").exists()


def test_iter_pipeline_truncates_ladder_for_small_source(
    small_jpeg_bytes, tmp_uploads
):
    events = list(
        iter_process_image_bytes(small_jpeg_bytes, content_type="image/jpeg")
    )
    decode_done = next(
        e for e in events if e["phase"] == "decode" and e.get("status") == "done"
    )
    assert decode_done["avif_widths"] == [320, 500]
    assert decode_done["jpeg_widths"] == [500]
    assert events[-1]["phase"] == "complete"


def test_iter_pipeline_rejects_unsupported_content_type(jpeg_bytes, tmp_uploads):
    events = list(
        iter_process_image_bytes(jpeg_bytes, content_type="application/pdf")
    )
    assert len(events) == 1
    assert events[0]["phase"] == "error"
    assert events[0]["status_code"] == 400


def test_iter_pipeline_rejects_corrupt_bytes(tmp_uploads):
    events = list(
        iter_process_image_bytes(
            b"\x00not actually an image\xff", content_type="image/jpeg"
        )
    )
    # Decode starts, then errors before any encoder phase runs.
    assert events[0] == {"phase": "decode", "status": "active"}
    assert events[-1]["phase"] == "error"
    assert events[-1]["status_code"] == 400
    # And no leftover directories on disk (rolled back before completion).
    assert list(tmp_uploads.iterdir()) == []


def test_iter_pipeline_rolls_back_on_encoder_failure(
    jpeg_bytes, tmp_uploads, monkeypatch
):
    """If an encoder raises mid-pipeline, the partially-written derivative
    directory must be torn down so the /i serving route never 200s with a
    missing tier."""
    call_count = {"n": 0}

    real_save_avif = image_processing._save_avif

    def flaky_save_avif(img, path):
        call_count["n"] += 1
        if call_count["n"] >= 2:
            raise RuntimeError("simulated encoder crash")
        return real_save_avif(img, path)

    monkeypatch.setattr(image_processing, "_save_avif", flaky_save_avif)

    events = list(iter_process_image_bytes(jpeg_bytes, content_type="image/jpeg"))
    assert events[-1]["phase"] == "error"
    assert events[-1]["status_code"] == 500
    # No storage directories should remain.
    assert list(tmp_uploads.iterdir()) == []


def test_process_image_bytes_wrapper_raises_on_error(jpeg_bytes, tmp_uploads):
    """The CLI/migration path uses the synchronous wrapper, which must turn
    error events back into HTTPException for backwards compatibility."""
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc_info:
        process_image_bytes(jpeg_bytes, content_type="application/pdf")
    assert exc_info.value.status_code == 400


def test_process_image_bytes_wrapper_returns_processed_image(
    jpeg_bytes, tmp_uploads
):
    result = process_image_bytes(jpeg_bytes, content_type="image/jpeg")
    assert result.width == 1200
    assert result.height == 800
    assert result.dominant_color.startswith("#")


@pytest.fixture
def isolated_db_session():
    """Per-test in-memory SQLite so cap-helper assertions can't see the real
    `data/photolog_data.db`."""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as sess:
        yield sess


def _insert_image_row(sess: Session, user_id: int, upload_date: datetime) -> None:
    sess.add(
        ImageRow(
            filename="x" * 32,
            original_filename="test.jpg",
            user_id=user_id,
            upload_date=upload_date,
        )
    )
    sess.commit()


def test_daily_cap_error_enforces_cap_per_user_per_day(isolated_db_session):
    """Cap is now checked in two places (precheck + POST). They share
    `_daily_cap_error`, so as long as this helper holds, they cannot drift
    apart. The test walks the boundaries that make wrong answers possible:
    different user, yesterday vs. today, and the cap-tripping count."""
    now = datetime.now(pytz.timezone(get_settings().TIMEZONE))

    # Empty DB: anyone is under the cap.
    assert _daily_cap_error(isolated_db_session, user_id=1) is None

    # Another user's uploads don't count toward us.
    _insert_image_row(isolated_db_session, user_id=99, upload_date=now)
    assert _daily_cap_error(isolated_db_session, user_id=1) is None

    # Our own uploads from yesterday don't count toward today's cap.
    _insert_image_row(
        isolated_db_session, user_id=1, upload_date=now - timedelta(days=1)
    )
    assert _daily_cap_error(isolated_db_session, user_id=1) is None

    # A today row trips the cap (default MAX_UPLOADS_PER_DAY=1).
    _insert_image_row(isolated_db_session, user_id=1, upload_date=now)
    err = _daily_cap_error(isolated_db_session, user_id=1)
    assert err is not None
    assert "daily upload limit" in err
