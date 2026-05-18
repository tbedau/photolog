"""Authentication primitives.

Password hashing uses pwdlib's Argon2id as the primary scheme with a Bcrypt
verifier kept around so accounts that were created under the old passlib+bcrypt
pipeline keep working — `verify_and_update` returns a fresh Argon2id hash on
successful verify, which we persist on next login. Argon2id parameters use
pwdlib's library defaults, which track OWASP 2024 guidance (m=64MiB, t=3, p=4).

JWT verification enforces required claims so a malformed/forged token can't
slip through with missing fields. Tokens are short-lived (30 min) and the
cookie is HttpOnly + SameSite=Strict + Secure in production, with the
`__Host-` prefix forcing path=/ and no Domain attribute. Logout deletes the
cookie client-side; the JWT remains technically valid until exp, which is the
known tradeoff of stateless tokens — acceptable for one admin user with
30-minute lifetimes.
"""

from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from fastapi import HTTPException, status, Depends, Request
from pwdlib import PasswordHash
from pwdlib.hashers.argon2 import Argon2Hasher
from pwdlib.hashers.bcrypt import BcryptHasher
from pydantic import BaseModel
from jwt.exceptions import InvalidTokenError
from sqlmodel import Session, select

from .config import get_settings
from .database import get_session
from .models import User as UserModel

settings = get_settings()

# Argon2 first, Bcrypt only for verifying legacy hashes. `verify_and_update`
# will return a freshly-Argon2'd hash whenever a legacy one verifies, which
# `authenticate_user` writes back to the row.
password_hash = PasswordHash((Argon2Hasher(), BcryptHasher()))

# A pre-computed argon2id hash used to keep timing constant for non-existent
# users — without it, `authenticate_user` would short-circuit and expose
# username enumeration via response-time differences.
_DUMMY_HASH = password_hash.hash("timing-equalizer-not-a-real-password")


class User(BaseModel):
    username: str


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return password_hash.verify(plain_password, hashed_password)


def hash_password(password: str) -> str:
    return password_hash.hash(password)


def authenticate_user(
    username: str, password: str, session: Session
) -> Optional[UserModel]:
    """Verify credentials and silently migrate legacy bcrypt hashes to argon2id.

    Returns the user on success, None otherwise. Always performs one hash
    verification — including against a dummy hash when the user doesn't exist —
    so the response time can't be used to enumerate accounts.
    """
    user = session.exec(select(UserModel).where(UserModel.username == username)).first()

    if user is None:
        # Keep timing roughly equal to the success path.
        password_hash.verify(password, _DUMMY_HASH)
        return None

    valid, new_hash = password_hash.verify_and_update(password, user.hashed_password)
    if not valid:
        return None

    if new_hash is not None:
        # Legacy bcrypt verified — re-hash with argon2id and persist.
        user.hashed_password = new_hash
        session.add(user)
        session.commit()
        session.refresh(user)

    return user


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Issue a JWT with iat/exp claims. `data` must include `sub`."""
    now = datetime.now(timezone.utc)
    expire = now + (expires_delta or timedelta(minutes=15))
    to_encode = {**data, "iat": now, "exp": expire}
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


async def get_current_user(
    request: Request, session: Session = Depends(get_session)
) -> UserModel:
    """Resolve the user from the auth cookie. 401 on any failure mode."""
    token = request.cookies.get(settings.cookie_name)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )

    try:
        payload = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM],
            options={"require": ["exp", "iat", "sub"]},
        )
        username: str = payload["sub"]
    except (InvalidTokenError, KeyError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token"
        )

    user = session.exec(select(UserModel).where(UserModel.username == username)).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found"
        )

    return user
