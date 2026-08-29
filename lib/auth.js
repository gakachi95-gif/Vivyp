/**
 * lib/auth.js
 *
 * Single-owner admin login. There is exactly one admin (you) — your
 * username/password never live in code, only as Render environment
 * variables:
 *
 *   ADMIN_USERNAME        the username you'll type into admin.html
 *   ADMIN_PASSWORD_HASH   a bcrypt hash of your real password — NEVER the
 *                          plain password itself (see the hash generator
 *                          delivered alongside this file)
 *   JWT_SECRET             a random string used to sign session tokens
 *                          (a ready-to-use one is included in this delivery)
 *
 * A successful login returns a signed token, valid 12 hours, that
 * admin.js then sends back as `Authorization: Bearer <token>` on every
 * /api/admin/* call. Nothing here is guessable or stored in the frontend.
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const TOKEN_TTL = '12h';

export async function login(username, password) {
  const expectedUser = process.env.ADMIN_USERNAME;
  const expectedHash = process.env.ADMIN_PASSWORD_HASH;
  if (!expectedUser || !expectedHash || !process.env.JWT_SECRET) {
    const err = new Error('Admin login is not configured on the server yet.');
    err.status = 500;
    throw err;
  }
  if (username !== expectedUser) {
    const err = new Error('Incorrect username or password.');
    err.status = 401;
    throw err;
  }
  const ok = await bcrypt.compare(password, expectedHash);
  if (!ok) {
    const err = new Error('Incorrect username or password.');
    err.status = 401;
    throw err;
  }
  return jwt.sign({ sub: username, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: TOKEN_TTL });
}

/** Express middleware — mount on every /api/admin/* route except /api/admin/login. */
export function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Session expired. Please log in again.' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'admin') throw new Error('not admin');
    req.admin = payload;
    next();
  } catch (e) {
    return res.status(401).json({ message: 'Session expired. Please log in again.' });
  }
}
