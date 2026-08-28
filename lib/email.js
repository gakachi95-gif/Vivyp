/**
 * lib/email.js
 *
 * Sends the "here's your download" email via Resend (https://resend.com).
 * Uses a plain fetch call to their API instead of an SDK, to keep
 * dependencies minimal. Swap this file out if you'd rather use a different
 * provider (SendGrid, Postmark, etc.) — nothing else in the project needs
 * to change as long as sendDeliveryEmail() keeps the same shape.
 */

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function sendDeliveryEmail({ to, name, items }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;

  if (!apiKey || apiKey.includes('replace_with') || !from) {
    console.warn('RESEND_API_KEY / RESEND_FROM_EMAIL not configured — skipping email send.');
    return { sent: false, reason: 'Email is not configured on the server yet.' };
  }

  const itemsHtml = items
    .map(
      (i) => `<li style="margin-bottom:10px;">
        <strong>${escapeHtml(i.product.name)}</strong><br>
        <a href="${escapeHtml(i.product.downloadUrl)}">Download link</a>
      </li>`
    )
    .join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;">
      <h2 style="color:#14121F;">Thanks for your order${name ? ', ' + escapeHtml(name) : ''}!</h2>
      <p>Here's instant access to what you purchased from Vivy:</p>
      <ul style="padding-left:18px;">${itemsHtml}</ul>
      <p style="color:#6B6A78;font-size:13px;">If a link doesn't work, just reply to this email and we'll help you out.</p>
    </div>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to,
      subject: 'Your Vivy order is ready',
      html,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('Resend send failed:', res.status, text);
    return { sent: false, reason: `Email provider returned ${res.status}` };
  }

  return { sent: true };
    }
