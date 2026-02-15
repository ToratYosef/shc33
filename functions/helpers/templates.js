const {
  buildEmailLayout,
  TRUSTPILOT_REVIEW_LINK,
  BLACKLISTED_LEGAL_HTML,
} = require('./emailHtml');

const SHIPPING_LABEL_EMAIL_HTML = buildEmailLayout({
  title: 'Your Shipping Label is Ready!',
  bodyHtml: `
    <p style="font-size:18px; margin-bottom:12px;">Hi <strong>**CUSTOMER_NAME**</strong>,</p>
    <p style="margin-bottom:18px;">Your prepaid shipping label for order <strong style="color:#2563eb;">#**ORDER_ID**</strong> is ready to go.</p>

    <div style="text-align:center; margin:32px 0 24px;">
      <a href="**LABEL_DOWNLOAD_LINK**" class="button-link" style="background:linear-gradient(135deg,#16a34a,#22c55e); box-shadow:0 12px 24px rgba(22,163,74,0.25);">Download Shipping Label</a>
    </div>

    <div style="background:linear-gradient(180deg,#f8fafc 0%,#f1f5f9 100%); border:1px solid #e2e8f0; border-radius:16px; padding:18px 20px; margin-bottom:22px;">
      <p style="margin:0 0 6px; font-size:13px; color:#64748b; text-transform:uppercase; letter-spacing:0.08em;">Tracking Number</p>
      <p style="margin:0; color:#1d4ed8; font-size:22px; font-weight:800;">**TRACKING_NUMBER**</p>
    </div>

    <div style="background:#ecfeff; border:1px solid #bae6fd; border-radius:14px; padding:16px 18px; color:#0f766e;">
      <strong style="display:block; margin-bottom:6px;">Quick reminder</strong>
      Print the label, attach it to your package, and drop it off at any USPS location.
    </div>
  `,
});

const SHIPPING_KIT_EMAIL_HTML = buildEmailLayout({
  title: 'Your Shipping Kit Is on the Way',
  bodyHtml: `
    <p style="font-size:18px; margin-bottom:12px;">Hi <strong>**CUSTOMER_NAME**</strong>,</p>
    <p>Your shipping kit for order <strong style="color:#2563eb;">#**ORDER_ID**</strong> has shipped and is on the way to you.</p>

    <div style="background:linear-gradient(180deg,#f8fafc 0%,#f1f5f9 100%); border:1px solid #e2e8f0; border-radius:16px; padding:18px 20px; margin:22px 0;">
      <p style="margin:0 0 6px; font-size:13px; color:#64748b; text-transform:uppercase; letter-spacing:0.08em;">Tracking Number</p>
      <p style="margin:0; color:#1d4ed8; font-size:22px; font-weight:800;">**TRACKING_NUMBER**</p>
    </div>

    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:14px; padding:16px 18px;">
      <p style="margin:0 0 8px;"><strong>What to do when it arrives:</strong></p>
      <ul style="margin:0; padding-left:20px; color:#475569;">
        <li>Place your device in the kit.</li>
        <li>Seal the package securely.</li>
        <li>Use the included return label and ship it back.</li>
      </ul>
    </div>
  `,
});

const ORDER_RECEIVED_EMAIL_HTML = buildEmailLayout({
  title: 'Order Received',
  bodyHtml: `
    <p style="font-size:18px; margin-bottom:12px;">Hi <strong>**CUSTOMER_NAME**</strong>,</p>
    <p>Thanks for choosing SecondHandCell. We received your order for <strong>**DEVICE_NAME**</strong>.</p>

    <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:14px; padding:14px 16px; margin:18px 0;">
      <p style="margin:0; color:#1e40af;"><strong>Order ID:</strong> #**ORDER_ID**</p>
    </div>

    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:16px; padding:20px 22px; margin:24px 0; color:#334155;">
      <p style="margin:0 0 12px;"><strong>Before shipping your device:</strong></p>
      <ul style="padding-left:20px; margin:0; line-height:1.75;">
        <li>Back up your data.</li>
        <li>Factory reset the device.</li>
        <li>Remove iCloud / Google / Samsung accounts.</li>
        <li>Remove your SIM card.</li>
      </ul>
    </div>

    <div style="margin-top:20px;">**SHIPPING_INSTRUCTION**</div>
  `,
});

