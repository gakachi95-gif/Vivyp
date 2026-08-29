/**
 * server.js
 *
 * The Vivy backend — payments AND now the product database/admin API too.
 *
 * Endpoints:
 *   GET    /                          health check
 *   GET    /api/catalog                public — full product catalog for the storefront
 *   GET    /api/free-download/:slug    public — free products only, never Flutterwave
 *   POST   /verify-payment             called by checkout.html after Flutterwave closes
 *   POST   /webhook/flutterwave        backup delivery path, called by Flutterwave itself
 *   POST   /api/admin/login            issues a session token
 *   GET    /api/admin/products         admin — list (requires token)
 *   POST   /api/admin/products         admin — create
 *   PUT    /api/admin/products/:id     admin — update / quick-toggle Featured/Best Seller/New
 *   DELETE /api/admin/products/:id     admin — delete
 *   POST   /api/admin/upload           admin — cover image or PDF file
 *   POST   /api/admin/import           admin — one-time import from the old public JSON
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import multer from 'multer';

import {
  resolveCart, getBySlug, isFreeProduct, getCatalog, invalidateCache,
} from './lib/products.js';
import { verifyTransaction, transactionMatchesOrder } from './lib/flutterwave.js';
import { sendDeliveryEmail } from './lib/email.js';
import { login, requireAdmin } from './lib/auth.js';
import * as db from './lib/db.js';
import * as storage from './lib/storage.js';

const app = express();
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } }); // 60MB cap

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
  })
);

// In-memory de-dupe so a retried request doesn't re-email/re-fulfil the same
// order twice. Resets on restart/sleep — fine for de-dupe purposes, since
// the real record of what happened lives in Flutterwave's own dashboard.
const processedTransactions = new Set();

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'vivy-backend' });
});

/* ========================== PUBLIC STOREFRONT ========================== */

/** GET /api/catalog — what js/products.js fetches instead of (before falling back to) data/products.json. */
app.get('/api/catalog', async (req, res) => {
  try {
    const catalog = await getCatalog();
    res.json(catalog);
  } catch (err) {
    console.error('catalog error:', err);
    res.status(500).json({ message: 'Could not load products right now.' });
  }
});

/**
 * GET /api/free-download/:slug
 * The ONLY way a customer gets a free download link. Re-checks the ACTUAL
 * price from trusted product data — a paid product can never come out of
 * this route, no matter what the client claims.
 */
app.get('/api/free-download/:slug', async (req, res) => {
  try {
    const product = await getBySlug(req.params.slug);
    if (!product) return res.status(404).json({ ok: false, message: 'Product not found.' });
    if (!isFreeProduct(product)) return res.status(403).json({ ok: false, message: 'This product is not free.' });
    if (!product.downloadUrl) return res.status(404).json({ ok: false, message: 'No file is attached to this product yet.' });
    return res.json({ ok: true, downloadUrl: product.downloadUrl });
  } catch (err) {
    console.error('free-download error:', err);
    return res.status(500).json({ ok: false, message: 'Could not prepare your download right now.' });
  }
});

/* ============================== PAYMENTS ================================ */

app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const token = await login(username, password);
    res.json({ token });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.status ? err.message : 'Could not log in right now.' });
  }
});

app.post('/verify-payment', async (req, res) => {
  try {
    const { tx_ref, transaction_id, email, name, items } = req.body || {};

    if (!tx_ref || !transaction_id || !email || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ verified: false, reason: 'Missing required order details.' });
    }
    if (processedTransactions.has(String(transaction_id))) {
      return res.status(200).json({ verified: true, reason: 'Already processed.' });
    }

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

    const verifyResponse = await verifyTransaction(transaction_id);
    const check = transactionMatchesOrder(verifyResponse, { txRef: tx_ref, total, currency });
    if (!check.ok) {
      return res.status(400).json({ verified: false, reason: check.reason });
    }

    const emailResult = await sendDeliveryEmail({ to: email, name, items: resolvedItems });
    processedTransactions.add(String(transaction_id));

    return res.json({
      verified: true,
      emailSent: emailResult.sent,
      items: resolvedItems.map((i) => ({ name: i.product.name, downloadUrl: i.product.downloadUrl })),
    });
  } catch (err) {
    console.error('verify-payment error:', err);
    return res.status(500).json({ verified: false, reason: 'Server error while verifying payment.' });
  }
});

