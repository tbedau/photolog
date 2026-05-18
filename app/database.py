from sqlmodel import SQLModel, create_engine, Session
from sqlalchemy import text
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
    Initializes the database by creating all tables defined in SQLModel models,
    then adds any columns that are present on the model but missing from the
    existing table (forward-compatible ALTER for the new image metadata columns).
    """
    SQLModel.metadata.create_all(engine)

    new_columns = {
        "width": "INTEGER",
        "height": "INTEGER",
        "dominant_color": "VARCHAR(7)",
    }
    with engine.begin() as conn:
        existing = {
            row[1] for row in conn.execute(text("PRAGMA table_info(image)"))
        }
        for name, sql_type in new_columns.items():
            if name not in existing:
                conn.execute(text(f"ALTER TABLE image ADD COLUMN {name} {sql_type}"))