const DEVICE_RECEIVED_EMAIL_HTML = buildEmailLayout({
  title: 'Your Device Has Arrived',
  bodyHtml: `
    <p style="font-size:18px; margin-bottom:12px;">Hi <strong>**CUSTOMER_NAME**</strong>,</p>
    <p>Great news—we received your device for order <strong style="color:#2563eb;">#**ORDER_ID**</strong>.</p>

    <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:14px; padding:16px 18px; color:#166534; margin-top:18px;">
      <strong style="display:block; margin-bottom:6px;">Next step</strong>
      Your device is now in our inspection queue. We’ll follow up shortly with your final offer.
    </div>
  `,
});

const BLACKLISTED_EMAIL_HTML = buildEmailLayout({
  title: 'Action Required: Carrier Blacklist Detected',
  accentColor: '#dc2626',
  includeTrustpilot: false,
  includeCountdownNotice: true,
  bodyHtml: `
    <p style="font-size:18px; margin-bottom:12px;">Hi <strong>**CUSTOMER_NAME**</strong>,</p>
    <p>Our carrier check for order <strong style="color:#2563eb;">#**ORDER_ID**</strong> flagged the device as lost, stolen, or blacklisted.</p>

    <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:14px; padding:16px 18px; margin:18px 0; color:#991b1b;">
      We can’t release payment while this status is active. Please contact your carrier and reply once the flag has been removed.
    </div>

    <div style="margin-top:14px; background:#fff7ed; border:1px solid #fed7aa; border-radius:12px; padding:14px 16px; color:#9a3412; font-size:15px; line-height:1.7;">${BLACKLISTED_LEGAL_HTML}</div>
  `,
});

const FMI_EMAIL_HTML = buildEmailLayout({
  title: 'Turn Off Find My to Continue',
  accentColor: '#f59e0b',
  includeTrustpilot: false,
  includeCountdownNotice: true,
  bodyHtml: `
    <p style="font-size:18px; margin-bottom:12px;">Hi <strong>**CUSTOMER_NAME**</strong>,</p>
    <p>Find My / Activation Lock is still enabled for order <strong style="color:#2563eb;">#**ORDER_ID**</strong>.</p>

    <div style="background:#fff7ed; border:1px solid #fed7aa; border-radius:14px; padding:16px 18px; margin:20px 0;">
      <p style="margin:0 0 10px;"><strong>To remove it:</strong></p>
      <ol style="padding-left:22px; color:#7c2d12; margin:0; line-height:1.7;">
        <li>Go to <a href="https://icloud.com/find" target="_blank" style="color:#2563eb;">icloud.com/find</a>.</li>
        <li>Select your device.</li>
        <li>Choose <strong>Remove from Account</strong>.</li>
      </ol>
    </div>

    <div style="text-align:center; margin:28px 0 10px;">
      <a href="**CONFIRM_URL**" class="button-link" style="background:linear-gradient(135deg,#f59e0b,#fb923c); box-shadow:0 10px 22px rgba(245,158,11,0.28);">I've Turned Off Find My</a>
    </div>
  `,
});

const BAL_DUE_EMAIL_HTML = buildEmailLayout({
  title: 'Balance Due with Carrier',
  accentColor: '#f97316',
  includeTrustpilot: false,
  includeCountdownNotice: true,
  bodyHtml: `
    <p style="font-size:18px; margin-bottom:12px;">Hi <strong>**CUSTOMER_NAME**</strong>,</p>
    <p>For order <strong style="color:#2563eb;">#**ORDER_ID**</strong>, the carrier reported: <strong>**FINANCIAL_STATUS**</strong>.</p>

    <div style="background:#fff7ed; border:1px solid #fed7aa; border-radius:14px; padding:16px 18px; color:#9a3412; margin:18px 0;">
      Please clear the balance with your carrier, then reply so we can re-run verification and continue payout processing.
    </div>
  `,
});

const DOWNGRADE_EMAIL_HTML = buildEmailLayout({
  title: 'Offer Updated',
  accentColor: '#f97316',
  includeTrustpilot: false,
  bodyHtml: `
    <p style="font-size:18px; margin-bottom:12px;">Hi <strong>**CUSTOMER_NAME**</strong>,</p>
    <p>We did not receive a resolution update for order <strong style="color:#2563eb;">#**ORDER_ID**</strong>.</p>

    <div style="background:#fff7ed; border:1px solid #fed7aa; border-radius:14px; padding:16px 18px; margin:18px 0; color:#9a3412;">
      Your offer has been adjusted to the damaged-device payout of <strong>$**NEW_PRICE**</strong>.
    </div>

    <p>If you resolve the issue, just reply and we can re-evaluate the device.</p>
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
