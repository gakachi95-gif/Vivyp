/**
 * server.js
 *
 * The Vivy payment backend. Deployed on its own (e.g. on Render), separate
 * from the static Vivy site. Its one job: never let the browser decide that
 * a payment succeeded. It re-checks every payment with Flutterwave directly,
 * using a secret key that only lives here.
 *
 * Endpoints:
 *   GET  /                     health check
 *   POST /verify-payment       called by checkout.html right after the
 *                               Flutterwave popup closes
 *   POST /webhook/flutterwave  backup path — Flutterwave calls this on its
 *                               own even if the customer closes the tab
 *                               right after paying
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';

import { resolveCart, getBySlug } from './lib/products.js';
import { verifyTransaction, transactionMatchesOrder } from './lib/flutterwave.js';
import { sendDeliveryEmail } from './lib/email.js';

const app = express();
app.use(express.json());

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow tools with no origin (curl, health checks) and any configured origin.
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
  })
);

// In-memory de-dupe so a retried request doesn't re-email/re-fulfil the same
// order twice. NOTE: this resets if the server restarts or sleeps (Render's
// free tier does this after inactivity). For higher volume, swap this for a
// small database (e.g. free Postgres on Render or Supabase) — see README.
const processedTransactions = new Set();

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'vivy-backend' });
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

    // 1. Work out what this order SHOULD cost, from our own trusted product data.
    const { items: resolvedItems, total, currency } = await resolveCart(items);
    if (!resolvedItems.length) {
      return res.status(400).json({ verified: false, reason: 'No valid products in this order.' });
    }

    // 2. Ask Flutterwave directly whether this transaction really happened.
    const verifyResponse = await verifyTransaction(transaction_id);
    const check = transactionMatchesOrder(verifyResponse, { txRef: tx_ref, total, currency });

    if (!check.ok) {
      return res.status(400).json({ verified: false, reason: check.reason });
    }

    // 3. Payment is confirmed — send the real download links by email.
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

/**
 * Backup delivery path. Configure this exact URL in the Flutterwave
 * dashboard under Settings -> Webhooks, and set the same secret string as
 * FLW_WEBHOOK_HASH here and as the "Secret hash" there. This covers the case
 * where a customer pays but closes the browser tab before /verify-payment
 * gets a chance to run.
 *
 * It recovers what was actually purchased from the transaction's "meta"
 * field (checkout.html sends the cart as meta.vivy_cart when it opens the
 * Flutterwave popup), which Flutterwave echoes back on both the verify
 * response and the webhook event — so this path can send the same delivery
 * email /verify-payment does, without ever trusting the webhook body alone.
 */
app.post('/webhook/flutterwave', express.json(), async (req, res) => {
  try {
    const signature = req.headers['verif-hash'];
    const expected = process.env.FLW_WEBHOOK_HASH;
    if (!expected || !signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return res.status(401).json({ received: false });
    }

    const event = req.body;
    const txId = event && event.data && event.data.id;
    if (!txId) {
      return res.status(200).json({ received: true });
    }
    if (processedTransactions.has(String(txId))) {
      return res.status(200).json({ received: true, reason: 'Already processed.' });
    }

    // Never trust the webhook body alone — re-verify directly with
    // Flutterwave using the secret key, same as /verify-payment does.
    const verifyResponse = await verifyTransaction(txId);
    const tx = verifyResponse.data;
    if (verifyResponse.status !== 'success' || !tx || tx.status !== 'successful') {
      return res.status(200).json({ received: true });
    }

    // Recover the cart from meta so we know what to actually deliver.
    let cartItems = [];
    try {
      const rawCart = (tx.meta && tx.meta.vivy_cart) || (event.data.meta && event.data.meta.vivy_cart);
      if (rawCart) cartItems = JSON.parse(rawCart);
    } catch (err) {
      console.warn(`Webhook: could not parse cart meta for transaction ${txId}:`, err.message);
    }

    if (!Array.isArray(cartItems) || !cartItems.length) {
      console.warn(`Webhook: transaction ${txId} verified but had no recoverable cart — nothing to deliver.`);
      processedTransactions.add(String(txId));
      return res.status(200).json({ received: true });
    }

    const { items: resolvedItems, total, currency } = await resolveCart(cartItems);
    if (!resolvedItems.length) {
      processedTransactions.add(String(txId));
      return res.status(200).json({ received: true });
    }

    // Sanity check the amount before delivering anything, same as the main path.
    const currencyMatches = (tx.currency || '').toUpperCase() === currency.toUpperCase();
    if (!currencyMatches || tx.amount < total - 0.01) {
      console.warn(`Webhook: transaction ${txId} amount/currency didn't match expected order — skipping delivery.`);
      processedTransactions.add(String(txId));
      return res.status(200).json({ received: true });
    }

    const email = tx.customer && tx.customer.email;
    const name = tx.customer && tx.customer.name;
    if (email) {
      await sendDeliveryEmail({ to: email, name, items: resolvedItems });
    } else {
      console.warn(`Webhook: transaction ${txId} had no customer email — could not send delivery email.`);
    }

    processedTransactions.add(String(txId));
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('webhook error:', err);
    return res.status(200).json({ received: true }); // ack anyway so Flutterwave doesn't retry forever
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Vivy backend listening on port ${port}`);
});
