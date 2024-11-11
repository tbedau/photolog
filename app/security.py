from datetime import datetime, timedelta
from typing import Optional

import jwt
from fastapi import HTTPException, status, Depends, Request
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel
from passlib.context import CryptContext
from jwt.exceptions import InvalidTokenError
from sqlmodel import Session, select

from .config import get_settings
from .database import get_session
from .models import User as UserModel

# Load settings
settings = get_settings()

# Initialize password hashing context
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
# OAuth2 token authentication
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")


# User model for responses
class User(BaseModel):
    username: str


# Password hashing and verification
def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verifies a plain password against a hashed password."""
    return pwd_context.verify(plain_password, hashed_password)


def hash_password(password: str) -> str:
    """Hashes a password using bcrypt."""
    return pwd_context.hash(password)


def authenticate_user(
    username: str, password: str, session: Session
) -> Optional[UserModel]:
    """
    Authenticates a user by username and password.

    Args:
        username: The username of the user.
        password: The password of the user.
        session: Database session to execute the query.

    Returns:
        The authenticated User object if credentials are correct, otherwise None.
    """
    user = session.exec(select(UserModel).where(UserModel.username == username)).first()

    if not user or not verify_password(password, user.hashed_password):
        return None

    return user


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """
    Creates a JWT access token with an expiration date.

    Args:
        data: Data to encode in the token.
        expires_delta: Optional timedelta for token expiration.

    Returns:
        Encoded JWT token as a string.
    """
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=15))
    to_encode.update({"exp": expire})
    token = jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
    return token


async def get_current_user(
    request: Request, session: Session = Depends(get_session)
) -> UserModel:
    """
    Retrieves the current user based on a JWT token stored in cookies.

    Args:
        request: The incoming HTTP request.
        session: Database session dependency.

    Returns:
        The authenticated User object.

    Raises:
        HTTPException: If the user is not authenticated or token is invalid.
    """
    token = request.cookies.get(settings.COOKIE_NAME)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        username: str = payload.get("sub")

        if not username:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token"
            )

    except InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token"
        )

    user = session.exec(select(UserModel).where(UserModel.username == username)).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found"
        )

    return user
