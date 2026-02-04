const { escapeHtml } = require('./stringUtils');
const { BLACKLISTED_LEGAL_HTML } = require('./templates');

const EMAIL_LOGO_URL =
  "https://secondhandcell.com/assets/logo.webp";
const COUNTDOWN_NOTICE_TEXT =
  "If we don't hear back, we may finalize your order at 75% less to keep your order moving.";
const TRUSTPILOT_REVIEW_LINK = "https://www.trustpilot.com/evaluate/secondhandcell.com";
const TRUSTPILOT_STARS_IMAGE_URL = "https://cdn.trustpilot.net/brand-assets/4.1.0/stars/stars-5.png";

function buildCountdownNoticeHtml() {
  return `
    <div style="margin-top: 24px; padding: 18px 20px; background-color: #ecfdf5; border-radius: 12px; border: 1px solid #bbf7d0; color: #065f46; font-size: 17px; line-height: 1.6;">
      <strong style="display:block; font-size:18px; margin-bottom:8px;">Friendly reminder</strong>
      If we don't hear back, we may finalize your device at <strong>75% less</strong> to keep your order moving.
    </div>
  `;
}

function appendCountdownNotice(text = "") {
  const trimmed = text.trim();
  if (!trimmed) {
    return COUNTDOWN_NOTICE_TEXT;
  }
  if (trimmed.includes(COUNTDOWN_NOTICE_TEXT)) {
    return trimmed;
  }
  return `${trimmed}\n\n${COUNTDOWN_NOTICE_TEXT}`;
}

const CONDITION_EMAIL_TEMPLATES = {
  outstanding_balance: {
    subject: "Action Required: Outstanding Balance Detected",
    headline: "Outstanding balance detected",
    message:
      "Our ESN verification shows the carrier still reports an outstanding balance tied to this device.",
    steps: [
      "Contact your carrier to clear the remaining balance on the device.",
      "Reply to this email with confirmation so we can re-run the check and release your payout.",
    ],
  },
  password_locked: {
    subject: "Device Locked: Action Needed",
    headline: "Device is password or account locked",
    message:
      "The device arrived locked with a password, pattern, or linked account which prevents testing and data removal.",
    steps: [
      "Send us the any passcode, password, PIN, or pattern required to unlock the device so that we can properly inspect it amd data wipe it.",
      "Reply to this email once the lock has been cleared so we can finish processing the order.",
    ],
  },
  stolen: {
    subject: "Important: Device Reported Lost or Stolen",
    headline: "Device flagged as lost or stolen",
    message:
      "The carrier database has flagged this ESN/IMEI as lost or stolen, so we cannot complete the buyback.",
    steps: [
      "If you believe this is an error, please contact your carrier to remove the flag.",
      "Provide any supporting documentation by replying to this email so we can review and re-run the check.",
    ],
  },
  fmi_active: {
    subject: "Find My / Activation Lock Detected",
    headline: "Find My or activation lock is still enabled",
    message:
      "The device still has Find My iPhone / Activation Lock (or the Android equivalent) enabled, which prevents refurbishment.",
    steps: [
      "Disable the lock from the device or from iCloud/Google using your account.",
      "Remove the device from your trusted devices list.",
      "Reply to this email once the lock has been removed so we can verify and continue.",
    ],
  },
};

function getGreetingName(fullName) {
  if (!fullName || typeof fullName !== "string") {
    return "there";
  }
  const [first] = fullName.trim().split(/\s+/);
  return first || "there";
}

