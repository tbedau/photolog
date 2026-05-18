from datetime import datetime, timezone
from typing import Optional
from sqlmodel import SQLModel, Field, Relationship


class User(SQLModel, table=True):
    """
    Represents a user in the system.

    Attributes:
        id (int): The primary key for the user.
        username (str): Unique username for the user.
        hashed_password (str): Hashed password for secure authentication.
    """

    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(unique=True, index=True, nullable=False)
    hashed_password: str

    # Establish relationship with Image model
    images: list["Image"] = Relationship(back_populates="user")


class Image(SQLModel, table=True):
    """
    Represents an image uploaded by a user.

    `filename` is the UUID hex that names the per-image storage directory.
    Derivatives live at `uploads/{filename}/{spec}.{ext}` where spec is a width
    like "1280" or "original".

    `width`/`height` are the dimensions of the largest derivative (post EXIF
    orientation, post downscale). They drive the `<img>` aspect ratio and the
    `sizes`/`srcset` selection so the layout never shifts while loading.

    `dominant_color` is a #rrggbb hex string used as the `<img>` background so
    the page paints in the photo's tonal range before any pixel arrives.
    """

    id: Optional[int] = Field(default=None, primary_key=True)
    filename: str = Field(nullable=False)
    original_filename: str = Field(nullable=False)
    upload_date: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    user_id: int = Field(foreign_key="user.id", nullable=False)

    width: Optional[int] = Field(default=None)
    height: Optional[int] = Field(default=None)
    dominant_color: Optional[str] = Field(default=None, max_length=7)

    # Relationship to the User model
    user: "User" = Relationship(back_populates="images")
