# 🛍️ Millo 2026 — Canada's Maker Marketplace

A full-stack webserver where sellers sign up and list products for **$25 CAD per product per month**.

## Features
- 🏪 Seller sign-up / login with secure sessions (SHA-256 + cookie)
- 📦 Add, edit, delete products (name, description, price, category, photo URL)
- 💳 Billing dashboard: see exactly how many products you have and your monthly total
- 🔍 Marketplace browse page with search + category filtering
- 🗄️ Zero-dependency JSON file database (no external services needed)
- 🌱 Auto-seeded with demo data on first run

## Pricing Model
- **$25 CAD / product / month** — flat fee, no commission, no hidden charges
- Sellers see their running bill in their dashboard

## Quick Start

```bash
# Requires Node.js ≥ 18 — no npm install needed
node server.js
# Open http://localhost:3000
```

## Demo Login
```
Email:    sophie@demo.com
Password: demo123
```

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/signup | — | Create seller account |
| POST | /api/login | — | Sign in |
| POST | /api/logout | — | Sign out |
| GET | /api/me | ✓ | Current seller + bill |
| GET | /api/products | — | Browse all products |
| GET | /api/products/:id | — | Single product |
| POST | /api/products | ✓ | Create product |
| PUT | /api/products/:id | ✓ | Update product |
| DELETE | /api/products/:id | ✓ | Remove product |
| GET | /api/my-products | ✓ | Seller's own products + bill |

## Tech Stack
- **Runtime**: Node.js (no npm packages required)
- **Database**: `db.json` (flat file, auto-created)
- **Auth**: SHA-256 password hash + HttpOnly session cookie
- **Frontend**: Vanilla HTML/CSS/JS SPA served from `/public`
