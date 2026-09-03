"""
Mateen VapeLounge - Configuration
Loads environment variables and exposes typed config values.
"""

import os
from datetime import timedelta
from dotenv import load_dotenv

load_dotenv()


class Config:
    # ----- Flask -----
    SECRET_KEY = os.getenv("SECRET_KEY", "change-me-in-production-please-immediately")
    DEBUG = os.getenv("FLASK_DEBUG", "False").lower() == "true"
    HOST = os.getenv("HOST", "0.0.0.0")
    PORT = int(os.getenv("PORT", "5000"))

    # ----- JWT -----
    JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", SECRET_KEY)
    JWT_ALGORITHM = "HS256"
    JWT_EXPIRY_HOURS = int(os.getenv("JWT_EXPIRY_HOURS", "24"))
    JWT_EXPIRY = timedelta(hours=JWT_EXPIRY_HOURS)

    # ----- MySQL -----
    DB_HOST = os.getenv("DB_HOST", "localhost")
    DB_PORT = int(os.getenv("DB_PORT", "3306"))
    DB_USER = os.getenv("DB_USER", "root")
    DB_PASSWORD = os.getenv("DB_PASSWORD", "")
    DB_NAME = os.getenv("DB_NAME", "mateen_vapelounge")

    # ----- Owner seed -----
    OWNER_NAME = os.getenv("OWNER_NAME", "Owner")
    OWNER_EMAIL = os.getenv("OWNER_EMAIL", "owner@yourdomain.com")
    OWNER_PASSWORD = os.getenv("OWNER_PASSWORD", "ChangeThisPassword")
    LEGACY_OWNER_EMAIL = "legacy@yourdomain.com"

    # ----- Frontend -----
    FRONTEND_DIR = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "frontend")
    )

    @classmethod
    def db_kwargs(cls):
        return {
            "host": cls.DB_HOST,
            "port": cls.DB_PORT,
            "user": cls.DB_USER,
            "password": cls.DB_PASSWORD,
            "database": cls.DB_NAME,
            "charset": "utf8mb4",
            "use_unicode": True,
            "autocommit": False,
        }
