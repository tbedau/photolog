from datetime import datetime
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

    Attributes:
        id (int): The primary key for the image.
        filename (str): Internal filename of the stored image.
        original_filename (str): Original filename of the uploaded image.
        upload_date (datetime): Timestamp of when the image was uploaded.
        user_id (int): Foreign key referencing the user who uploaded the image.
    """

    id: Optional[int] = Field(default=None, primary_key=True)
    filename: str = Field(nullable=False)
    original_filename: str = Field(nullable=False)
    upload_date: datetime = Field(default_factory=datetime.utcnow)
    user_id: int = Field(foreign_key="user.id", nullable=False)

    # Relationship to the User model
    user: "User" = Relationship(back_populates="images")
