# Patch for server.js

Two small, additive changes. Nothing here touches your webhook logic or
your existing verify-payment success path.

## 1. Import the new helper

Change this line:

```js
import { resolveCart, getBySlug } from './lib/products.js';
```

to:

```js
import { resolveCart, getBySlug, isFreeProduct } from './lib/products.js';
```

## 2. Catch the new "free item in a paid cart" error

`resolveCart` now *throws* if any item in the cart resolves to a free
product (see lib/products.js patch). Wrap the existing call in
`/verify-payment` so that shows up as a clean `verified:false` response
instead of a 500:

```js
// 1. Work out what this order SHOULD cost, from our own trusted product data.
let resolvedItems, total, currency;
try {
  ({ items: resolvedItems, total, currency } = await resolveCart(items));
} catch (err) {
  if (err.code === 'FREE_PRODUCT_IN_PAID_CART') {
    return res.status(400).json({ verified: false, reason: err.message });
  }
  throw err;
}
if (!resolvedItems.length) {
  return res.status(400).json({ verified: false, reason: 'No valid products in this order.' });
}
```

That replaces the current single-line call:

```js
const { items: resolvedItems, total, currency } = await resolveCart(items);
```

## 3. Add the free-download route

Your frontend's product-page.js already calls
`GET {backend}/api/free-download/:slug` for the "Get Free Resource" button
— add this route (anywhere after your CORS setup, alongside `/verify-payment`):

```js
app.get('/api/free-download/:slug', async (req, res) => {
  try {
    const product = await getBySlug(req.params.slug);
    if (!product) {
      return res.status(404).json({ ok: false, message: 'Product not found.' });
    }
    if (!isFreeProduct(product)) {
      // The one guarantee that matters most: a paid product can NEVER
      // come out of this route, no matter what the client claims.
      return res.status(403).json({ ok: false, message: 'This product is not free.' });
    }
    if (!product.downloadUrl) {
      return res.status(404).json({ ok: false, message: 'No file is attached to this product yet.' });
    }
    return res.json({ ok: true, downloadUrl: product.downloadUrl });
  } catch (err) {
    console.error('free-download error:', err);
    return res.status(500).json({ ok: false, message: 'Could not prepare your download right now.' });
  }
});
```

## The paid-PDF exposure fix — corrected approach

**Important correction from what I said last turn:** I initially suggested a
`downloads.json` file committed to this repo. After checking, **your Vivyp
repo on GitHub is public** — committing that file would leave it exactly as
exposed as the current public `data/products.json`, just at a different
URL. So instead, the download map lives in a **Render environment
variable**, `DOWNLOADS_JSON` — the same way `FLW_SECRET_KEY` and
`RESEND_API_KEY` already avoid ever touching the repo.

### 1. Replace `lib/products.js`

Use `products-v2.js` from this delivery (full drop-in replacement — it
also includes last turn's free-item-in-paid-cart guard, so you only need
one file swap for both fixes).

### 2. Replace `lib/email.js`

Use `email.js` from this delivery — your pasted version had corrupted
syntax (missing braces/parens throughout, likely a copy-paste issue) and
would not have run as-is. This is functionally identical to what you
intended, just fixed.

### 3. Add the `DOWNLOADS_JSON` Render environment variable

A single-line JSON object, `{ "slug": "real download link", ... }`, one
entry per product. `DOWNLOADS_JSON.env-value.txt` in this delivery is a
**template** built from the slugs in the placeholder catalog I
reconstructed a few turns ago — it is almost certainly NOT an exact match
for whatever products actually exist on your live site right now. Please
regenerate it from your real, current `data/products.json` slugs (or send
me that file and I'll generate the exact template) before pasting into
Render — a mismatched slug just means that product has no download link
yet, not a security problem, but it's worth getting right.

The actual link value for each slug can be anything reachable — a Google
Drive "anyone with the link" share URL, a Dropbox link, etc. It doesn't
need to be a signed/expiring URL to be a real improvement: the point is
it's no longer sitting in a JSON file anyone can browse to directly.

### 4. Also remove `downloadUrl` from your public `data/products.json`

The backend now ignores it either way, but leaving it there means it's
still needlessly public. Strip that field from the live file on GitHub
Pages next time you touch it.

