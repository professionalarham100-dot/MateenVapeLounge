"""
Mateen VapeLounge - Flask Application
Inventory Management System backend.

Hierarchy: Category -> Brand -> Product
Two transaction types:
  - Sale   (product, reduces stock)
  - Refill (service, NO stock deduction, ml_amount * price_per_ml)

- Serves the frontend SPA from /frontend
- All API endpoints are prefixed with /api
- JWT auth on every protected route, role-based authorization
- Every state change is recorded to audit_log
"""

import os
import re
import jwt
import bcrypt
import logging
import mysql.connector
from mysql.connector import Error as MySQLError, pooling
from datetime import datetime, timezone, timedelta
from functools import wraps
from decimal import Decimal
from flask import (
    Flask, request, jsonify, send_from_directory, abort, g
)
from flask_cors import CORS

from config import Config

# ---------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("app")

# ---------------------------------------------------------------------
# Frontend directory (resolved from this file's absolute path)
# ---------------------------------------------------------------------
import pathlib

_here = pathlib.Path(__file__).parent.resolve()
for _candidate in [_here / 'frontend', _here.parent / 'frontend']:
    if _candidate.is_dir():
        FRONTEND_DIR = str(_candidate)
        break
else:
    FRONTEND_DIR = str(_here / 'frontend')

print(f"FRONTEND_DIR = {FRONTEND_DIR}", flush=True)

# ---------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------
app = Flask(
    __name__,
    static_folder=FRONTEND_DIR,
    static_url_path="",
)
app.config.from_object(Config)
CORS(app, supports_credentials=True)

# ---------------------------------------------------------------------
# MySQL connection pool
# ---------------------------------------------------------------------
_pool: pooling.MySQLConnectionPool | None = None


def init_pool():
    global _pool
    kwargs = Config.db_kwargs()
    _pool = pooling.MySQLConnectionPool(
        pool_name="mateen_pool",
        pool_size=8,
        pool_reset_session=True,
        **kwargs,
    )
    log.info("MySQL connection pool initialised (db=%s)", Config.DB_NAME)


def get_conn():
    if _pool is None:
        init_pool()
    return _pool.get_connection()


