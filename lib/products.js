/**
 * lib/products.js
 *
 * Product PRICING/METADATA still comes from your public data/products.json
 * (via PRODUCTS_JSON_URL, cached 5 min, falling back to the bundled
 * products.fallback.json) — that part is unchanged from your original.
 *
 * CHANGED: real download links no longer come from that public file at
 * all. They come from the DOWNLOADS_JSON environment variable — a single
 * Render env var holding a JSON object of `{ "slug": "real link", ... }`.
 *
 * This is deliberately an env var and NOT a committed file: your Vivyp
 * repo on GitHub is public, so a downloads.json file sitting in the repo
 * would be exactly as exposed as the current public products.json is —
 * anyone could just browse to it. An env var lives only on Render and is
 * never visible in the repo, matching how FLW_SECRET_KEY and
 * RESEND_API_KEY are already handled here.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FALLBACK_PATH = path.join(__dirname, '..', 'products.fallback.json');
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cache = { data: null, fetchedAt: 0 };
let downloadsCache = null; // parsed once from env, kept in memory

async function loadFallback() {
  const raw = await fs.readFile(FALLBACK_PATH, 'utf-8');
  return JSON.parse(raw);
}

/** { "product-slug": "https://real-private-download-link", ... } — from Render env, never from a file in the repo. */
function loadDownloads() {
  if (downloadsCache) return downloadsCache;
  const raw = process.env.DOWNLOADS_JSON;
  if (!raw) {
    console.warn('DOWNLOADS_JSON env var is not set — no products will have a real download link yet.');
    downloadsCache = {};
    return downloadsCache;
  }
  try {
    downloadsCache = JSON.parse(raw);
  } catch (err) {
    console.error('DOWNLOADS_JSON env var is not valid JSON:', err.message);
    downloadsCache = {};
  }
  return downloadsCache;
}

export async function getCatalog() {
  const now = Date.now();
  if (cache.data && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  const url = process.env.PRODUCTS_JSON_URL;
  if (url) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        cache = { data, fetchedAt: now };
        return data;
      }
      console.warn(`products.json fetch returned ${res.status}, using fallback`);
    } catch (err) {
      console.warn('Could not fetch live products.json, using fallback:', err.message);
    }
  }

  const fallback = await loadFallback();
  cache = { data: fallback, fetchedAt: now };
  return fallback;
}

/**
 * NEW — attaches the PRIVATE download link on top of a public-catalog
 * product, overriding whatever (if anything) was in the public file. If
 * downloads.json has no entry for this slug yet, downloadUrl comes back
 * null rather than falling back to anything public.
 */
async function withPrivateDownloadUrl(product) {
  if (!product) return product;
  const downloads = loadDownloads();
  return { ...product, downloadUrl: downloads[product.slug] || null };
}

/** All purchasable items (paid products + free resources) as one flat list, with public metadata only — no download links attached here (kept cheap; links are merged in per-item where actually needed, below). */
export async function getAllSellable() {
  const catalog = await getCatalog();
  return [...(catalog.products || []), ...(catalog.freeResources || [])];
}

export async function getBySlug(slug) {
  const all = await getAllSellable();
  const product = all.find((p) => p.slug === slug) || null;
  return withPrivateDownloadUrl(product);
}

/**
 * Explicit, type-safe free check. Never relies on truthiness (0 is falsy
 * but must still count as free), and coerces string prices like "0.00"
 * the same way the frontend's Vivy.isFree() does.
 */
export function isFreeProduct(product) {
  if (!product) return false;
  const raw = product.salePrice != null ? product.salePrice : product.price;
  const n = typeof raw === 'string' ? parseFloat(raw) : raw;
  return typeof n === 'number' && !isNaN(n) && n <= 0;
}

/**
 * Given a cart (array of { slug, quantity }), returns the resolved line
 * items and the total price — computed from the backend's own trusted
 * product data, never from anything the browser sends us. Every resolved
 * item's downloadUrl is the PRIVATE one from downloads.json.
 *
 * A free item can no longer silently ride along inside a paid cart — if
 * any entry resolves to a free product, resolveCart throws instead of
 * quietly adding 0 to the total.
 */
export async function resolveCart(cartItems) {
  const all = await getAllSellable();
  const downloads = loadDownloads();
  const resolved = [];
  let total = 0;
  let currency = 'USD';

  for (const entry of cartItems) {
    const publicProduct = all.find((p) => p.slug === entry.slug);
    if (!publicProduct) continue; // unknown slug — silently skip, don't trust it

    if (isFreeProduct(publicProduct)) {
      const err = new Error(`"${publicProduct.name}" is a free product and cannot go through payment.`);
      err.code = 'FREE_PRODUCT_IN_PAID_CART';
      throw err;
    }

    const product = { ...publicProduct, downloadUrl: downloads[publicProduct.slug] || null };
    const quantity = Math.max(1, Math.min(20, Number(entry.quantity) || 1));
    const unitPrice = product.salePrice != null ? product.salePrice : product.price;
    const lineTotal = unitPrice * quantity;
    total += lineTotal;
    currency = product.currency || currency;
    resolved.push({ product, quantity, unitPrice, lineTotal });
  }

  return { items: resolved, total: Math.round(total * 100) / 100, currency };
    }
