const {
  buildEmailLayout,
  TRUSTPILOT_REVIEW_LINK,
  BLACKLISTED_LEGAL_HTML,
} = require('./emailHtml');

const SHIPPING_LABEL_EMAIL_HTML = buildEmailLayout({
  title: 'Your Shipping Label is Ready!',
  bodyHtml: `
    <p>Hi **CUSTOMER_NAME**,</p>
    <p>Your prepaid shipping label for order <strong>#**ORDER_ID**</strong> is ready.</p>
    <div style="text-align:center; margin:28px 0 24px;">
      <a href="**LABEL_DOWNLOAD_LINK**" class="button-link">Download Shipping Label</a>
    </div>
    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:14px; padding:16px 18px; margin-bottom:20px;">
      <p style="margin:0;"><strong>Tracking Number</strong><br><span style="color:#2563eb; font-weight:700;">**TRACKING_NUMBER**</span></p>
    </div>
    <p>Please print the label, attach it to your package, and drop it off at any USPS location.</p>
  `,
});

const SHIPPING_KIT_EMAIL_HTML = buildEmailLayout({
  title: 'Your Shipping Kit Is on the Way',
  bodyHtml: `
    <p>Hi **CUSTOMER_NAME**,</p>
    <p>Your shipping kit for order <strong>#**ORDER_ID**</strong> has shipped.</p>
    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:14px; padding:16px 18px; margin:20px 0;">
      <p style="margin:0;"><strong>Tracking Number</strong><br><span style="color:#2563eb; font-weight:700;">**TRACKING_NUMBER**</span></p>
    </div>
    <p>Once it arrives, place your device inside and use the included return label to send it back.</p>
  `,
});

const ORDER_RECEIVED_EMAIL_HTML = buildEmailLayout({
  title: 'Order Received',
  bodyHtml: `
    <p>Hi **CUSTOMER_NAME**,</p>
    <p>Thanks for choosing SecondHandCell. We received your order for <strong>**DEVICE_NAME**</strong>.</p>
    <p>Your order ID is <strong style="color:#2563eb;">#**ORDER_ID**</strong>.</p>
    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:14px; padding:18px 20px; margin:24px 0; color:#334155;">
      <p style="margin:0 0 10px;"><strong>Before shipping your device:</strong></p>
      <ul style="padding-left:20px; margin:0;">
        <li>Back up your data.</li>
        <li>Factory reset the device.</li>
        <li>Remove iCloud/Google/Samsung accounts.</li>
        <li>Remove your SIM card.</li>
      </ul>
    </div>
    **SHIPPING_INSTRUCTION**
  `,
});

const DEVICE_RECEIVED_EMAIL_HTML = buildEmailLayout({
  title: 'Your Device Has Arrived',
  bodyHtml: `
    <p>Hi **CUSTOMER_NAME**,</p>
    <p>We received your device for order <strong>#**ORDER_ID**</strong>.</p>
    <p>Your device is now in our inspection queue. We’ll follow up with your final offer soon.</p>
  `,
});

const BLACKLISTED_EMAIL_HTML = buildEmailLayout({
  title: 'Action Required: Carrier Blacklist Detected',
  accentColor: '#dc2626',
  includeTrustpilot: false,
  includeCountdownNotice: true,
  bodyHtml: `
    <p>Hi **CUSTOMER_NAME**,</p>
    <p>Our carrier check for order <strong>#**ORDER_ID**</strong> flagged the device as lost, stolen, or blacklisted.</p>
    <p>We can’t release payment while that status is active. Please contact your carrier and reply once it has been removed.</p>
    <div style="margin-top:16px; color:#b91c1c; font-size:15px; line-height:1.7;">${BLACKLISTED_LEGAL_HTML}</div>
  `,
});

const FMI_EMAIL_HTML = buildEmailLayout({
  title: 'Turn Off Find My to Continue',
  accentColor: '#f59e0b',
  includeTrustpilot: false,
  includeCountdownNotice: true,
  bodyHtml: `
    <p>Hi **CUSTOMER_NAME**,</p>
    <p>Find My / Activation Lock is still enabled for order <strong>#**ORDER_ID**</strong>.</p>
    <ol style="padding-left:22px; color:#475569; margin-bottom:20px;">
      <li>Go to <a href="https://icloud.com/find" target="_blank" style="color:#2563eb;">icloud.com/find</a>.</li>
      <li>Select your device.</li>
      <li>Choose <strong>Remove from Account</strong>.</li>
    </ol>
    <div style="text-align:center; margin:28px 0 22px;">
      <a href="**CONFIRM_URL**" class="button-link" style="background-color:#f59e0b;">I've Turned Off Find My</a>
    </div>
  `,
});

const BAL_DUE_EMAIL_HTML = buildEmailLayout({
  title: 'Balance Due with Carrier',
  accentColor: '#f97316',
  includeTrustpilot: false,
  includeCountdownNotice: true,
  bodyHtml: `
    <p>Hi **CUSTOMER_NAME**,</p>
    <p>For order <strong>#**ORDER_ID**</strong>, the carrier reported: <strong>**FINANCIAL_STATUS**</strong>.</p>
    <p>Please clear the balance with your carrier, then reply so we can re-run verification and continue payout processing.</p>
  `,
});

const DOWNGRADE_EMAIL_HTML = buildEmailLayout({
  title: 'Offer Updated',
  accentColor: '#f97316',
  includeTrustpilot: false,
  bodyHtml: `
    <p>Hi **CUSTOMER_NAME**,</p>
    <p>We did not receive a resolution update for order <strong>#**ORDER_ID**</strong>.</p>
    <p>Your offer has been adjusted to the damaged-device payout of <strong>$**NEW_PRICE**</strong>.</p>
    <p>Reply if you resolve the issue and want a re-evaluation.</p>
  `,
});

module.exports = {
  SHIPPING_LABEL_EMAIL_HTML,
  SHIPPING_KIT_EMAIL_HTML,
  ORDER_RECEIVED_EMAIL_HTML,
  DEVICE_RECEIVED_EMAIL_HTML,
  BLACKLISTED_EMAIL_HTML,
  BLACKLISTED_LEGAL_HTML,
  FMI_EMAIL_HTML,
  BAL_DUE_EMAIL_HTML,
  DOWNGRADE_EMAIL_HTML,
  TRUSTPILOT_REVIEW_LINK,
};