# ---------------------------------------------------------------------
# JSON helpers
# ---------------------------------------------------------------------
def jsonable(value):
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, dict):
        return {k: jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [jsonable(v) for v in value]
    return value


def ok(payload=None, status=200):
    return jsonify(jsonable(payload if payload is not None else {})), status


def err(message, status=400, **extra):
    body = {"error": message}
    body.update(extra)
    return jsonify(body), status


# ---------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------
def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def issue_token(user: dict) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user["id"],
        "email": user["email"],
        "role": user["role"],
        "name": user["name"],
        "iat": int(now.timestamp()),
        "exp": int((now + Config.JWT_EXPIRY).timestamp()),
    }
    return jwt.encode(payload, Config.JWT_SECRET_KEY, algorithm=Config.JWT_ALGORITHM)


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, Config.JWT_SECRET_KEY, algorithms=[Config.JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


def get_bearer_token() -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


def login_required(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        token = get_bearer_token()
        if not token:
            return err("Authentication required", 401)
        claims = decode_token(token)
        if not claims:
            return err("Invalid or expired session", 401)

        conn = get_conn()
        try:
            cur = conn.cursor(dictionary=True)
            cur.execute(
                "SELECT id, name, email, role, is_active FROM users WHERE id=%s",
                (claims["sub"],),
            )
            user = cur.fetchone()
            cur.close()
        finally:
            conn.close()

        if not user or not user["is_active"]:
            return err("Account is inactive", 401)

        g.user = user
        return fn(*a, **kw)

    return wrapper


def owner_required(fn):
    @wraps(fn)
    @login_required
    def wrapper(*a, **kw):
        if g.user["role"] != "owner":
            return err("Owner access required", 403)
        return fn(*a, **kw)

    return wrapper


# ---------------------------------------------------------------------
# Audit logging
# ---------------------------------------------------------------------
def write_audit(conn, user, action: str, details: str = ""):
    cur = conn.cursor()
    cur.execute(
        """INSERT INTO audit_log (user_id, user_name, role, action, details, ip_address)
           VALUES (%s, %s, %s, %s, %s, %s)""",
        (
            user.get("id") if user else None,
            user.get("name", "Unknown") if user else "Unknown",
            user.get("role", "unknown") if user else "unknown",
            action[:100],
            (details or "")[:5000],
            (request.remote_addr or "")[:45],
        ),
    )
    cur.close()


def audit(user, action: str, details: str = ""):
    conn = get_conn()
    try:
        write_audit(conn, user, action, details)
        conn.commit()
    except MySQLError as e:
        conn.rollback()
        log.exception("Audit write failed: %s", e)
    finally:
        conn.close()


# ---------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def require_fields(payload: dict, fields: list[str]):
    missing = [f for f in fields if f not in payload or payload[f] in (None, "")]
    if missing:
        return f"Missing required field(s): {', '.join(missing)}"
    return None


def to_decimal(val, field, allow_none=False):
    if val in (None, "") and allow_none:
        return None
    try:
        d = Decimal(str(val))
        if d < 0:
            raise ValueError()
        return d
    except Exception:
        raise ValueError(f"{field} must be a non-negative number")


def to_int(val, field, minimum=0):
    try:
        n = int(val)
    except Exception:
        raise ValueError(f"{field} must be an integer")
    if n < minimum:
        raise ValueError(f"{field} must be >= {minimum}")
    return n


def to_bool(val):
    if isinstance(val, bool):
        return val
    if val is None:
        return False
    s = str(val).strip().lower()
    return s in ("1", "true", "yes", "on")


# ---------------------------------------------------------------------
# Bootstrap — seed owner account
# ---------------------------------------------------------------------
def ensure_schema_and_owner():
    """Ensure the canonical owner account exists.
       Removes any leftover legacy owner account if still present,
       reassigning its purchase / sale / refill history to the new owner
       so foreign-key constraints stay satisfied.
       Idempotent — safe to run on every boot."""
    conn = get_conn()
    try:
        # 0. Create all tables if they don't exist (Railway / fresh DB)
        ddl = conn.cursor()
        ddl.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INT PRIMARY KEY AUTO_INCREMENT,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(100) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            role ENUM('owner','staff') NOT NULL,
            is_active BOOLEAN DEFAULT TRUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        """)
        ddl.execute("""
        CREATE TABLE IF NOT EXISTS categories (
            id INT PRIMARY KEY AUTO_INCREMENT,
            name VARCHAR(100) NOT NULL,
            description VARCHAR(255),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        """)
        ddl.execute("""
        CREATE TABLE IF NOT EXISTS brands (
            id INT PRIMARY KEY AUTO_INCREMENT,
            category_id INT NOT NULL,
            name VARCHAR(100) NOT NULL,
            description VARCHAR(255),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
        )
        """)
        ddl.execute("""
        CREATE TABLE IF NOT EXISTS products (
            id INT PRIMARY KEY AUTO_INCREMENT,
            brand_id INT NOT NULL,
            name VARCHAR(150) NOT NULL,
            description VARCHAR(255),
            cost_price DECIMAL(10,2) NOT NULL DEFAULT 0,
            selling_price DECIMAL(10,2) NOT NULL DEFAULT 0,
            price_per_ml DECIMAL(10,2) DEFAULT NULL,
            stock_quantity INT NOT NULL DEFAULT 0,
            low_stock_threshold INT NOT NULL DEFAULT 5,
            is_refillable BOOLEAN DEFAULT FALSE,
            is_active BOOLEAN DEFAULT TRUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
        )
        """)
        ddl.execute("""
        CREATE TABLE IF NOT EXISTS refill_sizes (
            id INT PRIMARY KEY AUTO_INCREMENT,
            label VARCHAR(50) NOT NULL,
            ml_amount DECIMAL(5,2) NOT NULL,
            is_active BOOLEAN DEFAULT TRUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        """)
        ddl.execute("""
        CREATE TABLE IF NOT EXISTS sales (
            id INT PRIMARY KEY AUTO_INCREMENT,
            product_id INT NOT NULL,
            staff_id INT NOT NULL,
            quantity_sold INT NOT NULL DEFAULT 1,
            selling_price_at_time DECIMAL(10,2) NOT NULL,
            total_amount DECIMAL(10,2) NOT NULL,
            sold_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES products(id),
            FOREIGN KEY (staff_id) REFERENCES users(id)
        )
        """)
        ddl.execute("""
        CREATE TABLE IF NOT EXISTS refills (
            id INT PRIMARY KEY AUTO_INCREMENT,
            product_id INT NOT NULL,
            staff_id INT NOT NULL,
            refill_size_id INT NOT NULL,
            ml_amount DECIMAL(5,2) NOT NULL,
            price_per_ml_at_time DECIMAL(10,2) NOT NULL,
            total_amount DECIMAL(10,2) NOT NULL,
            done_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES products(id),
            FOREIGN KEY (staff_id) REFERENCES users(id),
            FOREIGN KEY (refill_size_id) REFERENCES refill_sizes(id)
        )
        """)
        ddl.execute("""
        CREATE TABLE IF NOT EXISTS purchases (
            id INT PRIMARY KEY AUTO_INCREMENT,
            product_id INT NOT NULL,
            owner_id INT NOT NULL,
            quantity_added INT NOT NULL,
            cost_price_at_time DECIMAL(10,2) NOT NULL,
            total_cost DECIMAL(10,2) NOT NULL,
            supplier_name VARCHAR(100),
            purchased_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES products(id),
            FOREIGN KEY (owner_id) REFERENCES users(id)
        )
        """)
        ddl.execute("""
        CREATE TABLE IF NOT EXISTS audit_log (
            id INT PRIMARY KEY AUTO_INCREMENT,
            user_id INT,
            user_name VARCHAR(100) NOT NULL,
            role VARCHAR(20) NOT NULL,
            action VARCHAR(100) NOT NULL,
            details TEXT,
            ip_address VARCHAR(45),
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        """)
        ddl.close()
        conn.commit()
        log.info("Schema verified / created (CREATE TABLE IF NOT EXISTS)")

        # Seed default refill sizes if the table is empty
        seed_cur = conn.cursor(dictionary=True)
        seed_cur.execute("SELECT id FROM refill_sizes LIMIT 1")
        existing_size = seed_cur.fetchone()
        seed_cur.close()
        if not existing_size:
            ins = conn.cursor()
            ins.execute(
                "INSERT INTO refill_sizes (label, ml_amount) VALUES "
                "('1ml', 1.0), ('2ml', 2.0), ('3ml', 3.0), ('5ml', 5.0), ('Full Bottle', 30.0)"
            )
            ins.close()
            conn.commit()
            log.info("Seeded 5 default refill sizes")

        cur = conn.cursor(dictionary=True)

        # 1. Ensure the new owner exists
        cur.execute(
            "SELECT id FROM users WHERE email=%s LIMIT 1", (Config.OWNER_EMAIL,)
        )
        new_owner = cur.fetchone()
        if new_owner:
            new_id = new_owner["id"]
            log.info("Owner account already exists: %s (id=%s)",
                     Config.OWNER_EMAIL, new_id)
        else:
            pw = hash_password(Config.OWNER_PASSWORD)
            cur2 = conn.cursor()
            cur2.execute(
                """INSERT INTO users (name, email, password_hash, role, is_active)
                   VALUES (%s, %s, %s, 'owner', TRUE)""",
                (Config.OWNER_NAME, Config.OWNER_EMAIL, pw),
            )
            new_id = cur2.lastrowid
            cur2.close()
            log.info("Owner account seeded: %s (id=%s)",
                     Config.OWNER_EMAIL, new_id)

        # 2. Remove the legacy owner if present and not the same row
        legacy_email = getattr(Config, "LEGACY_OWNER_EMAIL", "owner@yourdomain.com")
        if legacy_email and legacy_email.lower() != Config.OWNER_EMAIL.lower():
            cur.execute(
                "SELECT id FROM users WHERE email=%s LIMIT 1", (legacy_email,)
            )
            old = cur.fetchone()
            if old:
                old_id = old["id"]
                cur2 = conn.cursor()
                cur2.execute(
                    "UPDATE purchases SET owner_id=%s WHERE owner_id=%s",
                    (new_id, old_id),
                )
                purchases_moved = cur2.rowcount
                cur2.execute(
                    "UPDATE sales SET staff_id=%s WHERE staff_id=%s",
                    (new_id, old_id),
                )
                sales_moved = cur2.rowcount
                cur2.execute(
                    "UPDATE refills SET staff_id=%s WHERE staff_id=%s",
                    (new_id, old_id),
                )
                refills_moved = cur2.rowcount
                cur2.execute("DELETE FROM users WHERE id=%s", (old_id,))
                cur2.close()
                log.info(
                    "Removed legacy owner %s (id=%s); reassigned %d purchases, "
                    "%d sales, %d refills to new owner (id=%s).",
                    legacy_email, old_id, purchases_moved, sales_moved,
                    refills_moved, new_id,
                )

        conn.commit()
        cur.close()
    except MySQLError as e:
        conn.rollback()
        log.exception("Bootstrap failed: %s", e)
    finally:
        conn.close()


# =====================================================================
# AUTH ROUTES
# =====================================================================
@app.post("/api/auth/login")
def auth_login():
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""

    if not email or not password:
        return err("Email and password are required", 400)

    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(
            """SELECT id, name, email, password_hash, role, is_active
               FROM users WHERE email=%s LIMIT 1""",
            (email,),
        )
        user = cur.fetchone()
        cur.close()

        if not user or not user["is_active"] or not verify_password(password, user["password_hash"]):
            write_audit(
                conn,
                {"id": user["id"] if user else None,
                 "name": user["name"] if user else email,
                 "role": user["role"] if user else "unknown"},
                "LOGIN_FAILED",
                f"Failed login attempt for {email}",
            )
            conn.commit()
            return err("Invalid email or password", 401)

        token = issue_token(user)
        write_audit(conn, user, "LOGIN_SUCCESS", f"{user['email']} logged in")
        conn.commit()

        return ok({
            "token": token,
            "user": {
                "id": user["id"],
                "name": user["name"],
                "email": user["email"],
                "role": user["role"],
            },
            "expires_in_hours": Config.JWT_EXPIRY_HOURS,
        })
    except MySQLError as e:
        conn.rollback()
        log.exception("Login error: %s", e)
        return err("Internal server error", 500)
    finally:
        conn.close()


@app.post("/api/auth/logout")
@login_required
def auth_logout():
    audit(g.user, "LOGOUT", f"{g.user['email']} logged out")
    return ok({"message": "Signed out"})


@app.get("/api/auth/me")
@login_required
def auth_me():
    u = g.user
    return ok({
        "id": u["id"],
        "name": u["name"],
        "email": u["email"],
        "role": u["role"],
    })


# =====================================================================
# CATEGORIES
# =====================================================================
@app.get("/api/categories")
@login_required
def list_categories():
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(
            """SELECT c.id, c.name, c.description, c.created_at,
                      COALESCE(b.brand_count, 0) AS brand_count,
                      COALESCE(p.product_count, 0) AS product_count
               FROM categories c
               LEFT JOIN (
                   SELECT category_id, COUNT(*) AS brand_count
                   FROM brands GROUP BY category_id
               ) b ON b.category_id = c.id
               LEFT JOIN (
                   SELECT br.category_id, COUNT(*) AS product_count
                   FROM products p
                   JOIN brands br ON br.id = p.brand_id
                   WHERE p.is_active = TRUE
                   GROUP BY br.category_id
               ) p ON p.category_id = c.id
               ORDER BY c.name ASC"""
        )
        rows = cur.fetchall()
        cur.close()
        return ok({"categories": rows})
    finally:
        conn.close()


@app.post("/api/categories")
@owner_required
def create_category():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    description = (body.get("description") or "").strip() or None
    if not name:
        return err("Category name is required", 400)
    if len(name) > 100:
        return err("Category name is too long", 400)

    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO categories (name, description) VALUES (%s, %s)",
            (name, description),
        )
        new_id = cur.lastrowid
        cur.close()
        write_audit(conn, g.user, "CATEGORY_CREATE",
                    f"Created category '{name}' (id={new_id})")
        conn.commit()
        return ok({"id": new_id, "message": "Category created"}, 201)
    except MySQLError as e:
        conn.rollback()
        log.exception("Create category failed: %s", e)
        return err("Failed to create category", 500)
    finally:
        conn.close()


@app.put("/api/categories/<int:cid>")
@owner_required
def update_category(cid: int):
    body = request.get_json(silent=True) or {}
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT id, name, description FROM categories WHERE id=%s", (cid,))
        existing = cur.fetchone()
        cur.close()
        if not existing:
            return err("Category not found", 404)

        updates = {}
        if "name" in body:
            n = (body["name"] or "").strip()
            if not n:
                return err("Category name cannot be empty", 400)
            if len(n) > 100:
                return err("Category name is too long", 400)
            updates["name"] = n
        if "description" in body:
            d = (body["description"] or "").strip()
            updates["description"] = d if d else None
        if not updates:
            return err("No fields to update", 400)

        sets = ", ".join(f"{k}=%s" for k in updates)
        params = list(updates.values()) + [cid]
        cur = conn.cursor()
        cur.execute(f"UPDATE categories SET {sets} WHERE id=%s", params)
        cur.close()
        diff = ", ".join(f"{k}: {existing.get(k)} -> {updates[k]}" for k in updates)
        write_audit(conn, g.user, "CATEGORY_UPDATE",
                    f"Updated category '{existing['name']}' (id={cid}) [{diff}]")
        conn.commit()
        return ok({"message": "Category updated"})
    except MySQLError as e:
        conn.rollback()
        log.exception("Update category failed: %s", e)
        return err("Failed to update category", 500)
    finally:
        conn.close()


@app.delete("/api/categories/<int:cid>")
@owner_required
def delete_category(cid: int):
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT id, name FROM categories WHERE id=%s", (cid,))
        cat = cur.fetchone()
        cur.close()
        if not cat:
            return err("Category not found", 404)

        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT COUNT(*) AS cnt FROM brands WHERE category_id=%s", (cid,))
        if cur.fetchone()["cnt"] > 0:
            cur.close()
            return err(
                "Cannot delete: this category still has brands. Remove or move them first.",
                409,
            )
        cur.close()

        cur = conn.cursor()
        cur.execute("DELETE FROM categories WHERE id=%s", (cid,))
        cur.close()
        write_audit(conn, g.user, "CATEGORY_DELETE",
                    f"Deleted category '{cat['name']}' (id={cid})")
        conn.commit()
        return ok({"message": "Category deleted"})
    except MySQLError as e:
        conn.rollback()
        log.exception("Delete category failed: %s", e)
        return err("Failed to delete category", 500)
    finally:
        conn.close()


# =====================================================================
# BRANDS
# =====================================================================
@app.get("/api/brands")
@login_required
def list_brands():
    category_id = request.args.get("category_id")
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        if category_id:
            try:
                cid = int(category_id)
            except ValueError:
                return err("Invalid category_id", 400)
            cur.execute(
                """SELECT b.id, b.category_id, c.name AS category_name,
                          b.name, b.description, b.created_at,
                          COALESCE(p.product_count, 0) AS product_count
                   FROM brands b
                   JOIN categories c ON c.id = b.category_id
                   LEFT JOIN (
                       SELECT brand_id, COUNT(*) AS product_count
                       FROM products WHERE is_active=TRUE GROUP BY brand_id
                   ) p ON p.brand_id = b.id
                   WHERE b.category_id=%s
                   ORDER BY b.name ASC""",
                (cid,),
            )
        else:
            cur.execute(
                """SELECT b.id, b.category_id, c.name AS category_name,
                          b.name, b.description, b.created_at,
                          COALESCE(p.product_count, 0) AS product_count
                   FROM brands b
                   JOIN categories c ON c.id = b.category_id
                   LEFT JOIN (
                       SELECT brand_id, COUNT(*) AS product_count
                       FROM products WHERE is_active=TRUE GROUP BY brand_id
                   ) p ON p.brand_id = b.id
                   ORDER BY c.name ASC, b.name ASC"""
            )
        rows = cur.fetchall()
        cur.close()
        return ok({"brands": rows})
    finally:
        conn.close()


@app.get("/api/brands/<int:bid>")
@login_required
def get_brand(bid: int):
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(
            """SELECT b.id, b.category_id, c.name AS category_name,
                      b.name, b.description, b.created_at
               FROM brands b
               JOIN categories c ON c.id = b.category_id
               WHERE b.id=%s""",
            (bid,),
        )
        brand = cur.fetchone()
        if not brand:
            cur.close()
            return err("Brand not found", 404)

        cur.execute(
            """SELECT id, name, description, cost_price, selling_price, price_per_ml,
                      stock_quantity, low_stock_threshold, is_refillable, is_active,
                      (stock_quantity <= low_stock_threshold) AS low_stock
               FROM products WHERE brand_id=%s AND is_active=TRUE
               ORDER BY name ASC""",
            (bid,),
        )
        products = cur.fetchall()
        cur.close()
        for p in products:
            p["low_stock"] = bool(p["low_stock"])
            p["is_refillable"] = bool(p["is_refillable"])

        # Strip prices for staff
        if g.user["role"] != "owner":
            for p in products:
                p.pop("cost_price", None)
                p.pop("selling_price", None)
                # price_per_ml is needed by staff for the refill calc — keep it.

        brand["products"] = products
        return ok({"brand": brand})
    finally:
        conn.close()


@app.post("/api/brands")
@owner_required
def create_brand():
    body = request.get_json(silent=True) or {}
    miss = require_fields(body, ["category_id", "name"])
    if miss:
        return err(miss, 400)

    try:
        cid = int(body["category_id"])
    except (ValueError, TypeError):
        return err("Invalid category_id", 400)
    name = (body.get("name") or "").strip()
    description = (body.get("description") or "").strip() or None
    if not name:
        return err("Brand name is required", 400)
    if len(name) > 100:
        return err("Brand name is too long", 400)

    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT id, name FROM categories WHERE id=%s", (cid,))
        cat = cur.fetchone()
        cur.close()
        if not cat:
            return err("Category not found", 404)

        cur = conn.cursor()
        cur.execute(
            "INSERT INTO brands (category_id, name, description) VALUES (%s, %s, %s)",
            (cid, name, description),
        )
        new_id = cur.lastrowid
        cur.close()
        write_audit(conn, g.user, "BRAND_CREATE",
                    f"Created brand '{name}' under '{cat['name']}' (id={new_id})")
        conn.commit()
        return ok({"id": new_id, "message": "Brand created"}, 201)
    except MySQLError as e:
        conn.rollback()
        log.exception("Create brand failed: %s", e)
        return err("Failed to create brand", 500)
    finally:
        conn.close()


@app.put("/api/brands/<int:bid>")
@owner_required
def update_brand(bid: int):
    body = request.get_json(silent=True) or {}
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT * FROM brands WHERE id=%s", (bid,))
        existing = cur.fetchone()
        cur.close()
        if not existing:
            return err("Brand not found", 404)

        updates = {}
        if "name" in body:
            n = (body["name"] or "").strip()
            if not n:
                return err("Brand name cannot be empty", 400)
            updates["name"] = n
        if "description" in body:
            d = (body["description"] or "").strip()
            updates["description"] = d if d else None
        if "category_id" in body:
            try:
                cid = int(body["category_id"])
            except (ValueError, TypeError):
                return err("Invalid category_id", 400)
            cur = conn.cursor()
            cur.execute("SELECT id FROM categories WHERE id=%s", (cid,))
            ok_cat = cur.fetchone()
            cur.close()
            if not ok_cat:
                return err("Target category not found", 404)
            updates["category_id"] = cid

        if not updates:
            return err("No fields to update", 400)

        sets = ", ".join(f"{k}=%s" for k in updates)
        params = list(updates.values()) + [bid]
        cur = conn.cursor()
        cur.execute(f"UPDATE brands SET {sets} WHERE id=%s", params)
        cur.close()
        diff = ", ".join(f"{k}: {existing.get(k)} -> {updates[k]}" for k in updates)
        write_audit(conn, g.user, "BRAND_UPDATE",
                    f"Updated brand '{existing['name']}' (id={bid}) [{diff}]")
        conn.commit()
        return ok({"message": "Brand updated"})
    except MySQLError as e:
        conn.rollback()
        log.exception("Update brand failed: %s", e)
        return err("Failed to update brand", 500)
    finally:
        conn.close()


@app.delete("/api/brands/<int:bid>")
@owner_required
def delete_brand(bid: int):
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT id, name FROM brands WHERE id=%s", (bid,))
        brand = cur.fetchone()
        if not brand:
            cur.close()
            return err("Brand not found", 404)

        cur.execute("SELECT COUNT(*) AS cnt FROM products WHERE brand_id=%s", (bid,))
        if cur.fetchone()["cnt"] > 0:
            cur.close()
            return err(
                "Cannot delete: this brand still has products. Remove them first.",
                409,
            )
        cur.close()

        cur = conn.cursor()
        cur.execute("DELETE FROM brands WHERE id=%s", (bid,))
        cur.close()
        write_audit(conn, g.user, "BRAND_DELETE",
                    f"Deleted brand '{brand['name']}' (id={bid})")
        conn.commit()
        return ok({"message": "Brand deleted"})
    except MySQLError as e:
        conn.rollback()
        log.exception("Delete brand failed: %s", e)
        return err("Failed to delete brand", 500)
    finally:
        conn.close()


# =====================================================================
# PRODUCTS
# =====================================================================
def _strip_prices(rows, role):
    if role == "owner":
        return rows
    for r in rows:
        r.pop("cost_price", None)
        r.pop("selling_price", None)
        # price_per_ml stays — staff needs it to display refill totals.
    return rows


@app.get("/api/products")
@login_required
def list_products():
    category_id = request.args.get("category_id")
    brand_id = request.args.get("brand_id")
    refillable = request.args.get("refillable")

    where = ["p.is_active = TRUE"]
    params = []
    if brand_id:
        try:
            params.append(int(brand_id))
            where.append("p.brand_id = %s")
        except ValueError:
            return err("Invalid brand_id", 400)
    if category_id:
        try:
            params.append(int(category_id))
            where.append("b.category_id = %s")
        except ValueError:
            return err("Invalid category_id", 400)
    if refillable is not None and refillable != "":
        if refillable.lower() in ("1", "true", "yes"):
            where.append("p.is_refillable = TRUE")
        elif refillable.lower() in ("0", "false", "no"):
            where.append("p.is_refillable = FALSE")

    sql = f"""
        SELECT p.id, p.brand_id, b.name AS brand_name,
               b.category_id, c.name AS category_name,
               p.name, p.description,
               p.cost_price, p.selling_price, p.price_per_ml,
               p.stock_quantity, p.low_stock_threshold,
               p.is_refillable, p.is_active,
               p.created_at, p.updated_at,
               (p.stock_quantity <= p.low_stock_threshold) AS low_stock
        FROM products p
        JOIN brands b ON b.id = p.brand_id
        JOIN categories c ON c.id = b.category_id
        WHERE {' AND '.join(where)}
        ORDER BY c.name ASC, b.name ASC, p.name ASC
    """
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(sql, params)
        rows = cur.fetchall()
        cur.close()
        for r in rows:
            r["low_stock"] = bool(r["low_stock"])
            r["is_refillable"] = bool(r["is_refillable"])
        rows = _strip_prices(rows, g.user["role"])
        return ok({"products": rows})
    finally:
        conn.close()


@app.get("/api/products/<int:pid>")
@login_required
def get_product(pid: int):
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(
            """SELECT p.*, b.name AS brand_name, b.category_id,
                      c.name AS category_name,
                      (p.stock_quantity <= p.low_stock_threshold) AS low_stock
               FROM products p
               JOIN brands b ON b.id = p.brand_id
               JOIN categories c ON c.id = b.category_id
               WHERE p.id=%s""",
            (pid,),
        )
        row = cur.fetchone()
        cur.close()
        if not row or not row["is_active"]:
            return err("Product not found", 404)
        row["low_stock"] = bool(row["low_stock"])
        row["is_refillable"] = bool(row["is_refillable"])
        rows = _strip_prices([row], g.user["role"])
        return ok({"product": rows[0]})
    finally:
        conn.close()


def _validate_product_payload(body, partial=False):
    """Return (parsed_dict, error_message)."""
    out = {}
    try:
        if "brand_id" in body or not partial:
            if "brand_id" not in body:
                return None, "brand_id is required"
            out["brand_id"] = int(body["brand_id"])
        if "name" in body or not partial:
            n = (body.get("name") or "").strip()
            if not n:
                return None, "Product name is required"
            if len(n) > 150:
                return None, "Product name is too long"
            out["name"] = n
        if "description" in body:
            d = (body.get("description") or "").strip()
            out["description"] = d if d else None
        if "cost_price" in body or not partial:
            out["cost_price"] = to_decimal(body.get("cost_price", 0), "cost_price")
        if "selling_price" in body or not partial:
            out["selling_price"] = to_decimal(body.get("selling_price", 0), "selling_price")
        if "stock_quantity" in body or not partial:
            out["stock_quantity"] = to_int(body.get("stock_quantity", 0), "stock_quantity", 0)
        if "low_stock_threshold" in body:
            out["low_stock_threshold"] = to_int(body["low_stock_threshold"], "low_stock_threshold", 0)
        if "is_refillable" in body:
            out["is_refillable"] = to_bool(body["is_refillable"])
        if "price_per_ml" in body:
            out["price_per_ml"] = to_decimal(body["price_per_ml"], "price_per_ml", allow_none=True)
    except ValueError as e:
        return None, str(e)
    return out, None


@app.post("/api/products")
@owner_required
def create_product():
    body = request.get_json(silent=True) or {}
    parsed, e_msg = _validate_product_payload(body, partial=False)
    if e_msg:
        return err(e_msg, 400)

    if parsed.get("is_refillable") and (parsed.get("price_per_ml") is None):
        return err("Refillable products require a price per ml", 400)

    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT id, name FROM brands WHERE id=%s", (parsed["brand_id"],))
        brand = cur.fetchone()
        cur.close()
        if not brand:
            return err("Brand not found", 404)

        cols = ["brand_id", "name", "description", "cost_price", "selling_price",
                "price_per_ml", "stock_quantity", "low_stock_threshold",
                "is_refillable", "is_active"]
        vals = [
            parsed["brand_id"],
            parsed["name"],
            parsed.get("description"),
            parsed["cost_price"],
            parsed["selling_price"],
            parsed.get("price_per_ml"),
            parsed["stock_quantity"],
            parsed.get("low_stock_threshold", 5),
            parsed.get("is_refillable", False),
            True,
        ]
        cur = conn.cursor()
        ph = ", ".join(["%s"] * len(cols))
        cur.execute(
            f"INSERT INTO products ({', '.join(cols)}) VALUES ({ph})", vals
        )
        new_id = cur.lastrowid
        cur.close()

        write_audit(
            conn, g.user, "PRODUCT_CREATE",
            f"Created product '{parsed['name']}' under brand '{brand['name']}' "
            f"(id={new_id}, stock={parsed['stock_quantity']}, "
            f"cost=PKR {parsed['cost_price']}, sell=PKR {parsed['selling_price']}, "
            f"refillable={parsed.get('is_refillable', False)})",
        )
        conn.commit()
        return ok({"id": new_id, "message": "Product created"}, 201)
    except MySQLError as e:
        conn.rollback()
        log.exception("Create product failed: %s", e)
        return err("Failed to create product", 500)
    finally:
        conn.close()


@app.put("/api/products/<int:pid>")
@owner_required
def update_product(pid: int):
    body = request.get_json(silent=True) or {}
    parsed, e_msg = _validate_product_payload(body, partial=True)
    if e_msg:
        return err(e_msg, 400)
    if not parsed:
        return err("No fields to update", 400)

    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(
            """SELECT p.*, b.name AS brand_name FROM products p
               JOIN brands b ON b.id = p.brand_id
               WHERE p.id=%s AND p.is_active=TRUE""",
            (pid,),
        )
        existing = cur.fetchone()
        cur.close()
        if not existing:
            return err("Product not found", 404)

        # Validate brand if changed
        if "brand_id" in parsed:
            cur = conn.cursor()
            cur.execute("SELECT id FROM brands WHERE id=%s", (parsed["brand_id"],))
            ok_b = cur.fetchone()
            cur.close()
            if not ok_b:
                return err("Target brand not found", 404)

        # Refillable consistency check
        will_refillable = parsed.get("is_refillable",
                                     bool(existing["is_refillable"]))
        will_ppml = parsed.get("price_per_ml", existing["price_per_ml"])
        if will_refillable and will_ppml in (None, 0, Decimal("0")):
            return err("Refillable products require a price per ml > 0", 400)
        if not will_refillable:
            # Auto-clear price_per_ml when product is no longer refillable
            parsed["price_per_ml"] = None

        sets = ", ".join(f"{k}=%s" for k in parsed)
        params = list(parsed.values()) + [pid]
        cur = conn.cursor()
        cur.execute(f"UPDATE products SET {sets} WHERE id=%s", params)
        cur.close()
        diff_parts = []
        for k, v in parsed.items():
            diff_parts.append(f"{k}: {existing.get(k)} -> {v}")
        write_audit(conn, g.user, "PRODUCT_UPDATE",
                    f"Updated product '{existing['name']}' (id={pid}) "
                    f"[{', '.join(diff_parts)}]")
        conn.commit()
        return ok({"message": "Product updated"})
    except MySQLError as e:
        conn.rollback()
        log.exception("Update product failed: %s", e)
        return err("Failed to update product", 500)
    finally:
        conn.close()


@app.delete("/api/products/<int:pid>")
@owner_required
def delete_product(pid: int):
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT id, name FROM products WHERE id=%s AND is_active=TRUE", (pid,))
        prod = cur.fetchone()
        cur.close()
        if not prod:
            return err("Product not found", 404)
        cur = conn.cursor()
        cur.execute("UPDATE products SET is_active=FALSE WHERE id=%s", (pid,))
        cur.close()
        write_audit(conn, g.user, "PRODUCT_DELETE",
                    f"Soft-deleted product '{prod['name']}' (id={pid})")
        conn.commit()
        return ok({"message": "Product deleted"})
    except MySQLError as e:
        conn.rollback()
        log.exception("Delete product failed: %s", e)
        return err("Failed to delete product", 500)
    finally:
        conn.close()


# =====================================================================
# REFILL SIZES
# =====================================================================
@app.get("/api/refill-sizes")
@login_required
def list_refill_sizes():
    only_active = request.args.get("active", "true").lower() in ("1", "true", "yes")
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        if only_active:
            cur.execute(
                """SELECT id, label, ml_amount, is_active, created_at
                   FROM refill_sizes WHERE is_active=TRUE
                   ORDER BY ml_amount ASC"""
            )
        else:
            cur.execute(
                """SELECT id, label, ml_amount, is_active, created_at
                   FROM refill_sizes
                   ORDER BY is_active DESC, ml_amount ASC"""
            )
        rows = cur.fetchall()
        cur.close()
        for r in rows:
            r["is_active"] = bool(r["is_active"])
        return ok({"refill_sizes": rows})
    finally:
        conn.close()


@app.post("/api/refill-sizes")
@owner_required
def create_refill_size():
    body = request.get_json(silent=True) or {}
    label = (body.get("label") or "").strip()
    if not label:
        return err("Label is required", 400)
    if len(label) > 50:
        return err("Label is too long", 400)
    try:
        ml = to_decimal(body.get("ml_amount"), "ml_amount")
    except ValueError as e:
        return err(str(e), 400)
    if ml is None or ml <= 0:
        return err("ml_amount must be greater than 0", 400)

    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO refill_sizes (label, ml_amount, is_active) VALUES (%s, %s, TRUE)",
            (label, ml),
        )
        new_id = cur.lastrowid
        cur.close()
        write_audit(conn, g.user, "REFILL_SIZE_CREATE",
                    f"Created refill size '{label}' = {ml}ml (id={new_id})")
        conn.commit()
        return ok({"id": new_id, "message": "Refill size created"}, 201)
    except MySQLError as e:
        conn.rollback()
        log.exception("Create refill size failed: %s", e)
        return err("Failed to create refill size", 500)
    finally:
        conn.close()


@app.put("/api/refill-sizes/<int:sid>")
@owner_required
def update_refill_size(sid: int):
    body = request.get_json(silent=True) or {}
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT * FROM refill_sizes WHERE id=%s", (sid,))
        existing = cur.fetchone()
        cur.close()
        if not existing:
            return err("Refill size not found", 404)

        updates = {}
        if "label" in body:
            l = (body["label"] or "").strip()
            if not l:
                return err("Label cannot be empty", 400)
            updates["label"] = l
        if "ml_amount" in body:
            try:
                ml = to_decimal(body["ml_amount"], "ml_amount")
            except ValueError as e:
                return err(str(e), 400)
            if ml is None or ml <= 0:
                return err("ml_amount must be greater than 0", 400)
            updates["ml_amount"] = ml
        if "is_active" in body:
            updates["is_active"] = to_bool(body["is_active"])

        if not updates:
            return err("No fields to update", 400)

        sets = ", ".join(f"{k}=%s" for k in updates)
        params = list(updates.values()) + [sid]
        cur = conn.cursor()
        cur.execute(f"UPDATE refill_sizes SET {sets} WHERE id=%s", params)
        cur.close()
        diff = ", ".join(f"{k}: {existing.get(k)} -> {updates[k]}" for k in updates)
        write_audit(conn, g.user, "REFILL_SIZE_UPDATE",
                    f"Updated refill size (id={sid}) [{diff}]")
        conn.commit()
        return ok({"message": "Refill size updated"})
    except MySQLError as e:
        conn.rollback()
        log.exception("Update refill size failed: %s", e)
        return err("Failed to update refill size", 500)
    finally:
        conn.close()


@app.delete("/api/refill-sizes/<int:sid>")
@owner_required
def delete_refill_size(sid: int):
    """Soft-delete (deactivate) since old refill rows reference this id."""
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT id, label FROM refill_sizes WHERE id=%s", (sid,))
        rs = cur.fetchone()
        cur.close()
        if not rs:
            return err("Refill size not found", 404)

        cur = conn.cursor()
        cur.execute("UPDATE refill_sizes SET is_active=FALSE WHERE id=%s", (sid,))
        cur.close()
        write_audit(conn, g.user, "REFILL_SIZE_DELETE",
                    f"Deactivated refill size '{rs['label']}' (id={sid})")
        conn.commit()
        return ok({"message": "Refill size deactivated"})
    except MySQLError as e:
        conn.rollback()
        log.exception("Delete refill size failed: %s", e)
        return err("Failed to delete refill size", 500)
    finally:
        conn.close()


# =====================================================================
# SALES (product sales)
# =====================================================================
@app.post("/api/sales")
@login_required
def create_sale():
    body = request.get_json(silent=True) or {}
    miss = require_fields(body, ["product_id", "quantity"])
    if miss:
        return err(miss, 400)

    try:
        product_id = int(body["product_id"])
        quantity = to_int(body["quantity"], "quantity", 1)
    except (ValueError, TypeError) as e:
        return err(str(e) if str(e) else "Invalid input", 400)

    conn = get_conn()
    try:
        conn.start_transaction()
        cur = conn.cursor(dictionary=True)
        cur.execute(
            """SELECT p.id, p.name, p.selling_price, p.stock_quantity,
                      b.name AS brand_name
               FROM products p
               JOIN brands b ON b.id = p.brand_id
               WHERE p.id=%s AND p.is_active=TRUE FOR UPDATE""",
            (product_id,),
        )
        prod = cur.fetchone()
        cur.close()

        if not prod:
            conn.rollback()
            return err("Product not found", 404)

        if prod["stock_quantity"] < quantity:
            conn.rollback()
            return err(
                f"Insufficient stock — only {prod['stock_quantity']} unit(s) available",
                400,
                available=prod["stock_quantity"],
            )

        selling_price = Decimal(prod["selling_price"])
        total = (selling_price * Decimal(quantity)).quantize(Decimal("0.01"))

        cur = conn.cursor()
        cur.execute(
            """INSERT INTO sales
               (product_id, staff_id, quantity_sold, selling_price_at_time, total_amount)
               VALUES (%s, %s, %s, %s, %s)""",
            (product_id, g.user["id"], quantity, selling_price, total),
        )
        sale_id = cur.lastrowid

        cur.execute(
            "UPDATE products SET stock_quantity = stock_quantity - %s WHERE id=%s",
            (quantity, product_id),
        )
        cur.close()

        if g.user["role"] == "owner":
            details = (f"Sold {quantity} x '{prod['brand_name']} {prod['name']}' "
                       f"@ PKR {selling_price} (total PKR {total}, sale_id={sale_id})")
        else:
            details = (f"Sold {quantity} x '{prod['brand_name']} {prod['name']}' "
                       f"(sale_id={sale_id})")
        write_audit(conn, g.user, "SALE_RECORD", details)
        conn.commit()

        return ok({
            "id": sale_id,
            "product_id": product_id,
            "quantity": quantity,
            "total_amount": float(total) if g.user["role"] == "owner" else None,
            "message": "Sale recorded",
        }, 201)
    except MySQLError as e:
        conn.rollback()
        log.exception("Sale failed: %s", e)
        return err("Failed to record sale", 500)
    finally:
        conn.close()


@app.get("/api/sales")
@login_required
def list_sales():
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        if g.user["role"] == "owner":
            cur.execute(
                """SELECT s.id, s.product_id, p.name AS product_name,
                          b.name AS brand_name, c.name AS category_name,
                          s.staff_id, u.name AS staff_name,
                          s.quantity_sold, s.selling_price_at_time,
                          s.total_amount, s.sold_at
                   FROM sales s
                   JOIN products p ON p.id = s.product_id
                   JOIN brands b ON b.id = p.brand_id
                   JOIN categories c ON c.id = b.category_id
                   JOIN users u ON u.id = s.staff_id
                   ORDER BY s.sold_at DESC
                   LIMIT 500"""
            )
        else:
            cur.execute(
                """SELECT s.id, s.product_id, p.name AS product_name,
                          b.name AS brand_name, c.name AS category_name,
                          s.quantity_sold, s.sold_at
                   FROM sales s
                   JOIN products p ON p.id = s.product_id
                   JOIN brands b ON b.id = p.brand_id
                   JOIN categories c ON c.id = b.category_id
                   WHERE s.staff_id=%s AND DATE(s.sold_at) = CURDATE()
                   ORDER BY s.sold_at DESC""",
                (g.user["id"],),
            )
        rows = cur.fetchall()
        cur.close()
        return ok({"sales": rows})
    finally:
        conn.close()


@app.get("/api/sales/today")
@owner_required
def sales_today():
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(
            """SELECT s.id, s.product_id, p.name AS product_name,
                      b.name AS brand_name, c.name AS category_name,
                      s.staff_id, u.name AS staff_name,
                      s.quantity_sold, s.selling_price_at_time,
                      s.total_amount, s.sold_at
               FROM sales s
               JOIN products p ON p.id = s.product_id
               JOIN brands b ON b.id = p.brand_id
               JOIN categories c ON c.id = b.category_id
               JOIN users u ON u.id = s.staff_id
               WHERE DATE(s.sold_at) = CURDATE()
               ORDER BY s.sold_at ASC"""
        )
        rows = cur.fetchall()
        cur.close()

        running = Decimal("0.00")
        for r in rows:
            running += Decimal(r["total_amount"])
            r["running_total"] = running

        cur = conn.cursor(dictionary=True)
        cur.execute(
            """SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount),0) AS revenue
               FROM sales WHERE DATE(sold_at)=CURDATE()"""
        )
        summary = cur.fetchone()
        cur.close()

        return ok({
            "sales": rows,
            "summary": {"count": summary["cnt"], "total_revenue": summary["revenue"]},
        })
    finally:
        conn.close()


# =====================================================================
# REFILLS (services — NO stock change)
# =====================================================================
@app.post("/api/refills")
@login_required
def create_refill():
    body = request.get_json(silent=True) or {}
    miss = require_fields(body, ["product_id", "refill_size_id"])
    if miss:
        return err(miss, 400)

    try:
        product_id = int(body["product_id"])
        refill_size_id = int(body["refill_size_id"])
    except (ValueError, TypeError):
        return err("Invalid input", 400)

    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(
            """SELECT p.id, p.name, p.is_refillable, p.price_per_ml,
                      b.name AS brand_name
               FROM products p
               JOIN brands b ON b.id = p.brand_id
               WHERE p.id=%s AND p.is_active=TRUE""",
            (product_id,),
        )
        prod = cur.fetchone()
        if not prod:
            cur.close()
            return err("Product not found", 404)
        if not prod["is_refillable"]:
            cur.close()
            return err("This product is not refillable", 400)
        if prod["price_per_ml"] is None:
            cur.close()
            return err("Refill price (per ml) is not set on this product", 400)

        cur.execute(
            """SELECT id, label, ml_amount, is_active FROM refill_sizes WHERE id=%s""",
            (refill_size_id,),
        )
        rs = cur.fetchone()
        cur.close()
        if not rs or not rs["is_active"]:
            return err("Refill size not found or inactive", 404)

        ppml = Decimal(prod["price_per_ml"])
        ml = Decimal(rs["ml_amount"])
        total = (ppml * ml).quantize(Decimal("0.01"))

        cur = conn.cursor()
        cur.execute(
            """INSERT INTO refills
               (product_id, staff_id, refill_size_id, ml_amount,
                price_per_ml_at_time, total_amount)
               VALUES (%s, %s, %s, %s, %s, %s)""",
            (product_id, g.user["id"], refill_size_id, ml, ppml, total),
        )
        rid = cur.lastrowid
        cur.close()

        if g.user["role"] == "owner":
            details = (f"Refill {rs['label']} ({ml}ml) of '{prod['brand_name']} "
                       f"{prod['name']}' @ PKR {ppml}/ml (total PKR {total}, refill_id={rid})")
        else:
            details = (f"Refill {rs['label']} ({ml}ml) of '{prod['brand_name']} "
                       f"{prod['name']}' (refill_id={rid})")
        write_audit(conn, g.user, "REFILL_RECORD", details)
        conn.commit()

        return ok({
            "id": rid,
            "product_id": product_id,
            "refill_size_id": refill_size_id,
            "ml_amount": float(ml),
            "price_per_ml": float(ppml),
            "total_amount": float(total) if g.user["role"] == "owner" else None,
            "message": "Refill recorded",
        }, 201)
    except MySQLError as e:
        conn.rollback()
        log.exception("Refill failed: %s", e)
        return err("Failed to record refill", 500)
    finally:
        conn.close()


@app.get("/api/refills")
@login_required
def list_refills():
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        if g.user["role"] == "owner":
            cur.execute(
                """SELECT r.id, r.product_id, p.name AS product_name,
                          b.name AS brand_name, c.name AS category_name,
                          r.staff_id, u.name AS staff_name,
                          r.refill_size_id, rs.label AS refill_label,
                          r.ml_amount, r.price_per_ml_at_time,
                          r.total_amount, r.done_at
                   FROM refills r
                   JOIN products p ON p.id = r.product_id
                   JOIN brands b ON b.id = p.brand_id
                   JOIN categories c ON c.id = b.category_id
                   JOIN users u ON u.id = r.staff_id
                   JOIN refill_sizes rs ON rs.id = r.refill_size_id
                   ORDER BY r.done_at DESC
                   LIMIT 500"""
            )
        else:
            cur.execute(
                """SELECT r.id, r.product_id, p.name AS product_name,
                          b.name AS brand_name, c.name AS category_name,
                          r.refill_size_id, rs.label AS refill_label,
                          r.ml_amount, r.done_at
                   FROM refills r
                   JOIN products p ON p.id = r.product_id
                   JOIN brands b ON b.id = p.brand_id
                   JOIN categories c ON c.id = b.category_id
                   JOIN refill_sizes rs ON rs.id = r.refill_size_id
                   WHERE r.staff_id=%s AND DATE(r.done_at) = CURDATE()
                   ORDER BY r.done_at DESC""",
                (g.user["id"],),
            )
        rows = cur.fetchall()
        cur.close()
        return ok({"refills": rows})
    finally:
        conn.close()


@app.get("/api/refills/today")
@owner_required
def refills_today():
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(
            """SELECT r.id, r.product_id, p.name AS product_name,
                      b.name AS brand_name, c.name AS category_name,
                      r.staff_id, u.name AS staff_name,
                      rs.label AS refill_label,
                      r.ml_amount, r.price_per_ml_at_time,
                      r.total_amount, r.done_at
               FROM refills r
               JOIN products p ON p.id = r.product_id
               JOIN brands b ON b.id = p.brand_id
               JOIN categories c ON c.id = b.category_id
               JOIN users u ON u.id = r.staff_id
               JOIN refill_sizes rs ON rs.id = r.refill_size_id
               WHERE DATE(r.done_at) = CURDATE()
               ORDER BY r.done_at ASC"""
        )
        rows = cur.fetchall()
        cur.close()

        running = Decimal("0.00")
        for r in rows:
            running += Decimal(r["total_amount"])
            r["running_total"] = running

        cur = conn.cursor(dictionary=True)
        cur.execute(
            """SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount),0) AS revenue
               FROM refills WHERE DATE(done_at)=CURDATE()"""
        )
        summary = cur.fetchone()
        cur.close()

        return ok({
            "refills": rows,
            "summary": {"count": summary["cnt"], "total_revenue": summary["revenue"]},
        })
    finally:
        conn.close()


# =====================================================================
# PURCHASES (restocks)
# =====================================================================
@app.post("/api/purchases")
@owner_required
def create_purchase():
    body = request.get_json(silent=True) or {}
    miss = require_fields(body, ["product_id", "quantity_added", "cost_price_at_time"])
    if miss:
        return err(miss, 400)

    try:
        product_id = int(body["product_id"])
        qty = to_int(body["quantity_added"], "quantity_added", 1)
        cost = to_decimal(body["cost_price_at_time"], "cost_price_at_time")
    except (ValueError, TypeError) as e:
        return err(str(e), 400)

    supplier = (body.get("supplier_name") or "").strip()[:100] or None
    update_cost = bool(body.get("update_cost_price", False))
    total = (cost * Decimal(qty)).quantize(Decimal("0.01"))

    conn = get_conn()
    try:
        conn.start_transaction()
        cur = conn.cursor(dictionary=True)
        cur.execute(
            """SELECT p.id, p.name, p.cost_price, b.name AS brand_name
               FROM products p
               JOIN brands b ON b.id = p.brand_id
               WHERE p.id=%s AND p.is_active=TRUE FOR UPDATE""",
            (product_id,),
        )
        prod = cur.fetchone()
        cur.close()
        if not prod:
            conn.rollback()
            return err("Product not found", 404)

        cur = conn.cursor()
        cur.execute(
            """INSERT INTO purchases
               (product_id, owner_id, quantity_added, cost_price_at_time,
                total_cost, supplier_name)
               VALUES (%s, %s, %s, %s, %s, %s)""",
            (product_id, g.user["id"], qty, cost, total, supplier),
        )
        pur_id = cur.lastrowid

        if update_cost:
            cur.execute(
                "UPDATE products SET stock_quantity = stock_quantity + %s, cost_price=%s WHERE id=%s",
                (qty, cost, product_id),
            )
        else:
            cur.execute(
                "UPDATE products SET stock_quantity = stock_quantity + %s WHERE id=%s",
                (qty, product_id),
            )
        cur.close()

        write_audit(conn, g.user, "STOCK_PURCHASE",
                    f"Restocked {qty} x '{prod['brand_name']} {prod['name']}' "
                    f"@ PKR {cost} (total PKR {total}, supplier={supplier or 'N/A'}, "
                    f"purchase_id={pur_id})")
        conn.commit()
        return ok({"id": pur_id, "message": "Purchase recorded"}, 201)
    except MySQLError as e:
        conn.rollback()
        log.exception("Purchase failed: %s", e)
        return err("Failed to record purchase", 500)
    finally:
        conn.close()


@app.delete("/api/purchases/<int:pid>")
@owner_required
def delete_purchase(pid: int):
    """Remove a purchase from history. Stock is NOT reversed —
       the stock change happened in the past and is left intact."""
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(
            """SELECT pu.id, pu.quantity_added, pu.cost_price_at_time,
                      pu.total_cost, pu.supplier_name, pu.purchased_at,
                      p.name AS product_name, b.name AS brand_name,
                      c.name AS category_name
               FROM purchases pu
               JOIN products p ON p.id = pu.product_id
               JOIN brands b ON b.id = p.brand_id
               JOIN categories c ON c.id = b.category_id
               WHERE pu.id=%s""",
            (pid,),
        )
        pu = cur.fetchone()
        cur.close()
        if not pu:
            return err("Purchase not found", 404)

        cur = conn.cursor()
        cur.execute("DELETE FROM purchases WHERE id=%s", (pid,))
        cur.close()

        write_audit(
            conn, g.user, "PURCHASE_DELETE",
            f"Deleted purchase record (id={pid}): "
            f"{pu['quantity_added']} x '{pu['brand_name']} {pu['product_name']}' "
            f"@ PKR {pu['cost_price_at_time']} (total PKR {pu['total_cost']}, "
            f"supplier={pu['supplier_name'] or 'N/A'}, "
            f"originally recorded {pu['purchased_at']}). "
            f"Stock was NOT reversed.",
        )
        conn.commit()
        return ok({"message": "Purchase record deleted (stock unchanged)"})
    except MySQLError as e:
        conn.rollback()
        log.exception("Delete purchase failed: %s", e)
        return err("Failed to delete purchase record", 500)
    finally:
        conn.close()


@app.get("/api/purchases")
@owner_required
def list_purchases():
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(
            """SELECT pu.id, pu.product_id, p.name AS product_name,
                      b.name AS brand_name, c.name AS category_name,
                      pu.owner_id, u.name AS owner_name,
                      pu.quantity_added, pu.cost_price_at_time,
                      pu.total_cost, pu.supplier_name, pu.purchased_at
               FROM purchases pu
               JOIN products p ON p.id = pu.product_id
               JOIN brands b ON b.id = p.brand_id
               JOIN categories c ON c.id = b.category_id
               JOIN users u ON u.id = pu.owner_id
               ORDER BY pu.purchased_at DESC
               LIMIT 500"""
        )
        rows = cur.fetchall()
        cur.close()
        return ok({"purchases": rows})
    finally:
        conn.close()


# =====================================================================
# DASHBOARD STATS
# =====================================================================
@app.get("/api/dashboard/stats")
@owner_required
def dashboard_stats():
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)

        cur.execute(
            """SELECT COALESCE(SUM(total_amount),0) AS total,
                      COUNT(*) AS cnt
               FROM sales WHERE DATE(sold_at)=CURDATE()"""
        )
        prod_today = cur.fetchone()

        cur.execute(
            """SELECT COALESCE(SUM(total_amount),0) AS total,
                      COUNT(*) AS cnt
               FROM refills WHERE DATE(done_at)=CURDATE()"""
        )
        refill_today = cur.fetchone()

        cur.execute(
            """SELECT COALESCE(SUM(cost_price * stock_quantity),0) AS stock_value,
                      COALESCE(SUM((selling_price - cost_price) * stock_quantity),0) AS profit_potential,
                      COUNT(*) AS total_products
               FROM products WHERE is_active=TRUE"""
        )
        inv = cur.fetchone()

        cur.execute(
            """SELECT p.id, p.name, p.stock_quantity, p.low_stock_threshold,
                      p.cost_price, p.selling_price,
                      b.name AS brand_name, c.name AS category_name
               FROM products p
               JOIN brands b ON b.id = p.brand_id
               JOIN categories c ON c.id = b.category_id
               WHERE p.is_active=TRUE AND p.stock_quantity <= p.low_stock_threshold
               ORDER BY p.stock_quantity ASC"""
        )
        low_stock = cur.fetchall()

        cur.execute(
            """SELECT p.id, p.name, b.name AS brand_name,
                      SUM(s.quantity_sold) AS qty,
                      SUM(s.total_amount) AS revenue
               FROM sales s
               JOIN products p ON p.id = s.product_id
               JOIN brands b ON b.id = p.brand_id
               WHERE DATE(s.sold_at)=CURDATE()
               GROUP BY p.id, p.name, b.name
               ORDER BY qty DESC
               LIMIT 5"""
        )
        top_sellers = cur.fetchall()

        cur.execute(
            """SELECT p.id, p.name, b.name AS brand_name,
                      COUNT(*) AS cnt,
                      SUM(r.ml_amount) AS total_ml,
                      SUM(r.total_amount) AS revenue
               FROM refills r
               JOIN products p ON p.id = r.product_id
               JOIN brands b ON b.id = p.brand_id
               WHERE DATE(r.done_at)=CURDATE()
               GROUP BY p.id, p.name, b.name
               ORDER BY cnt DESC
               LIMIT 5"""
        )
        top_refills = cur.fetchall()

        cur.execute("SELECT COUNT(*) AS cnt FROM users WHERE role='staff' AND is_active=TRUE")
        staff = cur.fetchone()

        cur.close()

        prod_total = Decimal(prod_today["total"])
        refill_total = Decimal(refill_today["total"])

        return ok({
            "today_product_sales_total": prod_total,
            "today_product_sales_count": prod_today["cnt"],
            "today_refill_revenue": refill_total,
            "today_refill_count": refill_today["cnt"],
            "today_total_revenue": prod_total + refill_total,
            "today_total_count": prod_today["cnt"] + refill_today["cnt"],
            "total_stock_value": inv["stock_value"],
            "total_profit_potential": inv["profit_potential"],
            "low_stock_products": low_stock,
            "top_selling_today": top_sellers,
            "top_refills_today": top_refills,
            "total_products": inv["total_products"],
            "active_staff_count": staff["cnt"],
        })
    finally:
        conn.close()


# =====================================================================
# RECENT TRANSACTIONS (sales + refills, mixed)
# =====================================================================
@app.get("/api/transactions/recent")
@login_required
def recent_transactions():
    """Mixed feed of sales + refills, newest first.
       Owner sees all; staff sees only their own from today."""
    try:
        limit = int(request.args.get("limit", 20))
    except ValueError:
        limit = 20
    limit = max(1, min(limit, 200))

    is_owner = g.user["role"] == "owner"
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        if is_owner:
            cur.execute(
                """SELECT 'sale' AS kind, s.id, s.sold_at AS at,
                          p.name AS product_name, b.name AS brand_name,
                          c.name AS category_name,
                          u.name AS staff_name,
                          s.quantity_sold AS quantity,
                          NULL AS ml_amount, NULL AS refill_label,
                          s.total_amount
                   FROM sales s
                   JOIN products p ON p.id = s.product_id
                   JOIN brands b ON b.id = p.brand_id
                   JOIN categories c ON c.id = b.category_id
                   JOIN users u ON u.id = s.staff_id
                   UNION ALL
                   SELECT 'refill' AS kind, r.id, r.done_at AS at,
                          p.name AS product_name, b.name AS brand_name,
                          c.name AS category_name,
                          u.name AS staff_name,
                          NULL AS quantity,
                          r.ml_amount, rs.label AS refill_label,
                          r.total_amount
                   FROM refills r
                   JOIN products p ON p.id = r.product_id
                   JOIN brands b ON b.id = p.brand_id
                   JOIN categories c ON c.id = b.category_id
                   JOIN users u ON u.id = r.staff_id
                   JOIN refill_sizes rs ON rs.id = r.refill_size_id
                   ORDER BY at DESC
                   LIMIT %s""",
                (limit,),
            )
        else:
            cur.execute(
                """SELECT * FROM (
                       SELECT 'sale' AS kind, s.id, s.sold_at AS at,
                              p.name AS product_name, b.name AS brand_name,
                              c.name AS category_name,
                              s.quantity_sold AS quantity,
                              NULL AS ml_amount, NULL AS refill_label
                       FROM sales s
                       JOIN products p ON p.id = s.product_id
                       JOIN brands b ON b.id = p.brand_id
                       JOIN categories c ON c.id = b.category_id
                       WHERE s.staff_id=%s AND DATE(s.sold_at)=CURDATE()
                       UNION ALL
                       SELECT 'refill' AS kind, r.id, r.done_at AS at,
                              p.name AS product_name, b.name AS brand_name,
                              c.name AS category_name,
                              NULL AS quantity,
                              r.ml_amount, rs.label AS refill_label
                       FROM refills r
                       JOIN products p ON p.id = r.product_id
                       JOIN brands b ON b.id = p.brand_id
                       JOIN categories c ON c.id = b.category_id
                       JOIN refill_sizes rs ON rs.id = r.refill_size_id
                       WHERE r.staff_id=%s AND DATE(r.done_at)=CURDATE()
                   ) tx
                   ORDER BY at DESC
                   LIMIT %s""",
                (g.user["id"], g.user["id"], limit),
            )
        rows = cur.fetchall()
        cur.close()
        return ok({"transactions": rows})
    finally:
        conn.close()


# =====================================================================
# STAFF MANAGEMENT  (unchanged behaviour, refresh enriched today data)
# =====================================================================
@app.get("/api/staff")
@owner_required
def list_staff():
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(
            """SELECT u.id, u.name, u.email, u.is_active, u.created_at,
                      COALESCE(s.cnt, 0) AS sales_count_today,
                      COALESCE(s.revenue, 0) AS sales_total_today,
                      COALESCE(r.cnt, 0) AS refills_count_today,
                      COALESCE(r.revenue, 0) AS refills_total_today
               FROM users u
               LEFT JOIN (
                   SELECT staff_id, COUNT(*) AS cnt, SUM(total_amount) AS revenue
                   FROM sales WHERE DATE(sold_at)=CURDATE()
                   GROUP BY staff_id
               ) s ON s.staff_id = u.id
               LEFT JOIN (
                   SELECT staff_id, COUNT(*) AS cnt, SUM(total_amount) AS revenue
                   FROM refills WHERE DATE(done_at)=CURDATE()
                   GROUP BY staff_id
               ) r ON r.staff_id = u.id
               WHERE u.role='staff'
               ORDER BY u.is_active DESC, u.name ASC"""
        )
        rows = cur.fetchall()
        for r in rows:
            r["is_active"] = bool(r["is_active"])
        cur.close()
        return ok({"staff": rows})
    finally:
        conn.close()


@app.post("/api/staff")
@owner_required
def create_staff():
    body = request.get_json(silent=True) or {}
    miss = require_fields(body, ["name", "email", "password"])
    if miss:
        return err(miss, 400)

    name = str(body["name"]).strip()
    email = str(body["email"]).strip().lower()
    password = body["password"]

    if len(name) < 2:
        return err("Name is too short", 400)
    if not EMAIL_RE.match(email):
        return err("Invalid email address", 400)
    if len(password) < 6:
        return err("Password must be at least 6 characters", 400)

    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT id FROM users WHERE email=%s", (email,))
        if cur.fetchone():
            cur.close()
            return err("An account with this email already exists", 409)
        cur.close()

        cur = conn.cursor()
        cur.execute(
            """INSERT INTO users (name, email, password_hash, role, is_active)
               VALUES (%s, %s, %s, 'staff', TRUE)""",
            (name, email, hash_password(password)),
        )
        new_id = cur.lastrowid
        cur.close()
        write_audit(conn, g.user, "STAFF_CREATE",
                    f"Created staff account '{name}' ({email}, id={new_id})")
        conn.commit()
        return ok({"id": new_id, "message": "Staff account created"}, 201)
    except MySQLError as e:
        conn.rollback()
        log.exception("Create staff failed: %s", e)
        return err("Failed to create staff account", 500)
    finally:
        conn.close()


@app.put("/api/staff/<int:sid>/deactivate")
@owner_required
def deactivate_staff(sid: int):
    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(
            "SELECT id, name, email, is_active FROM users WHERE id=%s AND role='staff'",
            (sid,),
        )
        s = cur.fetchone()
        cur.close()
        if not s:
            return err("Staff member not found", 404)
        if not s["is_active"]:
            return err("Already deactivated", 400)

        cur = conn.cursor()
        cur.execute("UPDATE users SET is_active=FALSE WHERE id=%s", (sid,))
        cur.close()
        write_audit(conn, g.user, "STAFF_DEACTIVATE",
                    f"Deactivated staff '{s['name']}' ({s['email']}, id={sid})")
        conn.commit()
        return ok({"message": "Staff deactivated"})
    except MySQLError as e:
        conn.rollback()
        log.exception("Deactivate staff failed: %s", e)
        return err("Failed to deactivate staff", 500)
    finally:
        conn.close()


# =====================================================================
# AUDIT LOG
# =====================================================================
@app.get("/api/audit")
@owner_required
def get_audit():
    try:
        page = max(int(request.args.get("page", 1)), 1)
    except ValueError:
        page = 1
    per_page = 50
    offset = (page - 1) * per_page

    conn = get_conn()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT COUNT(*) AS cnt FROM audit_log")
        total = cur.fetchone()["cnt"]

        cur.execute(
            """SELECT id, user_id, user_name, role, action, details,
                      ip_address, timestamp
               FROM audit_log
               ORDER BY timestamp DESC, id DESC
               LIMIT %s OFFSET %s""",
            (per_page, offset),
        )
        rows = cur.fetchall()
        cur.close()
        return ok({
            "entries": rows,
            "page": page,
            "per_page": per_page,
            "total": total,
            "total_pages": max((total + per_page - 1) // per_page, 1),
        })
    finally:
        conn.close()


# =====================================================================
# RESET TEST DATA  (irreversible)
# =====================================================================
@app.delete("/api/admin/reset-test-data")
@owner_required
def reset_test_data():
    """Hard reset: wipe inventory hierarchy + transactions + audit history.
       Re-seeds only the default refill sizes.
       Owner accounts and staff users are preserved."""
    body = request.get_json(silent=True) or {}
    confirm = (body.get("confirm") or "").strip()
    if confirm != "RESET":
        return err("Type 'RESET' to confirm this irreversible action", 400)

    conn = get_conn()
    try:
        conn.start_transaction()
        cur = conn.cursor()

        # Delete in FK-safe order
        cur.execute("DELETE FROM refills")
        refills_deleted = cur.rowcount
        cur.execute("DELETE FROM sales")
        sales_deleted = cur.rowcount
        cur.execute("DELETE FROM purchases")
        purchases_deleted = cur.rowcount
        cur.execute("DELETE FROM products")
        products_deleted = cur.rowcount
        cur.execute("DELETE FROM brands")
        brands_deleted = cur.rowcount
        cur.execute("DELETE FROM categories")
        categories_deleted = cur.rowcount
        cur.execute("DELETE FROM refill_sizes")
        refill_sizes_deleted = cur.rowcount
        cur.execute("DELETE FROM audit_log")
        audit_deleted = cur.rowcount

        # Re-seed only the default refill sizes
        cur.execute(
            "INSERT INTO refill_sizes (label, ml_amount) VALUES "
            "('1ml', 1.0), ('2ml', 2.0), ('3ml', 3.0), ('5ml', 5.0), ('Full Bottle', 30.0)"
        )
        cur.close()

        # Write the reset itself as the first entry of the fresh audit log
        write_audit(
            conn, g.user, "TEST_DATA_RESET",
            f"Hard reset: deleted {refills_deleted} refills, "
            f"{sales_deleted} sales, {purchases_deleted} purchases, "
            f"{products_deleted} products, {brands_deleted} brands, "
            f"{categories_deleted} categories, "
            f"{refill_sizes_deleted} refill sizes, "
            f"{audit_deleted} audit entries. "
            f"Re-seeded 5 default refill sizes."
        )
        conn.commit()

        return ok({
            "message": "Test data reset successfully",
            "stats": {
                "refills_deleted": refills_deleted,
                "sales_deleted": sales_deleted,
                "purchases_deleted": purchases_deleted,
                "products_deleted": products_deleted,
                "brands_deleted": brands_deleted,
                "categories_deleted": categories_deleted,
                "refill_sizes_deleted": refill_sizes_deleted,
                "audit_entries_wiped": audit_deleted,
                "refill_sizes_seeded": 5,
            },
        })
    except MySQLError as e:
        conn.rollback()
        log.exception("Reset failed: %s", e)
        return err("Failed to reset test data", 500)
    finally:
        conn.close()


# =====================================================================
# FRONTEND CATCH-ALL
# =====================================================================
@app.route('/')
def index():
    return send_from_directory(FRONTEND_DIR, 'index.html')


@app.get("/manifest.json")
def manifest_file():
    path = os.path.abspath(os.path.join(FRONTEND_DIR, "..", "manifest.json"))
    folder = os.path.dirname(path)
    return send_from_directory(folder, "manifest.json")


@app.get("/sw.js")
def sw_file():
    path = os.path.abspath(os.path.join(FRONTEND_DIR, "..", "sw.js"))
    folder = os.path.dirname(path)
    return send_from_directory(folder, "sw.js")


@app.get("/<path:filename>")
def frontend_catchall(filename: str):
    if filename.startswith("api/") or filename == "api":
        abort(404)

    full = os.path.join(FRONTEND_DIR, filename)
    if os.path.isfile(full):
        return send_from_directory(FRONTEND_DIR, filename)
    return send_from_directory(FRONTEND_DIR, "index.html")


# ---------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------
@app.errorhandler(404)
def handle_404(e):
    if request.path.startswith("/api/"):
        return err("Not found", 404)
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.errorhandler(405)
def handle_405(e):
    return err("Method not allowed", 405)


@app.errorhandler(500)
def handle_500(e):
    log.exception("Unhandled 500: %s", e)
    return err("Internal server error", 500)


# ---------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------
def boot():
    init_pool()
    ensure_schema_and_owner()


try:
    boot()
except Exception as e:
    log.error("Bootstrap failed at import time: %s", e)


if __name__ == "__main__":
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)