app.post('/webhook/flutterwave', express.json(), async (req, res) => {
  try {
    const signature = req.headers['verif-hash'];
    const expected = process.env.FLW_WEBHOOK_HASH;
    if (!expected || !signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return res.status(401).json({ received: false });
    }

    const event = req.body;
    const txId = event && event.data && event.data.id;
    if (!txId) return res.status(200).json({ received: true });
    if (processedTransactions.has(String(txId))) {
      return res.status(200).json({ received: true, reason: 'Already processed.' });
    }

    const verifyResponse = await verifyTransaction(txId);
    const tx = verifyResponse.data;
    if (verifyResponse.status !== 'success' || !tx || tx.status !== 'successful') {
      return res.status(200).json({ received: true });
    }

    let cartItems = [];
    try {
      const rawCart = (tx.meta && tx.meta.vivy_cart) || (event.data.meta && event.data.meta.vivy_cart);
      if (rawCart) cartItems = JSON.parse(rawCart);
    } catch (err) {
      console.warn(`Webhook: could not parse cart meta for transaction ${txId}:`, err.message);
    }
    if (!Array.isArray(cartItems) || !cartItems.length) {
      processedTransactions.add(String(txId));
      return res.status(200).json({ received: true });
    }

    let resolvedItems, total, currency;
    try {
      ({ items: resolvedItems, total, currency } = await resolveCart(cartItems));
    } catch (err) {
      processedTransactions.add(String(txId));
      return res.status(200).json({ received: true });
    }
    if (!resolvedItems.length) {
      processedTransactions.add(String(txId));
      return res.status(200).json({ received: true });
    }

    const currencyMatches = (tx.currency || '').toUpperCase() === currency.toUpperCase();
    if (!currencyMatches || tx.amount < total - 0.01) {
      processedTransactions.add(String(txId));
      return res.status(200).json({ received: true });
    }

    const email = tx.customer && tx.customer.email;
    const name = tx.customer && tx.customer.name;
    if (email) await sendDeliveryEmail({ to: email, name, items: resolvedItems });

    processedTransactions.add(String(txId));
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('webhook error:', err);
    return res.status(200).json({ received: true });
  }
});

/* ============================ ADMIN — PRODUCTS =========================== */

app.get('/api/admin/products', requireAdmin, async (req, res) => {
  try {
    const [products, categories] = await Promise.all([db.getAllProducts(), db.getAllCategories()]);
    res.json({ products, categories });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not load your products right now.' });
  }
});

app.post('/api/admin/products', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.slug || !body.name) return res.status(400).json({ message: 'Name and slug are required.' });
    const existing = await db.getProductBySlugFromDb(body.slug);
    if (existing) return res.status(409).json({ message: `Another product already uses the slug "${body.slug}".` });
    const created = await db.createProduct({ ...body, fileKey: body.fileRef || null });
    invalidateCache();
    res.status(201).json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Unable to publish product.' });
  }
});

app.put('/api/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    const body = { ...req.body };
    if (body.fileRef) { body.fileKey = body.fileRef; delete body.fileRef; }
    const updated = await db.updateProduct(req.params.id, body);
    if (!updated) return res.status(404).json({ message: 'Product not found.' });
    invalidateCache();
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Unable to save product.' });
  }
});

app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    const deleted = await db.deleteProduct(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Product not found.' });
    if (deleted.file_key) await storage.deleteObject(deleted.file_key);
    invalidateCache();
    res.json({ message: 'Product deleted.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Unable to delete product.' });
  }
});

app.post('/api/admin/upload', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file received.' });
    const { type, slug } = req.body;
    if (type === 'cover') {
      const result = await storage.uploadCoverImage(req.file.buffer, slug, req.file.mimetype);
      return res.json(result);
    }
    if (type === 'pdf') {
      const result = await storage.uploadPrivatePdf(req.file.buffer, slug, req.file.mimetype);
      return res.json(result);
    }
    res.status(400).json({ message: 'Unknown upload type.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Unable to upload file.' });
  }
});

app.post('/api/admin/import', requireAdmin, async (req, res) => {
  try {
    const { products = [], categories = [] } = req.body || {};
    const imported = await db.importProducts(products, categories);
    invalidateCache();
    res.json({ message: `Imported ${imported} new product(s). Existing ones were left untouched.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Unable to import products.' });
  }
});

/* ============================================================================ */

db.migrate().catch((err) => console.error('Database migration failed on startup:', err));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Vivy backend listening on port ${port}`);
});
