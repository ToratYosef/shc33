const { escapeHtml } = require('./stringUtils');

const EMAIL_LOGO_URL =
  "https://cdn.secondhandcell.com/images/assets/logo.webp";
const COUNTDOWN_NOTICE_TEXT =
  "If we don't hear back, we may finalize your order at 75% less to keep your order moving.";
const TRUSTPILOT_REVIEW_LINK = "https://www.trustpilot.com/review/secondhandcell.com?utm_medium=trustbox&utm_source=TrustBoxReviewCollector";
const TRUSTPILOT_STARS_IMAGE_URL = "https://cdn.trustpilot.net/brand-assets/4.1.0/stars/stars-5.png";

const BLACKLISTED_LEGAL_HTML = `
  <strong>Legal Notice:</strong> Devices reported as lost, stolen, or blacklisted cannot be purchased under applicable federal and state regulations.
  Please contact your carrier immediately to resolve this status and reply with documentation so we can continue your order review.
`;

function buildCountdownNoticeHtml() {
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:24px; background:#fff7ed; border:1px solid #fed7aa; border-radius:18px;">
      <tr>
        <td style="padding:18px 20px; color:#9a3412; font-size:15px; line-height:24px;">
          <strong style="display:block; color:#7c2d12; font-size:15px; margin-bottom:6px;">Reminder</strong>
          If we don't hear back, we may finalize your device at <strong>75% less</strong> to keep your order moving.
        </td>
      </tr>
    </table>
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
    showResolvedButton: true,
    resolvedButtonLabel: "I've paid the balance",
    resolvedButtonHint: "Tap once you've paid your carrier balance",
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
    showResolvedButton: true,
    resolvedButtonLabel: 'Enter password',
    resolvedButtonHint: 'Tap once the phone can be unlocked for testing',
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
    showResolvedButton: true,
    resolvedButtonLabel: 'Blacklist issue fixed',
    resolvedButtonHint: 'Tap once your carrier clears the blacklist flag',
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
    showResolvedButton: true,
    resolvedButtonLabel: 'Activation lock removed',
    resolvedButtonHint: 'Tap once Find My / Activation Lock is turned off',
  },
};

function getGreetingName(fullName) {
  if (!fullName || typeof fullName !== "string") {
    return "there";
  }
  const [first] = fullName.trim().split(/\s+/);
  return first || "there";
}

