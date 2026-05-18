# Base image
FROM python:3.13-slim AS base

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONPATH="/app"

# Install uv
COPY --from=ghcr.io/astral-sh/uv:0.11.14 /uv /uvx /bin/

# Working directory
WORKDIR /app

# Install dependencies
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --frozen --no-install-project

# Copy application code
COPY . /app

# Perform final dependency synchronization
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync

# Command to run the application
CMD ["fastapi", "run", "--workers", "2", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*", "app/main.py"]
