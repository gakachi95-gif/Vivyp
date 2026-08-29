# Connecting admin login to Render

## 1. Replace/add these files in the Vivyp (backend) repo

| Path | Action |
|---|---|
| `lib/auth.js` | **New file** — add it |
| `server.js` | **Replace** with the version in this delivery (adds the `/api/admin/login` route on top of everything from before) |

## 2. Add two lines to `package.json`

In your `dependencies` object, add:

```json
"bcryptjs": "^2.4.3",
"jsonwebtoken": "^9.0.2"
```

Render runs `npm install` automatically on your next deploy — nothing else needed.

## 3. Generate your password hash

Open `password-hash-generator.html` from this delivery **in your phone's browser** (just tap the file, or upload it anywhere you can open an HTML file — it needs no server, it's a single self-contained page). Type your real admin password, tap Generate, copy the result. It never leaves your phone — the hashing runs entirely in the page's own JavaScript.

## 4. Add three Render environment variables

Render dashboard → your Vivyp service → **Environment**:

| Variable | Value |
|---|---|
| `ADMIN_USERNAME` | Whatever username you want to log in with, e.g. `vivy` |
| `ADMIN_PASSWORD_HASH` | The hash you just copied from step 3 — **not** your plain password |
| `JWT_SECRET` | `41a60b3d6667b974e8ab4bc7951ee457198fcd58b7b32aec6e737ac640adbc9f` (a fresh random value I generated for you — safe to use as-is, or generate your own if you'd rather) |

Save — Render redeploys automatically.

## 5. Try it

Open `admin.html` on your live site, enter the username/password you just set, tap **Log In**. You should land on the dashboard.

## What still won't work yet, and why

Logging in will succeed, but tapping **+ Add Product** will fail — there's still no `/api/admin/products` endpoint or database on the backend. That's the next piece (Parts 1–9 from your original spec: product CRUD, image/PDF upload, persistent storage). Login was step one; want me to build that next?