function buildConditionEmail(reason, order, notes, deviceKey = null) {
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

  const deviceKeyParam = deviceKey ? `?deviceKey=${encodeURIComponent(deviceKey)}` : "";
  const resolvedButtonLabel = template.resolvedButtonLabel || '✓ Issue Resolved';
  const resolvedButtonHint = template.resolvedButtonHint || "Tap once you've fixed this issue";

  const resolvedButtonHtml = template.showResolvedButton
    ? `
      <div style="text-align:center; margin:32px 0 24px;">
        <a href="https://api.secondhandcell.com/server/orders/${escapeHtml(orderId)}/issue-resolved${deviceKeyParam}" 
           style="display:inline-block; padding:14px 32px; border-radius:9999px; background-color:#14b8a6; color:#ffffff !important; font-weight:600; text-decoration:none; font-size:17px; box-shadow:0 4px 12px rgba(20,184,166,0.3);">
          ${escapeHtml(resolvedButtonLabel)}
        </a>
        <p style="font-size:14px; color:#64748b; margin-top:12px;">${escapeHtml(resolvedButtonHint)}</p>
      </div>
    `
    : "";

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
      ${resolvedButtonHtml}
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
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:28px; background:#f9f9fa; border:1px solid #ececec; border-radius:22px;">
      <tr>
        <td style="padding:24px; text-align:center;">
          <div style="font-size:20px; line-height:26px; font-weight:600; letter-spacing:-0.03em; color:#111111; margin-bottom:8px;">Share your experience</div>
          <div style="font-size:15px; line-height:24px; color:#6b7280; margin:0 0 18px;">If you have a moment, we'd appreciate your feedback.</div>
          <a href="${TRUSTPILOT_REVIEW_LINK}" style="display:inline-block; text-decoration:none; border:none; outline:none;">
            <img src="${TRUSTPILOT_STARS_IMAGE_URL}" alt="Rate us on Trustpilot" style="height:58px; width:auto; display:block; margin:0 auto; border:0;">
          </a>
        </td>
      </tr>
    </table>
  `;
}

function buildEmailLayout({
  title = "",
  bodyHtml = "",
  accentColor = "#16a34a",
  includeTrustpilot = true,
  footerText = "SecondHandCell.com • https://secondhandcell.com • sales@secondhandcell.com",
  includeCountdownNotice = false,
} = {}) {
  const normalizedBodyHtml = String(bodyHtml || "")
    .replace(
      /class="button-link"\s+style="([^"]*)"/g,
      (_match, extraStyle) =>
        `style="display:inline-block; padding:14px 26px; border-radius:999px; background-color:#16a34a; color:#ffffff !important; font-weight:600; text-decoration:none; font-size:15px; line-height:15px; letter-spacing:-0.01em; ${extraStyle}"`
    )
    .replace(
      /class="button-link"/g,
      'style="display:inline-block; padding:14px 26px; border-radius:999px; background-color:#16a34a; color:#ffffff !important; font-weight:600; text-decoration:none; font-size:15px; line-height:15px; letter-spacing:-0.01em;"'
    );
  const trustpilotSection = includeTrustpilot ? buildTrustpilotSection() : "";
  const countdownSection = includeCountdownNotice
    ? buildCountdownNoticeHtml()
    : "";
  const footerParts = String(footerText || "").split("•").map((part) => part.trim()).filter(Boolean);
  const footerHtml = footerParts.length >= 3
    ? `
        <div style="font-weight:600; color:#6b7280; margin-bottom:4px;">${escapeHtml(footerParts[0])}</div>
        <div>
          <a href="${escapeHtml(footerParts[1])}" style="color:#8b8b8f; text-decoration:none;">SecondHandCell.com</a>
          &nbsp;&nbsp;&bull;&nbsp;&nbsp;
          <a href="mailto:${escapeHtml(footerParts[2])}" style="color:#8b8b8f; text-decoration:none;">${escapeHtml(footerParts[2])}</a>
        </div>
      `
    : `<div>${escapeHtml(footerText)}</div>`;
  const headingSection = title
    ? `
      <tr>
        <td style="padding:42px 36px 18px 36px; text-align:center;">
          <div style="width:64px; height:4px; border-radius:999px; background:${escapeHtml(accentColor)}; margin:0 auto 18px auto;"></div>
          <div style="font-size:34px; line-height:38px; font-weight:600; letter-spacing:-0.04em; color:#111111; margin-bottom:0;">
            ${escapeHtml(title)}
          </div>
        </td>
      </tr>
    `
    : "";

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${escapeHtml(title || "SecondHandCell Update")}</title>
    </head>
    <body style="margin:0; padding:0; background-color:#f3f4f6; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#111111;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f3f4f6; margin:0; padding:32px 16px;">
        <tr>
          <td align="center">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px; background:#ffffff; border-radius:28px; overflow:hidden; border:1px solid #e5e7eb; box-shadow:0 12px 40px rgba(0,0,0,0.04);">
              <tr>
                <td style="padding:32px 36px 24px 36px; background:#ffffff; border-bottom:1px solid #f1f1f1;">
                  <div style="text-align:center;">
                    <img src="${EMAIL_LOGO_URL}" alt="SecondHandCell" style="height:44px; display:block; margin:0 auto;" />
                  </div>
                </td>
              </tr>
              ${headingSection}
              <tr>
                <td style="padding:0 36px 0 36px; font-size:16px; line-height:26px; color:#3f3f46;">
                  ${normalizedBodyHtml}
                  ${countdownSection}
                  ${trustpilotSection}
                </td>
              </tr>
              <tr>
                <td style="padding:34px 36px 34px 36px;">
                  <div style="border-top:1px solid #eeeeee; padding-top:22px; text-align:center; font-size:12px; line-height:20px; color:#9ca3af;">
                    ${footerHtml}
                    <div style="margin-top:6px;">© ${new Date().getFullYear()} SecondHandCell. All rights reserved.</div>
                  </div>
                </td>
              </tr>
            </table>
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
  title: "Order confirmation",
  includeTrustpilot: false,
  footerText: "SecondHandCell.com • https://secondhandcell.com • sales@secondhandcell.com",
  bodyHtml: `
      <p style="font-size:17px; margin:0 0 14px;">Hi <strong>**CUSTOMER_NAME**</strong>,</p>
      <p style="margin:0 0 18px;">Thanks for your order. We created your trade-in for <strong>**DEVICE_NAME**</strong>.</p>
      <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:14px; padding:18px 20px; margin:20px 0 24px;">
        <div style="font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:#64748b; margin-bottom:10px; font-weight:600;">Order Summary</div>
        <p style="margin:0 0 8px; color:#0f172a;"><strong>Order ID:</strong> #**ORDER_ID**</p>
        <p style="margin:0; color:#475569;"><strong>Device:</strong> **DEVICE_NAME**</p>
      </div>
      <div style="margin:0 0 24px;">
        <div style="font-size:18px; font-weight:700; color:#0f172a; margin:0 0 10px;">Next steps</div>
        <ul style="padding-left:18px; margin:0; color:#475569; line-height:1.7;">
          <li>Back up any data you want to keep.</li>
          <li>Remove Apple ID, iCloud, Google, or Samsung accounts.</li>
          <li>Factory reset the device.</li>
          <li>Remove any SIM card or eSIM profile.</li>
        </ul>
      </div>
      <div style="margin:0 0 24px;">**SHIPPING_INSTRUCTION**</div>
      <div style="border-top:1px solid #e2e8f0; padding-top:20px;">
        <div style="font-size:18px; font-weight:700; color:#0f172a; margin:0 0 10px;">Need help?</div>
        <p style="margin:0; color:#475569;">Reply to this email or contact us at <a href="mailto:sales@secondhandcell.com" style="color:#2563eb; text-decoration:none;">sales@secondhandcell.com</a>.</p>
      </div>
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
    title: "Order complete",
    includeTrustpilot,
    footerText: "SecondHandCell.com • https://secondhandcell.com • sales@secondhandcell.com",
    bodyHtml: `
        <p style="margin:0 0 14px;">Hi <strong>**CUSTOMER_NAME**</strong>,</p>
        <p style="margin:0 0 22px;">Your order has been completed and your payout has been issued.</p>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f9f9fa; border-radius:22px; border:1px solid #ececec; margin:0 0 24px;">
          <tr>
            <td style="padding:24px 24px 8px 24px; font-size:12px; line-height:16px; font-weight:600; letter-spacing:0.08em; text-transform:uppercase; color:#8b8b8f;">
              Payment Summary
            </td>
          </tr>
          <tr>
            <td style="padding:0 24px 24px 24px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding:10px 0; font-size:15px; line-height:22px; color:#6b7280; border-bottom:1px solid #e9e9eb; width:130px;">Order ID</td>
                  <td style="padding:10px 0; font-size:15px; line-height:22px; color:#111111; font-weight:600; border-bottom:1px solid #e9e9eb; text-align:right;">**ORDER_ID**</td>
                </tr>
                <tr>
                  <td style="padding:10px 0; font-size:15px; line-height:22px; color:#6b7280; border-bottom:1px solid #e9e9eb; width:130px;">Device</td>
                  <td style="padding:10px 0; font-size:15px; line-height:22px; color:#111111; font-weight:600; border-bottom:1px solid #e9e9eb; text-align:right;">**DEVICE_SUMMARY**</td>
                </tr>
                <tr>
                  <td style="padding:10px 0; font-size:15px; line-height:22px; color:#6b7280; border-bottom:1px solid #e9e9eb; width:130px;">Payout</td>
                  <td style="padding:10px 0; font-size:15px; line-height:22px; color:#111111; font-weight:600; border-bottom:1px solid #e9e9eb; text-align:right;">$**ORDER_TOTAL**</td>
                </tr>
                <tr>
                  <td style="padding:10px 0 0 0; font-size:15px; line-height:22px; color:#6b7280; width:130px;">Method</td>
                  <td style="padding:10px 0 0 0; font-size:15px; line-height:22px; color:#111111; font-weight:600; text-align:right;">**PAYMENT_METHOD**</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <p style="margin:0;">If you have any questions about your payout, reply to this email and we’ll help.</p>
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
  BLACKLISTED_LEGAL_HTML,
};
