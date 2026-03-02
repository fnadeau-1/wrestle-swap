// emails.js — SendGrid email helper for Wrestle Swap
// NOTE: Change FROM_EMAIL to a sender you've verified in your SendGrid account.
// Either add it as a Single Sender or verify the full domain at:
// https://app.sendgrid.com/settings/sender_auth

const sgMail = require('@sendgrid/mail');

const FROM_EMAIL = 'noreply@wrestleswap.com';
const FROM_NAME = 'Wrestle Swap';
const SITE_URL = 'https://wrestleswap.web.app';

function init(apiKey) {
  sgMail.setApiKey(apiKey);
}

// Base HTML wrapper so all emails look consistent
function wrap(bodyHtml) {
  return `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:30px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <!-- Header -->
        <tr>
          <td style="background:#c41e3a;padding:24px 30px;text-align:center;">
            <a href="${SITE_URL}" style="text-decoration:none;">
              <span style="color:white;font-size:26px;font-weight:bold;letter-spacing:1px;">Wrestle Swap</span>
            </a>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px 40px;">
            ${bodyHtml}
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#f9f9f9;padding:20px 40px;text-align:center;border-top:1px solid #e5e5e5;">
            <p style="margin:0;color:#999;font-size:12px;">
              &copy; 2026 Wrestle Swap &nbsp;&middot;&nbsp;
              <a href="${SITE_URL}" style="color:#999;text-decoration:underline;">wrestleswap.web.app</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function btn(href, label, color = '#c41e3a') {
  return `<a href="${href}" style="display:inline-block;background:${color};color:white;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:bold;font-size:15px;margin-top:20px;">${label}</a>`;
}

function alertBox(color, borderColor, html) {
  return `<div style="background:${color};border-left:4px solid ${borderColor};padding:14px 18px;margin:20px 0;border-radius:4px;">${html}</div>`;
}

// Low-level send — never throws; logs failures so they don't break the main flow
async function send(to, subject, html) {
  if (!to) return;
  try {
    await sgMail.send({ to, from: { email: FROM_EMAIL, name: FROM_NAME }, subject, html });
    console.log(`Email sent → ${to} | ${subject}`);
  } catch (err) {
    console.error(`Email failed → ${to} | ${subject}:`, err.response ? JSON.stringify(err.response.body) : err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ORDER PLACED — notify seller
// ─────────────────────────────────────────────────────────────────────────────
async function sendOrderPlacedSeller(sellerEmail, { productName, buyerName }) {
  const html = wrap(`
    <h2 style="color:#333;margin-top:0;">You have a new order!</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      <strong>${escHtml(buyerName)}</strong> just purchased <strong>${escHtml(productName)}</strong>.
    </p>
    ${alertBox('#fff8e1', '#ffc107', `
      <strong>Ship within 14 days.</strong> If you do not ship by then, the order will be automatically
      cancelled and you will receive a strike against your seller account.
    `)}
    <p style="color:#555;font-size:14px;line-height:1.6;">
      Go to your Listings Manager to view the order details and mark the item as shipped once
      you've sent it.
    </p>
    ${btn(`${SITE_URL}/listings-manager.html`, 'View Your Listings')}
  `);
  await send(sellerEmail, `New Order: ${productName}`, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// BUYER CANCELS — notify buyer (refund confirmation)
// ─────────────────────────────────────────────────────────────────────────────
async function sendBuyerCancelledToBuyer(buyerEmail, { productName, refundAmount, cancellationFee }) {
  const html = wrap(`
    <h2 style="color:#333;margin-top:0;">Your order has been cancelled</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      Your order for <strong>${escHtml(productName)}</strong> has been cancelled as requested.
    </p>
    <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:15px;">
      <tr style="border-bottom:1px solid #e5e5e5;">
        <td style="padding:10px 4px;color:#555;">Refund amount</td>
        <td style="padding:10px 4px;text-align:right;font-weight:bold;color:#333;">$${refundAmount}</td>
      </tr>
      <tr>
        <td style="padding:10px 4px;color:#555;">Cancellation fee (5%)</td>
        <td style="padding:10px 4px;text-align:right;color:#dc3545;">-$${cancellationFee}</td>
      </tr>
    </table>
    <p style="color:#555;font-size:14px;line-height:1.6;">
      Your refund will appear on your original payment method within <strong>5–10 business days</strong>.
    </p>
    ${btn(`${SITE_URL}/search.html`, 'Continue Shopping', '#3665f3')}
  `);
  await send(buyerEmail, `Order Cancelled: ${productName}`, html);
}

// BUYER CANCELS — notify seller
async function sendBuyerCancelledToSeller(sellerEmail, { productName, buyerName }) {
  const html = wrap(`
    <h2 style="color:#333;margin-top:0;">An order has been cancelled</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      <strong>${escHtml(buyerName)}</strong> has cancelled their order for <strong>${escHtml(productName)}</strong>.
    </p>
    <p style="color:#555;font-size:14px;line-height:1.6;">
      Your item is now re-listed and available for other buyers to purchase.
    </p>
    ${btn(`${SITE_URL}/listings-manager.html`, 'View Your Listings')}
  `);
  await send(sellerEmail, `Order Cancelled by Buyer: ${productName}`, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// SELLER CANCELS — notify buyer (full refund, no fee)
// ─────────────────────────────────────────────────────────────────────────────
async function sendSellerCancelledToBuyer(buyerEmail, { productName, sellerName, refundAmount }) {
  const html = wrap(`
    <h2 style="color:#333;margin-top:0;">Your order has been cancelled by the seller</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      Unfortunately, <strong>${escHtml(sellerName)}</strong> has cancelled your order for
      <strong>${escHtml(productName)}</strong>.
    </p>
    ${alertBox('#d4edda', '#28a745', `
      <strong>Good news:</strong> Because the seller cancelled, you receive a
      <strong>full refund of $${refundAmount}</strong> — no cancellation fee applies.
    `)}
    <p style="color:#555;font-size:14px;line-height:1.6;">
      Your refund will appear on your original payment method within <strong>5–10 business days</strong>.
    </p>
    ${btn(`${SITE_URL}/search.html`, 'Find Similar Items', '#3665f3')}
  `);
  await send(buyerEmail, `Order Cancelled by Seller: ${productName}`, html);
}

// SELLER CANCELS — notify seller (strike warning)
async function sendSellerCancelledToSeller(sellerEmail, { productName, strikeCount, strikesRemaining, suspended }) {
  const subject = suspended
    ? 'Your selling account has been suspended'
    : `Strike ${strikeCount} of 3: Order Cancellation`;

  const warningBlock = suspended
    ? alertBox('#f8d7da', '#dc3545', `
        <strong>Your selling account has been suspended</strong> after ${strikeCount} cancellations.
        You can no longer list or sell items on Wrestle Swap. If you believe this is in error,
        please contact support.
      `)
    : alertBox('#fff8e1', '#ffc107', `
        <strong>Strike ${strikeCount} of 3.</strong>
        You have <strong>${strikesRemaining} strike${strikesRemaining !== 1 ? 's' : ''} remaining</strong>
        before your selling privileges are suspended.
      `);

  const html = wrap(`
    <h2 style="color:#333;margin-top:0;">Order Cancellation Notice</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      Your order for <strong>${escHtml(productName)}</strong> has been cancelled and the buyer has
      been fully refunded.
    </p>
    ${warningBlock}
    ${btn(`${SITE_URL}/listings-manager.html`, 'View Your Listings')}
  `);
  await send(sellerEmail, subject, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-CANCEL (overdue) — notify buyer
// ─────────────────────────────────────────────────────────────────────────────
async function sendOverdueCancelledToBuyer(buyerEmail, { productName, refundAmount }) {
  const html = wrap(`
    <h2 style="color:#333;margin-top:0;">Your order has been automatically cancelled</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      Your order for <strong>${escHtml(productName)}</strong> was automatically cancelled because
      the seller did not ship within 14 days.
    </p>
    ${alertBox('#d4edda', '#28a745', `
      You will receive a <strong>full refund of $${refundAmount}</strong>.
      It will appear on your original payment method within <strong>5–10 business days</strong>.
    `)}
    ${btn(`${SITE_URL}/search.html`, 'Find Similar Items', '#3665f3')}
  `);
  await send(buyerEmail, `Order Auto-Cancelled: ${productName}`, html);
}

// AUTO-CANCEL (overdue) — notify seller
async function sendOverdueCancelledToSeller(sellerEmail, { productName, strikeCount, strikesRemaining, suspended }) {
  const subject = suspended
    ? 'Your selling account has been suspended'
    : `Strike ${strikeCount} of 3: Failure to Ship`;

  const warningBlock = suspended
    ? alertBox('#f8d7da', '#dc3545', `
        <strong>Your selling account has been suspended</strong> after ${strikeCount} failures to ship.
        You can no longer list or sell items on Wrestle Swap. Contact support if you believe this is
        in error.
      `)
    : alertBox('#fff8e1', '#ffc107', `
        <strong>Strike ${strikeCount} of 3.</strong>
        You have <strong>${strikesRemaining} strike${strikesRemaining !== 1 ? 's' : ''} remaining</strong>
        before your selling privileges are suspended.
      `);

  const html = wrap(`
    <h2 style="color:#333;margin-top:0;">Failure to Ship Notice</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      Your order for <strong>${escHtml(productName)}</strong> was automatically cancelled because
      it was not shipped within 14 days. The buyer has been fully refunded.
    </p>
    ${warningBlock}
    <p style="color:#555;font-size:14px;line-height:1.6;">
      Always ship promptly and upload tracking information in your Listings Manager to avoid
      future strikes.
    </p>
    ${btn(`${SITE_URL}/listings-manager.html`, 'View Your Listings')}
  `);
  await send(sellerEmail, subject, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// SHIPPING LABEL CREATED — notify buyer with tracking info
// ─────────────────────────────────────────────────────────────────────────────
async function sendTrackingToBuyer(buyerEmail, { productName, trackingNumber, trackingUrl, carrier }) {
  const trackingBlock = trackingUrl
    ? `<a href="${trackingUrl}" style="color:#3665f3;word-break:break-all;">${escHtml(trackingNumber)}</a>`
    : `<strong>${escHtml(trackingNumber)}</strong>`;

  const html = wrap(`
    <h2 style="color:#333;margin-top:0;">Your order has shipped!</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      <strong>${escHtml(productName)}</strong> is on its way.
    </p>
    ${alertBox('#e3f2fd', '#2196f3', `
      <strong>Tracking Number:</strong> ${trackingBlock}<br>
      ${carrier ? `<strong>Carrier:</strong> ${escHtml(carrier)}` : ''}
    `)}
    ${btn(`${SITE_URL}/my-orders.html`, 'View Your Orders', '#3665f3')}
  `);
  await send(buyerEmail, `Your Order Has Shipped: ${productName}`, html);
}

// Minimal HTML escape to prevent injection in email templates
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  init,
  sendOrderPlacedSeller,
  sendBuyerCancelledToBuyer,
  sendBuyerCancelledToSeller,
  sendSellerCancelledToBuyer,
  sendSellerCancelledToSeller,
  sendOverdueCancelledToBuyer,
  sendOverdueCancelledToSeller,
  sendTrackingToBuyer,
};
