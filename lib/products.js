/**
 * lib/products.js
 *
 * CHANGED again: the database (lib/db.js) is now the PRIMARY source for
 * products. Your original PRODUCTS_JSON_URL / products.fallback.json
 * chain still exists, but only as:
 *   (a) a resilience fallback if the database is briefly unreachable, and
 *   (b) the one-time seed data for the admin's "Import existing products"
 *       button (db.importProducts()).
 *
 * Download links: a product created/edited through the admin has its PDF
 * in private object storage (db row's file_key -> signed URL). A product
 * that was only ever imported from the old public JSON and never
 * re-uploaded falls back to the DOWNLOADS_JSON env var by slug. Once you
 * re-upload a product's PDF from the admin, it moves to the first path
 * and DOWNLOADS_JSON is no longer consulted for that slug.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import { getSignedDownloadUrl } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FALLBACK_PATH = path.join(__dirname, '..', 'products.fallback.json');
const CACHE_TTL_MS = 60 * 1000; // 1 minute — short, since the DB can now change at any time via the admin

let cache = { data: null, fetchedAt: 0 };
let downloadsCache = null;

async function loadStaticFallback() {
  const url = process.env.PRODUCTS_JSON_URL;
  if (url) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) return res.json();
    } catch (err) {
      console.warn('Could not fetch live products.json fallback:', err.message);
    }
  }
  const raw = await fs.readFile(FALLBACK_PATH, 'utf-8');
  return JSON.parse(raw);
}

/** { "product-slug": "https://legacy-link", ... } — only used for products with no file_key yet. */
function loadLegacyDownloads() {
  if (downloadsCache) return downloadsCache;
  const raw = process.env.DOWNLOADS_JSON;
  if (!raw) { downloadsCache = {}; return downloadsCache; }
  try {
    downloadsCache = JSON.parse(raw);
  } catch (err) {
    console.error('DOWNLOADS_JSON env var is not valid JSON:', err.message);
    downloadsCache = {};
  }
  return downloadsCache;
}

/**
 * The full public catalog, database-first. Falls back to the old static
 * chain only if the database itself is unreachable, so the storefront
 * never goes fully down.
 */
export async function getCatalog() {
  const now = Date.now();
  if (cache.data && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }
  try {
    const [products, categories] = await Promise.all([db.getAllProducts(), db.getAllCategories()]);
    const data = { products, categories, freeResources: [], bundles: [] };
    cache = { data, fetchedAt: now };
    return data;
  } catch (err) {
    console.warn('Database unavailable, falling back to static product data:', err.message);
    const fallback = await loadStaticFallback();
    cache = { data: fallback, fetchedAt: now };
    return fallback;
  }
}

export async function getAllSellable() {
  const catalog = await getCatalog();
  return [...(catalog.products || []), ...(catalog.freeResources || [])];
}

/** Attaches the real download link — DB file_key (signed, private) first, legacy DOWNLOADS_JSON second. */
async function withDownloadUrl(product) {
  if (!product) return product;
  if (product.fileKey) {
    try {
      const downloadUrl = await getSignedDownloadUrl(product.fileKey, 600);
      return { ...product, downloadUrl };
    } catch (err) {
      console.error(`Could not sign a download URL for ${product.slug}:`, err.message);
      return { ...product, downloadUrl: null };
    }
  }
  const legacy = loadLegacyDownloads();
  return { ...product, downloadUrl: legacy[product.slug] || null };
}

export async function getBySlug(slug) {
  const all = await getAllSellable();
  const product = all.find((p) => p.slug === slug) || null;
  return withDownloadUrl(product);
}

/** Explicit, type-safe free check — never relies on truthiness. */
export function isFreeProduct(product) {
  if (!product) return false;
  const raw = product.salePrice != null ? product.salePrice : product.price;
  const n = typeof raw === 'string' ? parseFloat(raw) : raw;
  return typeof n === 'number' && !isNaN(n) && n <= 0;
}

/**
 * Resolves a cart against the database's own trusted prices. Throws if
 * any item resolves to a free product — a free item can never ride along
 * inside a paid checkout, independent of anything the frontend does.
 */
export async function resolveCart(cartItems) {
  const all = await getAllSellable();
  const resolved = [];
  let total = 0;
  let currency = 'USD';

  for (const entry of cartItems) {
    const publicProduct = all.find((p) => p.slug === entry.slug);
    if (!publicProduct) continue;

    if (isFreeProduct(publicProduct)) {
      const err = new Error(`"${publicProduct.name}" is a free product and cannot go through payment.`);
      err.code = 'FREE_PRODUCT_IN_PAID_CART';
      throw err;
    }

    const product = await withDownloadUrl(publicProduct);
    const quantity = Math.max(1, Math.min(20, Number(entry.quantity) || 1));
    const unitPrice = product.salePrice != null ? product.salePrice : product.price;
    const lineTotal = unitPrice * quantity;
    total += lineTotal;
    currency = product.currency || currency;
    resolved.push({ product, quantity, unitPrice, lineTotal });
  }

  return { items: resolved, total: Math.round(total * 100) / 100, currency };
}

/** Invalidates the short catalog cache — call after any admin write so changes show up immediately. */
export function invalidateCache() {
  cache = { data: null, fetchedAt: 0 };
}
