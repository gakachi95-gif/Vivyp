/**
 * lib/products/**
 * lib/products.js
 *
 * (Unchanged from your original except where marked below.)
 *
 * The backend needs to know each product's real price and download link so
 * it never has to trust the frontend for either. Rather than duplicating
 * product data by hand, it fetches the SAME data/products.json your Vivy
 * site already uses (set PRODUCTS_JSON_URL in .env), and caches it for a
 * few minutes. If that fetch fails for any reason, it falls back to the
 * bundled products.fallback.json snapshot so the store doesn't go down —
 * just remember to update that snapshot occasionally if you rely on it.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FALLBACK_PATH = path.join(__dirname, '..', 'products.fallback.json');
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cache = { data: null, fetchedAt: 0 };

async function loadFallback() {
  const raw = await fs.readFile(FALLBACK_PATH, 'utf-8');
  return JSON.parse(raw);
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

/** All purchasable items (paid products + free resources) as one flat list. */
export async function getAllSellable() {
  const catalog = await getCatalog();
  return [...(catalog.products || []), ...(catalog.freeResources || [])];
}

export async function getBySlug(slug) {
  const all = await getAllSellable();
  return all.find((p) => p.slug === slug) || null;
}

/**
 * NEW — explicit, type-safe free check. Never relies on truthiness (0 is
 * falsy but must still count as free), and coerces string prices like
 * "0.00" the same way the frontend's Vivy.isFree() does, so the two stay
 * in agreement no matter where a product's data ultimately comes from.
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
 * product data, never from anything the browser sends us.
 *
 * CHANGED: a free item can no longer silently ride along inside a paid
 * cart. If any entry resolves to a free product, resolveCart throws
 * instead of quietly adding 0 to the total — this is what stops a
 * leftover paid item + a free item from ever being verified/paid for as
 * a bundle (the root cause of the earlier "$32 for a free product" bug,
 * enforced here independently of whatever the frontend does).
 */
export async function resolveCart(cartItems) {
  const all = await getAllSellable();
  const resolved = [];
  let total = 0;
  let currency = 'USD';

  for (const entry of cartItems) {
    const product = all.find((p) => p.slug === entry.slug);
    if (!product) continue; // unknown slug — silently skip, don't trust it

    if (isFreeProduct(product)) {
      const err = new Error(`"${product.name}" is a free product and cannot go through payment.`);
      err.code = 'FREE_PRODUCT_IN_PAID_CART';
      throw err;
    }

    const quantity = Math.max(1, Math.min(20, Number(entry.quantity) || 1));
    const unitPrice = product.salePrice != null ? product.salePrice : product.price;
    const lineTotal = unitPrice * quantity;
    total += lineTotal;
    currency = product.currency || currency;
    resolved.push({ product, quantity, unitPrice, lineTotal });
  }

  return { items: resolved, total: Math.round(total * 100) / 100, currency };
}￼Enter
