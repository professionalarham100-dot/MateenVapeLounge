# Mateen VapeLounge — Inventory Management System

Production-grade inventory, sales, staff, and audit system for **Mateen VapeLounge**.
Single Flask backend serves a JWT-secured REST API and a custom dark-themed PWA frontend.

> **Core principle:** every state change is recorded. Staff cannot see financial data.
> The owner can monitor revenue, stock value, profit, low-stock alerts, top sellers,
> and a complete audit log from any device.

---

## Stack

| Layer       | Tech                                                     |
|-------------|----------------------------------------------------------|
| Backend     | Python 3.10+, Flask 3, mysql-connector-python, PyJWT, bcrypt |
| Database    | MySQL 8                                                  |
| Frontend    | Vanilla JS / CSS (no build step), PWA (service worker)   |
| Auth        | JWT (HS256, 24-hour expiry)                              |
| Deployment  | Gunicorn + Railway (or any Python host)                  |

---

## Features

### Owner
- Dashboard with today's revenue, sales count, stock value, low-stock alerts
- Full product catalog with margin %, low-stock indicators, soft-delete
- Restock entry form with supplier history
- Staff account creation & deactivation
- Real-time audit log of every action with IP + timestamp
- Profit-potential & top-seller analytics
- Dark / light theme

### Staff
- Searchable product picker that exposes **only product name + stock**
- One-tap sale recording (atomic stock decrement, server-validated)
- Personal "my sales today" history
- Stock overview grid with low/out-of-stock badges
- **Zero financial data anywhere on the page** (server-enforced)

### System
- Server-side role enforcement on every protected route (403 on mismatch)
- Atomic sale transactions — stock can never go negative
- Soft-delete only — never hard-delete products
- IP captured for every audit entry
- Failed logins logged
- Installable PWA (Add to Home Screen on phone)

---

## Prerequisites

- **Python 3.10 or newer**
- **MySQL 8 or newer**
- **pip** (ships with Python)

Optional for development:
- A modern browser (Chrome / Edge / Safari) for the dashboards
- A REST client (Postman / Bruno) if you want to poke the API directly

---

## Local setup — step by step

### 1. Clone / unzip the project

```bash
cd MateenVapeLounge
```

### 2. Create the database

Connect to MySQL with your privileged user (`root` or any account that can create
databases) and run the schema file:

```bash
mysql -u root -p < schema.sql
```

This creates the `mateen_vapelounge` database, all tables, indexes, the five
default categories, and five seed products.

> The **owner account** is **NOT** created by the SQL file. It is created
> automatically by the Flask app on first startup using credentials from
> `backend/.env`. See step 5.

### 3. Set up the Python environment

```bash
cd backend
python -m venv venv

# Linux / macOS:
source venv/bin/activate

# Windows (PowerShell):
.\venv\Scripts\Activate.ps1

# Windows (cmd):
venv\Scripts\activate.bat

pip install -r requirements.txt
```

### 4. Configure `.env`

Open `backend/.env` and update the values for your environment:

```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=mateen_vapelounge

SECRET_KEY=generate-a-long-random-string
JWT_SECRET_KEY=generate-a-different-long-random-string

OWNER_NAME=Mateen
OWNER_EMAIL=owner@yourdomain.com
OWNER_PASSWORD=ChangeThisPassword
```

To generate strong secrets:

```bash
python -c "import secrets; print(secrets.token_urlsafe(64))"
```

### 5. Run the application

From the `backend/` folder with the virtualenv active:

```bash
python app.py
```

You should see:
```
[INFO] app: MySQL connection pool initialised (db=mateen_vapelounge)
[INFO] app: Owner account seeded: owner@yourdomain.com
 * Running on http://0.0.0.0:5000
```

Open **http://localhost:5000** in your browser.

### 6. Sign in

- **Email:** `owner@yourdomain.com`
- **Password:** `ChangeThisPassword`

> Change the owner password after the first login by editing `OWNER_PASSWORD` in
> `.env` and re-creating the user, or by adding a password-change endpoint as a
> follow-up task.

### 7. Create staff accounts

Once signed in as the owner, go to **Staff → Create Staff Account**. Hand the
email + password to your staff member — they sign in at the same URL and see
the staff console (no financial data).

---

## Project structure

```
MateenVapeLounge/
├── schema.sql                  Database schema + seed data
├── manifest.json               PWA manifest
├── sw.js                       Service worker (offline cache)
├── README.md                   This file
│
├── backend/
│   ├── app.py                  Flask app, all routes
│   ├── config.py               Loads .env into a Config class
│   ├── requirements.txt        Python deps
│   └── .env                    Secrets / DB credentials (DO NOT COMMIT)
│
└── frontend/
    ├── index.html              Login page
    ├── owner-dashboard.html    Owner dashboard
    ├── staff-dashboard.html    Staff console
    ├── css/
    │   ├── main.css            Design system (tokens, components)
    │   ├── login.css           Login page styles
    │   ├── owner-dashboard.css
    │   └── staff-dashboard.css
    ├── js/
    │   ├── auth.js             Auth + utils + login handler
    │   ├── owner.js            Owner dashboard logic
    │   └── staff.js            Staff dashboard logic
    └── static/
        └── icon.svg            PWA icon
```

---

## API summary

All endpoints prefixed with `/api`. Send JWT as `Authorization: Bearer <token>`.

