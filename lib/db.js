/**
 * lib/db.js
 *
 * Persistent product storage. Uses Render's managed Postgres — when you
 * attach a Render Postgres instance to this web service, Render injects
 * DATABASE_URL automatically, nothing to hardcode.
 *
 * This is now the PRIMARY source of truth for products (see the change
 * to getCatalog() in lib/products.js): your old PRODUCTS_JSON_URL /
 * products.fallback.json chain becomes a fallback for when the database
 * is briefly unreachable, plus the one-time import source for whatever
 * was already live (see importProducts() below, called from the admin's
 * "Import existing products" button).
 */
import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : undefined,
});

/** Call once on server startup. Safe every boot — uses IF NOT EXISTS. */
export async function migrate() {
  if (!process.env.DATABASE_URL) {
    console.warn('DATABASE_URL is not set — product storage will not work until it is.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      short_description TEXT DEFAULT '',
      description TEXT DEFAULT '',
      price NUMERIC(12,2) NOT NULL DEFAULT 0,
      sale_price NUMERIC(12,2),
      currency TEXT NOT NULL DEFAULT 'NGN',
      category TEXT DEFAULT '',
      image TEXT DEFAULT '',
      file_key TEXT,                 -- private object-storage key for the PDF; never a public URL
      features JSONB DEFAULT '[]',
      whats_included JSONB DEFAULT '[]',
      featured BOOLEAN DEFAULT false,
      best_seller BOOLEAN DEFAULT false,
      new_product BOOLEAN DEFAULT false,
      rating NUMERIC(3,2) DEFAULT 0,
      review_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT ''
    );
  `);
}

function toPublicProduct(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    shortDescription: row.short_description,
    description: row.description,
    price: Number(row.price),
    salePrice: row.sale_price != null ? Number(row.sale_price) : null,
    currency: row.currency,
    category: row.category,
    image: row.image,
    fileKey: row.file_key,
    features: row.features || [],
    whatsIncluded: row.whats_included || [],
    featured: row.featured,
    bestSeller: row.best_seller,
    newProduct: row.new_product,
    rating: Number(row.rating) || 0,
    reviewCount: row.review_count || 0,
  };
}

export async function getAllProducts() {
  const { rows } = await pool.query('SELECT * FROM products ORDER BY created_at DESC');
  return rows.map(toPublicProduct);
}

export async function getAllCategories() {
  const { rows } = await pool.query('SELECT * FROM categories ORDER BY name');
  return rows;
}

export async function getProductBySlugFromDb(slug) {
  const { rows } = await pool.query('SELECT * FROM products WHERE slug = $1', [slug]);
  return rows[0] ? toPublicProduct(rows[0]) : null;
}

export async function getProductByIdFromDb(id) {
  const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
  return rows[0] ? toPublicProduct(rows[0]) : null;
}

export async function createProduct(p) {
  const { rows } = await pool.query(
    `INSERT INTO products
      (slug,name,short_description,description,price,sale_price,currency,category,image,file_key,features,whats_included,featured,best_seller,new_product)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *`,
    [p.slug, p.name, p.shortDescription || '', p.description || '', p.price || 0, p.salePrice,
     p.currency || 'NGN', p.category || '', p.image || '', p.fileKey || null,
     JSON.stringify(p.features || []), JSON.stringify(p.whatsIncluded || []),
     !!p.featured, !!p.bestSeller, !!p.newProduct]
  );
  return toPublicProduct(rows[0]);
}

export async function updateProduct(id, patch) {
  const existing = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
  if (!existing.rows[0]) return null;
  const cur = existing.rows[0];
  const merged = {
    name: patch.name ?? cur.name,
    short_description: patch.shortDescription ?? cur.short_description,
    description: patch.description ?? cur.description,
    price: patch.price ?? cur.price,
    sale_price: patch.salePrice !== undefined ? patch.salePrice : cur.sale_price,
    currency: patch.currency ?? cur.currency,
    category: patch.category ?? cur.category,
    image: patch.image ?? cur.image,
    file_key: patch.fileKey !== undefined ? patch.fileKey : cur.file_key,
    features: patch.features ? JSON.stringify(patch.features) : cur.features,
    whats_included: patch.whatsIncluded ? JSON.stringify(patch.whatsIncluded) : cur.whats_included,
    featured: patch.featured !== undefined ? patch.featured : cur.featured,
    best_seller: patch.bestSeller !== undefined ? patch.bestSeller : cur.best_seller,
    new_product: patch.newProduct !== undefined ? patch.newProduct : cur.new_product,
  };
  const { rows } = await pool.query(
    `UPDATE products SET name=$1, short_description=$2, description=$3, price=$4, sale_price=$5,
       currency=$6, category=$7, image=$8, file_key=$9, features=$10, whats_included=$11,
       featured=$12, best_seller=$13, new_product=$14, updated_at=now()
     WHERE id=$15 RETURNING *`,
    [merged.name, merged.short_description, merged.description, merged.price, merged.sale_price,
     merged.currency, merged.category, merged.image, merged.file_key, merged.features, merged.whats_included,
     merged.featured, merged.best_seller, merged.new_product, id]
  );
  return toPublicProduct(rows[0]);
}

export async function deleteProduct(id) {
  const { rows } = await pool.query('DELETE FROM products WHERE id = $1 RETURNING file_key', [id]);
  return rows[0] || null;
}

export async function upsertCategory(cat) {
  await pool.query(
    `INSERT INTO categories (id, name, description) VALUES ($1,$2,$3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [cat.id, cat.name, cat.description || '']
  );
}

/**
 * One-time migration from the old public data/products.json shape (or the
 * repo's products.fallback.json) into the database. Skips any slug that
 * already exists — safe to click more than once.
 */
export async function importProducts(products = [], categories = []) {
  for (const c of categories) {
    if (c.id) await upsertCategory(c);
  }
  let imported = 0;
  for (const p of products) {
    if (!p.slug) continue;
    const existing = await getProductBySlugFromDb(p.slug);
    if (existing) continue;
    await createProduct({
      slug: p.slug, name: p.name, shortDescription: p.shortDescription, description: p.description,
      price: p.price, salePrice: p.salePrice, currency: p.currency || 'NGN', category: p.category,
      image: p.image, features: p.features, whatsIncluded: p.whatsIncluded,
      featured: p.featured, bestSeller: p.bestSeller, newProduct: p.newProduct,
      // fileKey intentionally left blank — old products' download links stay
      // served from the DOWNLOADS_JSON env var (see lib/products.js) until
      // you re-upload each one's PDF from the admin Edit screen, at which
      // point it moves to private object storage and DOWNLOADS_JSON is no
      // longer needed for that product.
    });
    imported++;
  }
  return imported;
}

export { pool };