function buildConditionEmail(reason, order, notes) {
  const template = CONDITION_EMAIL_TEMPLATES[reason];
  if (!template) {
    throw new Error("Unsupported condition email template.");
  }

  const shippingInfo = order && order.shippingInfo ? order.shippingInfo : {};
  const customerName = shippingInfo.fullName || shippingInfo.name || null;
  const greetingName = getGreetingName(customerName);
  const orderId = (order && order.id) || "your order";
  const trimmedNotes = typeof notes === "string" ? notes.trim() : "";

  const noteHtml = trimmedNotes
    ? `<p style="margin-top:16px;"><strong>Additional details from our technician:</strong><br>${escapeHtml(
        trimmedNotes
      ).replace(/\n/g, "<br>")}</p>`
    : "";
  const noteText = trimmedNotes
    ? `\n\nAdditional details from our technician:\n${trimmedNotes}`
    : "";

  const steps = Array.isArray(template.steps) ? template.steps : [];
  const stepsHtml = steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("");
  const stepsText = steps.map((step) => `• ${step}`).join("\n");

  const accentColorMap = {
    outstanding_balance: "#f97316",
    password_locked: "#6366f1",
    stolen: "#dc2626",
    fmi_active: "#f59e0b",
  };

  const bodyHtml = `
      <p>Hi ${escapeHtml(greetingName)},</p>
      <p>During our inspection of the device you sent in for order <strong>#${escapeHtml(orderId)}</strong>, we detected an issue:</p>
      <div style="background:#fff7ed; border-radius:14px; border:1px solid #fde68a; padding:18px 22px; margin:24px 0; color:#7c2d12;">
        <strong>${escapeHtml(template.headline)}</strong>
        <p style="margin:12px 0 0; color:#7c2d12;">${escapeHtml(template.message)}</p>
      </div>
      <p style="margin-bottom:16px;">Here's what to do next:</p>
      <ul style="padding-left:22px; color:#475569; margin:0 0 24px;">
        ${stepsHtml}
      </ul>
      ${noteHtml}
      <p>Reply to this email once you've taken care of the issue so we can recheck your device and keep your payout moving.</p>
  `;

  const html = buildEmailLayout({
    title: template.headline,
    accentColor: accentColorMap[reason] || "#0ea5e9",
    includeTrustpilot: false,
    bodyHtml,
    includeCountdownNotice: true,
  });

  const text = appendCountdownNotice(`Hi ${greetingName},

During our inspection of the device you sent in for order #${orderId}, we detected an issue:

${template.headline}

${template.message}

${stepsText}${noteText}

Please reply to this email once the issue has been resolved so we can continue processing your payout.

Thank you,
SecondHandCell Team`);

  return { subject: template.subject, html, text };
}

function buildTrustpilotSection() {
  return `
    <div style="text-align:center; padding: 28px 24px 32px; background-color:#f8fafc; border-top: 1px solid #e2e8f0;">
      <p style="font-weight:600; color:#0f172a; font-size:18px; margin:0 0 12px 0;">Loved your experience?</p>
      <a href="${TRUSTPILOT_REVIEW_LINK}" style="display:inline-block; text-decoration:none; border:none; outline:none;">
        <img src="${TRUSTPILOT_STARS_IMAGE_URL}" alt="Rate us on Trustpilot" style="height:58px; width:auto; display:block; margin:0 auto 10px auto; border:0;">
      </a>
      <p style="font-size:15px; color:#475569; margin:12px 0 0;">Your feedback keeps the <strong>SecondHandCell</strong> community thriving.</p>
    </div>
  `;
}