### Auth
| Method | Path                | Role     | Description                    |
|--------|---------------------|----------|--------------------------------|
| POST   | `/api/auth/login`   | public   | Issue JWT                      |
| POST   | `/api/auth/logout`  | auth     | Audit log only                 |
| GET    | `/api/auth/me`      | auth     | Current user info              |

### Products
| Method | Path                              | Role     |
|--------|-----------------------------------|----------|
| GET    | `/api/products`                   | auth     |
| GET    | `/api/products/categories`        | auth     |
| POST   | `/api/products`                   | owner    |
| PUT    | `/api/products/<id>`              | owner    |
| DELETE | `/api/products/<id>`              | owner    |

### Sales
| Method | Path                  | Role         |
|--------|-----------------------|--------------|
| POST   | `/api/sales`          | staff/owner  |
| GET    | `/api/sales`          | auth (scoped)|
| GET    | `/api/sales/today`    | owner        |

### Purchases (restocks)
| Method | Path                  | Role     |
|--------|-----------------------|----------|
| POST   | `/api/purchases`      | owner    |
| GET    | `/api/purchases`      | owner    |

### Dashboard / Staff / Audit
| Method | Path                                | Role  |
|--------|-------------------------------------|-------|
| GET    | `/api/dashboard/stats`              | owner |
| GET    | `/api/staff`                        | owner |
| POST   | `/api/staff`                        | owner |
| PUT    | `/api/staff/<id>/deactivate`        | owner |
| GET    | `/api/audit?page=N`                 | owner |

---

## Deploying to Railway

[Railway](https://railway.app) hosts the Flask app and MySQL together.

### 1. Provision a MySQL plugin

In your Railway project, click **+ New → Database → MySQL**. Railway provisions
a database and exposes the connection details as environment variables.

### 2. Apply the schema

Use the Railway MySQL connection string with the `mysql` CLI or any GUI client
(TablePlus / DBeaver) and run `schema.sql`.

```bash
mysql -h <railway-mysql-host> -P <port> -u <user> -p<password> < schema.sql
```

### 3. Push the Flask app

Push the project to a GitHub repo, then in Railway click **+ New → GitHub
Repo** and select it. Add the following service settings:

**Root directory:** `backend`

**Build command:** `pip install -r requirements.txt`

**Start command:**
```
gunicorn --workers 2 --threads 4 --bind 0.0.0.0:$PORT app:app
```

**Environment variables:** copy these from your local `.env`. Use the
Railway-provided MySQL variables for `DB_HOST`, `DB_PORT`, `DB_USER`,
`DB_PASSWORD`, `DB_NAME`. Generate new production-grade `SECRET_KEY` and
`JWT_SECRET_KEY` values:

```
DB_HOST=<railway>
DB_PORT=<railway>
DB_USER=<railway>
DB_PASSWORD=<railway>
DB_NAME=<railway>

SECRET_KEY=<random-64-bytes>
JWT_SECRET_KEY=<random-64-bytes>
JWT_EXPIRY_HOURS=24

OWNER_NAME=Mateen
OWNER_EMAIL=owner@yourdomain.com
OWNER_PASSWORD=<your-strong-password>
```

> ⚠️ The `frontend/` folder is served directly by Flask. If your repo root is
> different from `backend/`, set the build context so Flask can still resolve
> `../frontend`. The current `config.py` does this with an absolute path
> relative to `backend/`.

### 4. Visit your Railway URL

Railway gives you a public URL like `https://mateenvapelounge.up.railway.app`.
Open it on the owner's phone, then **Add to Home Screen** to install the PWA.

---

## Owner login

| Field    | Value                              |
|----------|------------------------------------|
| Email    | `owner@yourdomain.com`             |
| Password | `ChangeThisPassword` (change after first login) |

---

## How staff accounts are created

1. Sign in as the owner.
2. Open **Staff** in the sidebar.
3. Fill **Full Name**, **Email**, **Password (min 6 chars)** and submit.
4. Hand the email + password to the staff member.
5. Staff signs in at the same URL — they are auto-routed to the staff console.
6. Owner can deactivate any staff member instantly from the same screen
   (their sales history is preserved).

Every account creation, login, sale, restock, edit, delete, and deactivation is
recorded to the **Audit Log** with user name, role, action type, details, IP
address, and timestamp. The audit log is paginated, 50 entries per page,
newest first.

---

## Development tips

- **Tail logs:** Flask logs to stdout. In production, gunicorn streams to Railway
  logs which are searchable.
- **Reset password locally:** delete the row in `users` for the owner email and
  restart the app — it will re-seed using `.env`.
- **Wipe data:** drop the database and re-run `schema.sql`.
- **Testing the API:** every protected route requires
  `Authorization: Bearer <token>`. Get a token from `POST /api/auth/login`.

---

## Security checklist

- [x] Bcrypt password hashing (12 rounds)
- [x] JWT signed with separate secret, 24-hour expiry
- [x] Role enforced on every protected route, server-side
- [x] Staff endpoints strip price fields from product payloads
- [x] Stock decrement is atomic (transactional + `FOR UPDATE`)
- [x] All money fields use `DECIMAL(10,2)` — no float drift
- [x] Failed logins audit-logged
- [x] IP captured per audit row
- [x] Catch-all SPA route never intercepts `/api/*`
- [x] CORS scoped to API; static files served by Flask
- [x] Soft-delete preserves history

For HTTPS in production, terminate TLS at Railway / your reverse proxy.

---

## License

Proprietary — built for Mateen VapeLounge. All rights reserved.
