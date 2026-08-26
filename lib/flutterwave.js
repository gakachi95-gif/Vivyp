/**
 * lib/flutterwave.js
 *
 * Verifies a transaction directly with Flutterwave's API using the SECRET
 * key. This is the step that actually matters for security: anything the
 * browser tells us about a payment ("it succeeded!") is just a claim. Only
 * this server-to-server call, authenticated with a secret key an attacker
 * can't see, tells us whether Flutterwave itself considers the payment real.
 */

const FLW_API_BASE = 'https://api.flutterwave.com/v3';

export async function verifyTransaction(transactionId) {
  const secretKey = process.env.FLW_SECRET_KEY;
  if (!secretKey || secretKey.includes('replace-with')) {
    throw new Error('FLW_SECRET_KEY is not configured on the server.');
  }

  const res = await fetch(`${FLW_API_BASE}/transactions/${transactionId}/verify`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Flutterwave verify request failed (${res.status}): ${text}`);
  }

  const body = await res.json();
  return body; // { status: 'success', data: { status, amount, currency, tx_ref, ... } }
}

/**
 * Checks that a verified transaction actually matches what we expect for
 * this order: successful status, matching reference, and an amount that is
 * at least the total we independently calculated from trusted product data.
 */
export function transactionMatchesOrder(verifyResponse, expected) {
  const tx = verifyResponse && verifyResponse.data;
  if (!tx) return { ok: false, reason: 'No transaction data returned by Flutterwave.' };
  if (verifyResponse.status !== 'success' || tx.status !== 'successful') {
    return { ok: false, reason: `Transaction status is "${tx.status}", not successful.` };
  }
  if (tx.tx_ref !== expected.txRef) {
    return { ok: false, reason: 'Transaction reference does not match this order.' };
  }
  if ((tx.currency || '').toUpperCase() !== expected.currency.toUpperCase()) {
    return { ok: false, reason: 'Currency mismatch.' };
  }
  // Small epsilon for floating point currency math.
  if (tx.amount < expected.total - 0.01) {
    return { ok: false, reason: `Amount paid (${tx.amount}) is less than order total (${expected.total}).` };
  }
  return { ok: true };
}
