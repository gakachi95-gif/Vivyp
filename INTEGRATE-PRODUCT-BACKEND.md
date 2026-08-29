# Product management backend — integration steps

## 1. Files to add/replace in the Vivyp repo

| Path | Action |
|---|---|
| `lib/db.js` | **New** |
| `lib/storage.js` | **New** |
| `lib/products.js` | **Replace** (again — this is the final version; database-first now) |
| `server.js` | **Replace** (final version — everything from every prior turn, consolidated) |
| `lib/auth.js` | Unchanged from last turn — leave as-is |
| `lib/flutterwave.js`, `lib/email.js` | Unchanged — leave as-is |

## 2. Add to `package.json` dependencies

```json
"pg": "^8.12.0",
"@aws-sdk/client-s3": "^3.600.0",
"@aws-sdk/s3-request-presigner": "^3.600.0",
"multer": "^1.4.5-lts.1"
```

(`bcryptjs` and `jsonwebtoken` should already be there from last turn.)

## 3. Set up the database — Render Postgres

Render dashboard → **New** → **PostgreSQL** → create it (free tier is fine to start) → once created, go back to your Vivyp web service → **Environment** → **Add from database** → pick the Postgres instance. This automatically adds `DATABASE_URL` for you — nothing to copy/paste.

## 4. Set up file storage — Cloudflare R2

1. Cloudflare dashboard → R2 → create a bucket (e.g. `vivy-files`).
2. R2 → Manage API tokens → create a token with read/write access to that bucket. This gives you an Access Key ID and Secret Access Key.
3. Under the bucket's Settings, enable public access for a `covers/` style use (or just make the whole bucket public — PDFs are still safe because their *keys* are never exposed, only signed URLs are).

Add these Render environment variables:

| Variable | Value |
|---|---|
| `R2_ENDPOINT` | Your account's R2 endpoint, shown on the R2 overview page (`https://<account-id>.r2.cloudflarestorage.com`) |
| `R2_ACCESS_KEY_ID` | From the API token you created |
| `R2_SECRET_ACCESS_KEY` | From the API token you created |
| `R2_BUCKET` | Your bucket name |
| `R2_PUBLIC_BASE_URL` | The public URL for that bucket (R2's own `.r2.dev` public URL, or a custom domain you attach) |

## 5. Deploy, then seed your existing catalog

Once Render redeploys with the above, open `admin.html`, log in, and tap **Import existing products** — this reads your live `data/products.json` and inserts everything into the new database (skips anything already there, safe to click more than once).

**One thing to know about the imported products:** they'll show up with no PDF attached yet (import doesn't move files — it can't, they weren't stored anywhere structured before). Two options per product:
- If you still have `DOWNLOADS_JSON` set from a couple of turns ago, those products keep working off that legacy link automatically — no action needed.
- Otherwise, open each one in **Edit** and re-upload its PDF once. From then on it's served from private storage.

Anything you add **new** from now on already goes straight into the database with a real, gated file — no extra step.

## 6. Test it

- **Add Product** with price `0` → should publish, and its "Get Free Resource" button should download without ever showing Flutterwave.
- **Add Product** with price `500` → should publish, and Buy Now should open Flutterwave for exactly ₦500 (or your chosen currency), verified server-side, delivered by email.
- **Featured / Best Seller / New** toggles on the dashboard should reflect on your live storefront within about a minute (the catalog cache refreshes every 60 seconds, or instantly since every admin write calls `invalidateCache()`).

That closes out every part of your original spec — login, product CRUD, uploads, persistent storage, free/paid separation front-to-back, and gated PDF delivery.
