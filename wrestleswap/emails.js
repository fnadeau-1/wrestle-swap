// emails.js — SendGrid email helper for GrappleTrade
// NOTE: Change FROM_EMAIL to a sender you've verified in your SendGrid account.
// Either add it as a Single Sender or verify the full domain at:
// https://app.sendgrid.com/settings/sender_auth

const sgMail = require('@sendgrid/mail');

const FROM_EMAIL = 'noreply@grappletrade.com';
const FROM_NAME = 'GrappleTrade';
const SITE_URL = 'https://grappletrade.com';

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
              <span style="color:white;font-size:26px;font-weight:bold;letter-spacing:1px;">GrappleTrade</span>
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
              &copy; 2026 GrappleTrade &nbsp;&middot;&nbsp;
              <a href="${SITE_URL}" style="color:#999;text-decoration:underline;">grappletrade.com</a>
            </p>
            <p style="font-size:11px;color:#999;margin-top:8px;margin-bottom:0;">To unsubscribe from order notifications, <a href="${SITE_URL}/settings.html" style="color:#999;text-decoration:underline;">manage your preferences</a>.</p>
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
    console.log(`Email sent | ${subject}`);
  } catch (err) {
    console.error(`Email failed | ${subject}:`, err.response ? JSON.stringify(err.response.body) : err.message);
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
      <strong>Ship within 10 days.</strong> If you do not ship by then, the order will be automatically
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
        You can no longer list or sell items on GrappleTrade. If you believe this is in error,
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
// ORDER PLACED — notify buyer
// ─────────────────────────────────────────────────────────────────────────────
async function sendOrderPlacedBuyer(buyerEmail, { productName, orderId, sellerName }) {
  const html = wrap(`
    <h2 style="color:#333;margin-top:0;">Your order is confirmed!</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      Thanks for your purchase! <strong>${escHtml(productName)}</strong> is on its way soon.
    </p>
    ${alertBox('#d4edda', '#28a745', `
      <strong>Order ID:</strong> ${escHtml(orderId)}<br>
      <strong>Sold by:</strong> ${escHtml(sellerName)}<br>
      The seller has up to <strong>10 days</strong> to ship. You will receive a tracking email once it ships.
    `)}
    <p style="color:#555;font-size:14px;line-height:1.6;">
      You can view your order or cancel it (subject to a 5% fee) from your Orders page.
    </p>
    ${btn(`${SITE_URL}/my-orders.html`, 'View Your Orders', '#3665f3')}
  `);
  await send(buyerEmail, `Order Confirmed: ${productName}`, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-CANCEL (overdue) — notify buyer
// ─────────────────────────────────────────────────────────────────────────────
async function sendOverdueCancelledToBuyer(buyerEmail, { productName, refundAmount }) {
  const html = wrap(`
    <h2 style="color:#333;margin-top:0;">Your order has been automatically cancelled</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      Your order for <strong>${escHtml(productName)}</strong> was automatically cancelled because
      the seller did not ship within 10 days.
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
        You can no longer list or sell items on GrappleTrade. Contact support if you believe this is
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
      it was not shipped within 10 days. The buyer has been fully refunded.
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

// ─────────────────────────────────────────────────────────────────────────────
// DELIVERY CONFIRMED — notify buyer
// ─────────────────────────────────────────────────────────────────────────────
async function sendDeliveryConfirmedToBuyer(buyerEmail, { productName, sellerName }) {
  const html = wrap(`
    <h2 style="color:#333;margin-top:0;">Your order has been delivered!</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      We've marked your order for <strong>${escHtml(productName)}</strong> as delivered.
      Thanks for shopping on GrappleTrade!
    </p>
    ${alertBox('#d4edda', '#28a745', `
      <strong>How was your experience?</strong> You can now leave a review for
      <strong>${escHtml(sellerName)}</strong> from your Orders page.
    `)}
    ${btn(`${SITE_URL}/my-orders.html`, 'Leave a Review', '#3665f3')}
  `);
  await send(buyerEmail, `Delivered: ${productName}`, html);
}

// DELIVERY CONFIRMED — notify seller
async function sendDeliveryConfirmedToSeller(sellerEmail, { productName, buyerName }) {
  const html = wrap(`
    <h2 style="color:#333;margin-top:0;">Your item has been delivered!</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      <strong>${escHtml(buyerName)}</strong> has confirmed delivery of
      <strong>${escHtml(productName)}</strong>. The transaction is now complete.
    </p>
    ${alertBox('#d4edda', '#28a745', `
      <strong>Payment has been processed.</strong> Funds from this sale have been transferred
      to your connected account.
    `)}
    ${btn(`${SITE_URL}/listings-manager.html`, 'View Your Listings')}
  `);
  await send(sellerEmail, `Delivery Confirmed: ${productName}`, html);
}

// Minimal HTML escape to prevent injection in email templates
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-RELEASE WARNING — buyer has 24h to dispute before funds release to seller
// ─────────────────────────────────────────────────────────────────────────────
async function sendAutoReleaseWarning(buyerEmail, { productName, hoursRemaining, productUrl }) {
  const html = wrap(`
    <h2 style="color:#333;margin-top:0;">Your order will auto-complete soon</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      Your order for <strong>${escHtml(productName)}</strong> will automatically complete and
      payment will be released to the seller in <strong>${hoursRemaining} hours</strong>.
    </p>
    ${alertBox('#fff3cd', '#e6a817', `
      <strong>Is something wrong?</strong> If you have not received this item or there is an issue,
      please report a problem <strong>before the timer expires</strong>. Once released, refunds
      require seller cooperation or admin review.
    `)}
    <p style="color:#555;font-size:14px;line-height:1.6;">
      If everything is fine, no action is needed — the transaction will complete automatically.
    </p>
    ${btn(productUrl || `${SITE_URL}/my-orders.html`, 'View Order & Report a Problem', '#c41e3a')}
  `);
  await send(buyerEmail, `Action needed: "${productName}" auto-completes in ${hoursRemaining}h`, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-RELEASED: BUYER — transaction completed automatically
// ─────────────────────────────────────────────────────────────────────────────
async function sendAutoReleasedBuyer(buyerEmail, { productName }) {
  const html = wrap(`
    <h2 style="color:#333;margin-top:0;">Your order has been completed</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      Your order for <strong>${escHtml(productName)}</strong> has been automatically marked as
      complete and payment has been released to the seller.
    </p>
    <p style="color:#555;font-size:14px;line-height:1.6;">
      We hope you enjoy your purchase! If you have any concerns, please contact our support team.
    </p>
    ${btn(`${SITE_URL}/my-orders.html`, 'View Your Orders', '#3665f3')}
  `);
  await send(buyerEmail, `Order completed: ${productName}`, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-RELEASED: SELLER — payment on its way
// ─────────────────────────────────────────────────────────────────────────────
async function sendAutoReleasedSeller(sellerEmail, { productName, amountDollars }) {
  const html = wrap(`
    <h2 style="color:#333;margin-top:0;">Payment released!</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      The order for <strong>${escHtml(productName)}</strong> has been automatically completed.
    </p>
    ${alertBox('#d4edda', '#28a745', `
      <strong>$${amountDollars}</strong> has been transferred to your payout account and will
      arrive within your Stripe payout schedule (typically 2 business days).
    `)}
    ${btn(`${SITE_URL}/listings-manager.html`, 'View Your Listings')}
  `);
  await send(sellerEmail, `Payment released: ${productName}`, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-RELEASE FAILED — notify admin for manual intervention
// ─────────────────────────────────────────────────────────────────────────────
async function sendAutoReleaseFailedAdmin(adminEmail, { productId, productName, errorMessage }) {
  const html = wrap(`
    <h2 style="color:#333;margin-top:0;">Auto-release payout failed — manual review required</h2>
    ${alertBox('#f8d7da', '#dc3545', `
      <strong>Product ID:</strong> ${escHtml(productId)}<br>
      <strong>Product:</strong> ${escHtml(productName)}<br>
      <strong>Error:</strong> ${escHtml(errorMessage)}
    `)}
    <p style="color:#555;font-size:14px;line-height:1.6;">
      The payout lock has been cleared and the scheduler will retry on the next run.
      If the issue persists, manually issue the transfer from the Stripe dashboard or
      use the admin refund tool.
    </p>
  `);
  await send(adminEmail, `[ACTION REQUIRED] Auto-release failed: ${productName}`, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// SHIP REMINDER — warn seller at day 7 (3 days before auto-cancel)
// ─────────────────────────────────────────────────────────────────────────────
async function sendShipReminder(sellerEmail, { productName, daysSinceSale }) {
  const html = wrap(`
    <h2 style="color:#333;margin-top:0;">Reminder: Ship your item soon</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      Your order for <strong>${escHtml(productName)}</strong> was placed
      <strong>${daysSinceSale} day${daysSinceSale !== 1 ? 's' : ''} ago</strong> and has not been shipped yet.
    </p>
    ${alertBox('#fff3cd', '#e6a817', `
      <strong>Action required:</strong> Orders not shipped within <strong>10 days</strong> are automatically
      cancelled and you receive a seller strike. You have <strong>${10 - daysSinceSale} day${10 - daysSinceSale !== 1 ? 's' : ''} remaining</strong>.
    `)}
    <p style="color:#555;font-size:14px;line-height:1.6;">
      Go to your Listings Manager to purchase a shipping label or enter a tracking number if you've already shipped.
    </p>
    ${btn(`${SITE_URL}/seller-order-fulfillment.html`, 'Ship Your Item Now')}
  `);
  await send(sellerEmail, `Action Required: Ship "${productName}" within ${10 - daysSinceSale} days`, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE NOTIFICATION — notify recipient of a new message
// ─────────────────────────────────────────────────────────────────────────────
async function sendMessageNotification(toEmail, { senderName, messagePreview, conversationUrl }) {
  const html = wrap(`
    <h2 style="color:#333;margin-top:0;">You have a new message</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      <strong>${escHtml(senderName)}</strong> sent you a message on GrappleTrade:
    </p>
    ${alertBox('#f0f4ff', '#3665f3', `
      <em style="color:#333;">"${escHtml(messagePreview)}"</em>
    `)}
    ${btn(conversationUrl || `${SITE_URL}/messages.html`, 'Reply Now', '#3665f3')}
    <p style="color:#999;font-size:12px;margin-top:20px;">
      You're receiving this because someone messaged you on GrappleTrade. To stop these emails, update your notification settings.
    </p>
  `);
  await send(toEmail, `New message from ${senderName}`, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// WATCHLIST ITEM SOLD — notify watcher when a watched item sells
// ─────────────────────────────────────────────────────────────────────────────
async function sendWatchlistItemSold(watcherEmail, { productName, category }) {
  const html = wrap(`
    <h2 style="color:#333;margin-top:0;">An item on your watchlist just sold</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      <strong>${escHtml(productName)}</strong> — which you had saved to your watchlist — has been sold.
    </p>
    <p style="color:#555;font-size:14px;line-height:1.6;">
      Similar items may be available. Browse the marketplace to find another one.
    </p>
    ${btn(`${SITE_URL}/search.html${category ? '?category=' + encodeURIComponent(category) : ''}`, 'Find Similar Items', '#3665f3')}
  `);
  await send(watcherEmail, `Watchlist item sold: ${productName}`, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// ABANDONED CART — follow up 24h after checkout was started but not completed
// ─────────────────────────────────────────────────────────────────────────────
async function sendAbandonedCart(buyerEmail, { productName, productUrl, price }) {
  const html = wrap(`
    <h2 style="color:#333;margin-top:0;">You left something behind</h2>
    <p style="color:#555;font-size:15px;line-height:1.6;">
      You were checking out <strong>${escHtml(productName)}</strong> but didn't complete your purchase.
    </p>
    ${alertBox('#fff8e1', '#ffc107', `
      <strong>This item is still available</strong> — but marketplace items sell fast. Complete your checkout to secure it.
    `)}
    <p style="color:#555;font-size:14px;line-height:1.6;">
      Listed at <strong>$${parseFloat(price || 0).toFixed(2)}</strong>
    </p>
    ${btn(productUrl || `${SITE_URL}/search.html`, 'Complete Your Purchase')}
    <p style="color:#999;font-size:12px;margin-top:20px;">
      You're receiving this because you started checkout on GrappleTrade. If you no longer need this item, simply ignore this email.
    </p>
  `);
  await send(buyerEmail, `Still interested in ${productName}?`, html);
}

module.exports = {
  init,
  sendOrderPlacedBuyer,
  sendOrderPlacedSeller,
  sendBuyerCancelledToBuyer,
  sendBuyerCancelledToSeller,
  sendSellerCancelledToBuyer,
  sendSellerCancelledToSeller,
  sendOverdueCancelledToBuyer,
  sendOverdueCancelledToSeller,
  sendTrackingToBuyer,
  sendDeliveryConfirmedToBuyer,
  sendDeliveryConfirmedToSeller,
  sendShipReminder,
  sendMessageNotification,
  sendWatchlistItemSold,
  sendAbandonedCart,
  sendAutoReleaseWarning,
  sendAutoReleasedBuyer,
  sendAutoReleasedSeller,
  sendAutoReleaseFailedAdmin,
};