function buildEmailLayout({
  title = "",
  bodyHtml = "",
  accentColor = "#16a34a",
  includeTrustpilot = true,
  footerText = "Need help? Reply to this email or call (347) 688-0662.",
  includeCountdownNotice = false,
} = {}) {
  const headingSection = title
    ? `
        <tr>
          <td style="background:${accentColor}; padding: 30px 24px; text-align:center;">
            <h1 style="margin:0; font-size:28px; line-height:1.3; color:#ffffff; font-weight:700;">${escapeHtml(
              title
            )}</h1>
          </td>
        </tr>
      `
    : "";

  const trustpilotSection = includeTrustpilot ? buildTrustpilotSection() : "";
  const countdownSection = includeCountdownNotice
    ? buildCountdownNoticeHtml()
    : "";

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${escapeHtml(title || "SecondHandCell Update")}</title>
      <style>
        body { background-color:#f1f5f9; margin:0; padding:24px 12px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#0f172a; }
        .email-shell { width:100%; max-width:640px; margin:0 auto; background:#ffffff; border-radius:20px; overflow:hidden; box-shadow:0 25px 45px rgba(15,23,42,0.08); border:1px solid #e2e8f0; }
        .logo-cell { padding:28px 0 16px; text-align:center; background-color:#ffffff; }
        .logo-cell img { height:56px; width:auto; }
        .content-cell { padding:32px 30px; font-size:17px; line-height:1.75; }
        .content-cell p { margin:0 0 20px; }
        .footer-cell { padding:28px 32px; text-align:center; font-size:15px; color:#475569; background-color:#f8fafc; border-top:1px solid #e2e8f0; }
        .footer-cell p { margin:4px 0; }
        a.button-link { display:inline-block; padding:14px 26px; border-radius:9999px; background-color:#16a34a; color:#ffffff !important; font-weight:600; text-decoration:none; font-size:17px; }
      </style>
    </head>
    <body>
      <table role="presentation" cellpadding="0" cellspacing="0" class="email-shell">
        <tr>
          <td class="logo-cell">
            <img src="${EMAIL_LOGO_URL}" alt="SecondHandCell Logo" />
          </td>
        </tr>
        ${headingSection}
        <tr>
          <td class="content-cell">
            ${bodyHtml}
            ${countdownSection}
          </td>
        </tr>
        ${trustpilotSection ? `<tr><td>${trustpilotSection}</td></tr>` : ""}
        <tr>
          <td class="footer-cell">
            <p>${footerText}</p>
            <p>© ${new Date().getFullYear()} SecondHandCell. All rights reserved.</p>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
}

const SHIPPING_LABEL_EMAIL_HTML = buildEmailLayout({
  title: "Your Shipping Label is Ready!",
  bodyHtml: `
      <p>Hi **CUSTOMER_NAME**,</p>
      <p>Your shipping label for order <strong>#**ORDER_ID**</strong> is ready to go.</p>
      <p style="margin-bottom:28px;">Use the secure button below to download it instantly and get your device on the way to us.</p>
      <div style="text-align:center; margin-bottom:32px;">
        <a href="**LABEL_DOWNLOAD_LINK**" class="button-link">Download Shipping Label</a>
      </div>
      <div style="background:#f8fafc; border:1px solid #dbeafe; border-radius:14px; padding:20px 24px;">
        <p style="margin:0 0 10px;"><strong style="color:#0f172a;">Tracking Number</strong><br><span style="color:#2563eb; font-weight:600;">**TRACKING_NUMBER**</span></p>
        <p style="margin:0; color:#475569;">Drop your device off with your preferred carrier as soon as you're ready.</p>
      </div>
      <p style="margin-top:28px;">Need a hand? Reply to this email and our team will guide you.</p>
  `,
});

const SHIPPING_KIT_EMAIL_HTML = buildEmailLayout({
  title: "Your Shipping Kit is on its Way!",
  bodyHtml: `
      <p>Hi **CUSTOMER_NAME**,</p>
      <p>Your shipping kit for order <strong>#**ORDER_ID**</strong> is en route.</p>
      <p>Track its journey with the number below and get ready to pop your device inside once it arrives.</p>
      <div style="background:#f8fafc; border:1px solid #dbeafe; border-radius:14px; padding:20px 24px; margin:0 0 28px;">
        <p style="margin:0 0 10px;"><strong style="color:#0f172a;">Tracking Number</strong><br><span style="color:#2563eb; font-weight:600;">**TRACKING_NUMBER**</span></p>
        <p style="margin:0; color:#475569;">Keep an eye out for your kit and pack your device securely when it lands.</p>
      </div>
      <p>Have accessories you don't need? Feel free to include them—we'll recycle responsibly.</p>
      <p>Need anything else? Just reply to this email.</p>
  `,
});

const ORDER_RECEIVED_EMAIL_HTML = buildEmailLayout({
  title: "We've received your order!",
  bodyHtml: `
      <p>Hi **CUSTOMER_NAME**,</p>
      <p>Thanks for choosing SecondHandCell! We've logged your order for <strong>**DEVICE_NAME**</strong>.</p>
      <p>Your order ID is <strong style="color:#2563eb;">#**ORDER_ID**</strong>. Keep it handy for any questions.</p>
      <h2 style="font-size:20px; color:#0f172a; margin:32px 0 12px;">Before you ship</h2>
      <ul style="padding-left:22px; margin:0 0 20px; color:#475569;">
        <li style="margin-bottom:10px;"><strong>Backup your data</strong> so nothing personal is lost.</li>
        <li style="margin-bottom:10px;"><strong>Factory reset</strong> the device to wipe personal info.</li>
        <li style="margin-bottom:10px;"><strong>Remove accounts</strong> such as Apple ID/iCloud or Google/Samsung accounts.<br><span style="display:block; margin-top:6px; margin-left:10px;">• Turn off Find My iPhone (FMI).<br>• Disable Factory Reset Protection (FRP) on Android.</span></li>
        <li style="margin-bottom:10px;"><strong>Remove SIM cards</strong> and eSIM profiles.</li>
        <li style="margin-bottom:10px;"><strong>Pack accessories separately</strong> unless we specifically request them.</li>
      </ul>
      <div style="background:#fef3c7; border-radius:16px; padding:18px 22px; border:1px solid #fde68a; color:#92400e; margin:30px 0;">
        <strong>Important:</strong> We can't process devices that still have FMI/FRP enabled, an outstanding balance, or a blacklist/lost/stolen status.
      </div>
      **SHIPPING_INSTRUCTION**
  `,
});

const DEVICE_RECEIVED_EMAIL_HTML = buildEmailLayout({
  title: "Your device has arrived!",
  bodyHtml: `
      <p>Hi **CUSTOMER_NAME**,</p>
      <p>Your device for order <strong style="color:#2563eb;">#**ORDER_ID**</strong> has landed at our facility.</p>
      <p>Our technicians are giving it a full inspection now. We'll follow up shortly with an update on your payout.</p>
      <p>Have questions while you wait? Just reply to this email—real humans are here to help.</p>
  `,
});

const ORDER_PLACED_ADMIN_EMAIL_HTML = buildEmailLayout({
  title: "New order submitted",
  accentColor: "#f97316",
  bodyHtml: `
      <p>Heads up! A new order just came in.</p>
      <div style="background:#fff7ed; border:1px solid #fed7aa; border-radius:16px; padding:22px 24px; margin-bottom:28px; color:#7c2d12;">
        <p style="margin:0 0 10px;"><strong>Customer:</strong> **CUSTOMER_NAME**</p>
        <p style="margin:0 0 10px;"><strong>Email:</strong> **CUSTOMER_EMAIL**</p>
        <p style="margin:0 0 10px;"><strong>Phone:</strong> **CUSTOMER_PHONE**</p>
        <p style="margin:0 0 10px;"><strong>Item:</strong> **DEVICE_NAME**</p>
        <p style="margin:0 0 10px;"><strong>Storage:</strong> **STORAGE**</p>
        <p style="margin:0 0 10px;"><strong>Carrier:</strong> **CARRIER**</p>
        <p style="margin:0 0 10px;"><strong>Estimated Payout:</strong> $**ESTIMATED_QUOTE**</p>
        <p style="margin:0 0 10px;"><strong>Payment Method:</strong> **PAYMENT_METHOD**</p>
        <p style="margin:0 0 10px;"><strong>Payment Info:</strong> **PAYMENT_INFO**</p>
        <p style="margin:0 0 10px;"><strong>Shipping Address:</strong><br>**SHIPPING_ADDRESS**</p>
        <div style="margin-top:12px; padding:12px 14px; background:#fff; border:1px solid #fed7aa; border-radius:12px;">
          <p style="margin:0 0 6px;"><strong>Conditions:</strong></p>
          <p style="margin:0 0 4px;">Powers On: **POWER_STATUS**</p>
          <p style="margin:0 0 4px;">Fully Functional: **FUNCTIONAL_STATUS**</p>
          <p style="margin:0 0 4px;">No Cracks: **CRACK_STATUS**</p>
          <p style="margin:0;">Cosmetic: **COSMETIC_GRADE**</p>
        </div>
      </div>
      <div style="text-align:center; margin-bottom:20px;">
        <a href="https://secondhandcell.com/admin" class="button-link" style="background-color:#f97316;">Open in Admin</a>
      </div>
      <p style="color:#475569;">This alert is automated—feel free to reply if you notice anything unusual.</p>
  `,
});

const BLACKLISTED_EMAIL_HTML = buildEmailLayout({
  title: "Action required: Carrier blacklist detected",
  accentColor: "#dc2626",
  includeCountdownNotice: true,
  includeTrustpilot: false,
  bodyHtml: `
      <p>Hi **CUSTOMER_NAME**,</p>
      <p>During our review of order <strong>#**ORDER_ID**</strong>, the carrier database flagged the device as lost, stolen, or blacklisted.</p>
      <p>We can't release payment while this status is active. Please contact your carrier to remove the flag and reply with confirmation or documentation so we can re-run the check.</p>
      <p>If you believe this alert is an error, include any proof in your reply and we'll take another look.</p>
      <div style="color:#dc2626; font-size:15px; line-height:1.6;">
        ${BLACKLISTED_LEGAL_HTML}
      </div>
  `,
});

const FMI_EMAIL_HTML = buildEmailLayout({
  title: "Turn off Find My to continue",
  accentColor: "#f59e0b",
  includeCountdownNotice: true,
  includeTrustpilot: false,
  bodyHtml: `
      <p>Hi **CUSTOMER_NAME**,</p>
      <p>Our inspection for order <strong>#**ORDER_ID**</strong> shows Find My iPhone / Activation Lock is still enabled.</p>
      <p>Please complete the steps below so we can finish processing your payout:</p>
      <ol style="padding-left:22px; color:#475569; margin-bottom:20px;">
        <li>Visit <a href="https://icloud.com/find" target="_blank" style="color:#2563eb;">icloud.com/find</a> and sign in.</li>
        <li>Select the device you're selling.</li>
        <li>Choose “Remove from Account”.</li>
        <li>Confirm the device no longer appears in your list.</li>
      </ol>
      <div style="text-align:center; margin:32px 0 24px;">
        <a href="**CONFIRM_URL**" class="button-link" style="background-color:#f59e0b;">I've turned off Find My</a>
      </div>
      <p style="color:#b45309; font-size:15px;">Once it's disabled, click the button above or reply to this email so we can recheck your device.</p>
  `,
});

const BAL_DUE_EMAIL_HTML = buildEmailLayout({
  title: "Balance due with your carrier",
  accentColor: "#f97316",
  includeCountdownNotice: true,
  includeTrustpilot: false,
  bodyHtml: `
      <p>Hi **CUSTOMER_NAME**,</p>
      <p>When we ran your device for order <strong>#**ORDER_ID**</strong>, the carrier reported a status of <strong>**FINANCIAL_STATUS**</strong>.</p>
      <p>Please contact your carrier to clear the balance and then reply to this email so we can rerun the check and keep your payout on track.</p>
      <p style="color:#c2410c;">Need help figuring out the right department to call? Let us know and we'll point you in the right direction.</p>
  `,
});

const DOWNGRADE_EMAIL_HTML = buildEmailLayout({
  title: "Order finalized at adjusted payout",
  accentColor: "#f97316",
  includeTrustpilot: false,
  bodyHtml: `
      <p>Hi **CUSTOMER_NAME**,</p>
      <p>We reached out about the issue with your device for order <strong>#**ORDER_ID**</strong> but haven't received an update.</p>
      <p>To keep things moving, we've finalized the device at 75% less than the original offer. If you resolve the issue, reply to this email and we'll happily re-evaluate.</p>
      <p>We're here to help—just let us know how you'd like to proceed.</p>
  `,
});

function getOrderCompletedEmailTemplate({ includeTrustpilot = true } = {}) {
  return buildEmailLayout({
    title: "🥳 Your order is complete!",
    includeTrustpilot,
    bodyHtml: `
        <p>Hi **CUSTOMER_NAME**,</p>
        <p>Great news! Order <strong>#**ORDER_ID**</strong> is complete and your payout is headed your way.</p>
        <div style="background-color:#f8fafc; border:1px solid #e2e8f0; border-radius:16px; padding:20px 24px; margin:28px 0;">
          <p style="margin:0 0 12px;"><strong style="color:#0f172a;">Device</strong><br><span style="color:#475569;">**DEVICE_SUMMARY**</span></p>
          <p style="margin:0 0 12px;"><strong style="color:#0f172a;">Payout</strong><br><span style="color:#059669; font-size:22px; font-weight:700;">$**ORDER_TOTAL**</span></p>
          <p style="margin:0;"><strong style="color:#0f172a;">Payment method</strong><br><span style="color:#475569;">**PAYMENT_METHOD**</span></p>
        </div>
        <p>Thanks for choosing SecondHandCell!</p>
    `,
  });
}

const REVIEW_REQUEST_EMAIL_HTML = buildEmailLayout({
  title: "We'd love your feedback",
  accentColor: "#0ea5e9",
  bodyHtml: `
      <p>Hello **CUSTOMER_NAME**,</p>
      <p>Thanks again for trusting us with your device. Sharing a quick review helps other sellers feel confident working with SecondHandCell.</p>
      <p style="margin-bottom:32px;">It only takes a minute and means the world to our team.</p>
      <div style="text-align:center; margin-bottom:24px;">
        <a href="${TRUSTPILOT_REVIEW_LINK}" class="button-link" style="background-color:#0ea5e9;">Leave a Trustpilot review</a>
      </div>
      <p style="text-align:center; color:#475569;">Thank you for being part of the SecondHandCell community!</p>
  `,
});

module.exports = {
  EMAIL_LOGO_URL,
  COUNTDOWN_NOTICE_TEXT,
  TRUSTPILOT_REVIEW_LINK,
  buildCountdownNoticeHtml,
  appendCountdownNotice,
  CONDITION_EMAIL_TEMPLATES,
  buildConditionEmail,
  buildEmailLayout,
  SHIPPING_LABEL_EMAIL_HTML,
  SHIPPING_KIT_EMAIL_HTML,
  ORDER_RECEIVED_EMAIL_HTML,
  DEVICE_RECEIVED_EMAIL_HTML,
  ORDER_PLACED_ADMIN_EMAIL_HTML,
  BLACKLISTED_EMAIL_HTML,
  FMI_EMAIL_HTML,
  BAL_DUE_EMAIL_HTML,
  DOWNGRADE_EMAIL_HTML,
  getOrderCompletedEmailTemplate,
  REVIEW_REQUEST_EMAIL_HTML,
};
