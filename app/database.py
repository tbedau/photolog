from sqlmodel import SQLModel, create_engine, Session
from .config import get_settings

# Load settings and configure the database engine
settings = get_settings()
engine = create_engine(settings.DATABASE_URL)


def get_session():
    """
    Dependency that provides a database session.

    Yields:
        session (Session): A SQLModel session connected to the database.
    """
    with Session(engine) as session:
        yield session


def init_db():
    """
    Initializes the database by creating all tables defined in SQLModel models.

    This function should be called at application startup to ensure all tables
    are created in the database if they do not already exist.
    """
    SQLModel.metadata.create_all(engine)
