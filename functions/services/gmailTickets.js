const axios = require("axios");
const nodemailer = require("nodemailer");
const MailComposer = require("nodemailer/lib/mail-composer");
const { admin, initFirebaseAdmin } = require("../helpers/firebaseAdmin");

initFirebaseAdmin();

const db = admin.firestore();

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
];

const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const CONNECTED_MAILBOX = "sales@secondhandcell.com";
const EMAIL_DISPLAY_NAME = "SecondHandCell Orders";

const configRef = () => db.collection("config").doc("gmailWorkspace");
const ticketsCollection = () => db.collection("emailTickets");
const threadMapCollection = () => db.collection("emailThreadMap");
const messageIndexCollection = () => db.collection("emailMessageIndex");
const unassignedCollection = () => db.collection("emailUnassigned");

function cleanEnvValue(value) {
  return typeof value === "string" ? value.trim().replace(/^['"]|['"]$/g, "") : "";
}

function getOAuthConfig() {
  return {
    clientId: cleanEnvValue(process.env.GMAIL_API_CLIENT_ID),
    clientSecret: cleanEnvValue(process.env.GMAIL_API_CLIENT_SECRET),
    redirectUri:
      cleanEnvValue(process.env.GMAIL_API_REDIRECT_URI) ||
      "https://api.secondhandcell.com/auth/google/callback",
  };
}

function isGmailConfigured() {
  const cfg = getOAuthConfig();
  return Boolean(cfg.clientId && cfg.clientSecret && cfg.redirectUri);
}

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(input = "") {
  const normalized = String(input).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function normalizeOrderId(value) {
  const match = String(value || "").toUpperCase().match(/\bSHC[-\s]?\d{3,}\b/);
  return match ? match[0].replace(/\s+/g, "-").replace(/^SHC(?!-)/, "SHC-") : "";
}

function extractOrderId(mailOptions = {}) {
  const metadataOrder =
    mailOptions.orderId ||
    mailOptions.ticketId ||
    mailOptions?.metadata?.orderId ||
    mailOptions?.metadata?.ticketId ||
    mailOptions?.headers?.["X-SHC-Order-ID"] ||
    mailOptions?.headers?.["x-shc-order-id"];
  if (metadataOrder) {
    const normalized = normalizeOrderId(metadataOrder);
    if (normalized) return normalized;
  }

  const haystack = [
    mailOptions.subject,
    mailOptions.text,
    typeof mailOptions.html === "string" ? mailOptions.html.replace(/<[^>]+>/g, " ") : "",
  ].join(" ");
  return normalizeOrderId(haystack);
}

function isLikelyAccountEmail(mailOptions = {}) {
  const text = [mailOptions.subject, mailOptions.text, mailOptions.html]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return [
    "password reset",
    "reset your password",
    "verify your email",
    "verification",
    "login",
    "sign in",
    "account security",
  ].some((needle) => text.includes(needle));
}

function normalizeAddress(value) {
  if (!value) return "";
  if (Array.isArray(value)) return value.map(normalizeAddress).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const address = value.address || value.email || "";
    const name = value.name || "";
    return name && address ? `${name} <${address}>` : address;
  }
  return String(value);
}

function extractEmailAddress(value) {
  const raw = normalizeAddress(value);
  const match = raw.match(/<([^>]+)>/);
  return (match ? match[1] : raw.split(",")[0] || "").trim().toLowerCase();
}

const EMAIL_TYPE_LABELS = {
  order_received: "Order received email",
  device_received: "Device received email",
  fmi: "FMI email",
  offer: "Offer email",
  reoffer: "Reoffer email",
  payment_update: "Payment update email",
  shipping_label: "Shipping label email",
  order_complete: "Order complete email",
  manual_admin: "Manual admin email",
  sent_email: "Sent email",
};

function inferEmailType(message = {}) {
  if (message.emailType) return String(message.emailType);
  if (message.rawAdminMessage) return "manual_admin";
  const subject = String(message.subject || "").toLowerCase();
  if (subject.includes("shipping label")) return "shipping_label";
  if (subject.includes("order received") || subject.includes("order confirmation")) return "order_received";
  if (subject.includes("device received") || subject.includes("arrived")) return "device_received";
  if (subject.includes("reoffer")) return "reoffer";
  if (subject.includes("offer")) return "offer";
  if (subject.includes("payment")) return "payment_update";
  if (subject.includes("find my") || subject.includes("fmi")) return "fmi";
  if (subject.includes("order complete") || subject.includes("completed")) return "order_complete";
  return "sent_email";
}

function toIsoOrNull(value) {
  if (!value) return null;
  if (typeof value?.toDate === "function") return value.toDate().toISOString();
  if (typeof value === "string") return value;
  return null;
}

function normalizeDirection(direction = "") {
  const normalized = String(direction || "").toLowerCase();
  if (["inbound", "received"].includes(normalized)) return "received";
  if (["outbound", "sent"].includes(normalized)) return "sent";
  return "unknown";
}

function normalizeTicketMessage(id, message = {}) {
  let direction = normalizeDirection(message.direction);
  if (direction === "unknown") {
    direction = detectMessageDirection({
      from: message.from || message.fromEmail || "",
      to: message.to || message.toEmail || "",
      labelIds: message.labelIds || [],
    });
  }
  const emailType = direction === "sent" ? inferEmailType(message) : null;
  const emailTypeLabel = direction === "sent" ? (EMAIL_TYPE_LABELS[emailType] || "Sent email") : null;
  const fromRaw = message.from || message.fromEmail || "";
  return {
    id,
    direction,
    emailType,
    emailTypeLabel,
    subject: message.subject || null,
    fromName: direction === "received" ? (message.fromName || null) : null,
    fromEmail: extractEmailAddress(fromRaw) || message.fromEmail || null,
    toEmail: extractEmailAddress(message.to || message.toEmail || "") || message.toEmail || null,
    timestamp: toIsoOrNull(message.sentAt || message.receivedAt || message.createdAt),
    status: message.status || null,
    isRead: direction === "received" ? Boolean(message.read ?? message.isRead) : (direction === "sent" ? true : null),
    rawAdminMessage: message.rawAdminMessage || null,
    renderedHtmlEmail: message.renderedHtmlEmail || message.html || null,
    rawEmailBody: message.rawEmailBody || message.text || null,
    cleanedEmailBody: message.cleanedEmailBody || null,
    gmailMessageId: message.gmailMessageId || null,
    gmailThreadId: message.gmailThreadId || null,
  };
}

function stripHtml(html = "") {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function makeSnippet(mailOptions = {}) {
  const source = mailOptions.text || stripHtml(mailOptions.html || "") || mailOptions.subject || "";
  return String(source).replace(/\s+/g, " ").trim().slice(0, 220);
}


function cleanCustomerReplyBody(input = "") {
  const text = String(input || "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const stopPatterns = [
    /^On\s.+wrote:\s*$/i,
    /^.+wrote:\s*$/i,
    /^-+\s*Original Message\s*-+$/i,
    /^From:\s*SecondHandCell/i,
    /^SecondHandCell\.com\s*$/i,
    /^Turn Your Old\s+Phone Into Cash!/i,
    /^Order confirmation\b/i,
  ];
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('>')) break;
    if (stopPatterns.some((pattern) => pattern.test(trimmed))) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

function safeDocId(value) {
  return String(value || "")
    .trim()
    .replace(/[\/#?[\]]+/g, "_")
    .slice(0, 500);
}

function cleanFirestorePayload(value) {
  if (Array.isArray(value)) {
    return value.map(cleanFirestorePayload).filter((entry) => entry !== undefined);
  }
  if (value && typeof value === "object") {
    if (
      typeof value.toMillis === "function" ||
      typeof value.toDate === "function" ||
      value._methodName ||
      value.constructor?.name === "FieldValue" ||
      /Transform$/.test(String(value.constructor?.name || ""))
    ) {
      return value;
    }
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      out[key] = cleanFirestorePayload(entry);
    }
    return out;
  }
  return value === undefined ? undefined : value;
}

async function getGmailConfig({ includeSecrets = false } = {}) {
  const snap = await configRef().get();
  const data = snap.exists ? snap.data() || {} : {};
  if (!includeSecrets) {
    const { refreshToken, accessToken, ...safe } = data;
    return safe;
  }
  return data;
}

async function getConnectionStatus() {
  const data = await getGmailConfig();
  return {
    configured: isGmailConfigured(),
    status: data.status || "not_connected",
    connected: data.status === "connected",
    mailboxEmail: data.mailboxEmail || null,
    lastSuccessfulSyncAt: data.lastSuccessfulSyncAt || null,
    lastError: data.lastError || null,
    updatedAt: data.updatedAt || null,
  };
}

function buildAuthUrl({ state, promptConsent = true } = {}) {
  const cfg = getOAuthConfig();
  if (!cfg.clientId || !cfg.redirectUri) {
    throw new Error("Gmail OAuth is not configured.");
  }
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
  });
  if (state) params.set("state", state);
  if (promptConsent) params.set("prompt", "consent");
  return `${GMAIL_AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const cfg = getOAuthConfig();
  const response = await axios.post(
    GMAIL_TOKEN_URL,
    new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return response.data || {};
}

async function refreshAccessToken() {
  const cfg = getOAuthConfig();
  const stored = await getGmailConfig({ includeSecrets: true });
  if (!stored.refreshToken) {
    throw new Error("Gmail is not connected.");
  }
  const response = await axios.post(
    GMAIL_TOKEN_URL,
    new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: stored.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  const token = response.data || {};
  const expiresAt = Date.now() + Number(token.expires_in || 3300) * 1000;
  await configRef().set(
    {
      accessToken: token.access_token,
      accessTokenExpiresAt: expiresAt,
      status: "connected",
      lastError: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return token.access_token;
}

async function getAccessToken() {
  const stored = await getGmailConfig({ includeSecrets: true });
  if (stored.accessToken && Number(stored.accessTokenExpiresAt || 0) > Date.now() + 60000) {
    return stored.accessToken;
  }
  return refreshAccessToken();
}

async function gmailRequest(method, path, data = null, options = {}) {
  const token = await getAccessToken();
  const response = await axios({
    method,
    url: `${GMAIL_API_BASE}${path}`,
    data,
    params: options.params,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  return response.data || {};
}

async function connectWithCode(code, metadata = {}) {
  if (!isGmailConfigured()) {
    throw new Error("Gmail OAuth env vars are not configured.");
  }
  const token = await exchangeCodeForTokens(code);
  const accessToken = token.access_token;
  if (!accessToken || !token.refresh_token) {
    throw new Error("Google did not return a refresh token. Reconnect with consent enabled.");
  }

  const profile = await axios.get(`${GMAIL_API_BASE}/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const mailboxEmail = String(profile.data?.emailAddress || "").trim().toLowerCase();
  if (mailboxEmail !== CONNECTED_MAILBOX) {
    throw new Error(`Connected mailbox must be ${CONNECTED_MAILBOX}; got ${mailboxEmail || "unknown"}.`);
  }

  await configRef().set(
    {
      status: "connected",
      mailboxEmail,
      refreshToken: token.refresh_token,
      accessToken,
      accessTokenExpiresAt: Date.now() + Number(token.expires_in || 3300) * 1000,
      connectedAtMs: Date.now(),
      syncSinceMs: Date.now(),
      scopes: GMAIL_SCOPES,
      connectedBy: metadata.uid || null,
      connectedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastError: admin.firestore.FieldValue.delete(),
    },
    { merge: true }
  );
  return { mailboxEmail };
}

async function disconnectGmail(uid = null) {
  await configRef().set(
    {
      status: "not_connected",
      mailboxEmail: null,
      refreshToken: admin.firestore.FieldValue.delete(),
      accessToken: admin.firestore.FieldValue.delete(),
      accessTokenExpiresAt: admin.firestore.FieldValue.delete(),
      disconnectedBy: uid || null,
      disconnectedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function getOrderForTicket(orderId) {
  if (!orderId) return {};
  const snap = await db.collection("orders").doc(orderId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : { id: orderId };
}

function getOrderCustomerName(order = {}) {
  return (
    order?.shippingInfo?.fullName ||
    order?.customerName ||
    order?.name ||
    [order?.firstName, order?.lastName].filter(Boolean).join(" ") ||
    ""
  );
}

function getOrderCustomerEmail(order = {}, fallback = "") {
  return (
    order?.shippingInfo?.email ||
    order?.customerEmail ||
    order?.email ||
    fallback ||
    ""
  );
}

async function ensureTicket(orderId, seed = {}) {
  const normalizedOrderId = normalizeOrderId(orderId);
  if (!normalizedOrderId) return null;

  const order = seed.order || (await getOrderForTicket(normalizedOrderId));
  const customerEmail = getOrderCustomerEmail(order, seed.customerEmail);
  const customerName = getOrderCustomerName(order) || seed.customerName || "";

  const ref = ticketsCollection().doc(normalizedOrderId);
  const snap = await ref.get();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const payload = {
    ticketId: normalizedOrderId,
    orderId: normalizedOrderId,
    customerEmail: customerEmail || null,
    customerName: customerName || null,
    status: snap.exists ? (snap.data()?.status || "open") : "open",
    updatedAt: now,
  };
  if (!snap.exists) {
    payload.createdAt = now;
    payload.messageCount = 0;
    payload.unreadCount = 0;
    payload.lastMessagePreview = "";
    payload.lastMessageDirection = "";
  }
  await ref.set(payload, { merge: true });
  return ref;
}

async function mapGmailThreadToTicket(threadId, orderId) {
  if (!threadId || !orderId) return;
  await threadMapCollection().doc(safeDocId(threadId)).set(
    {
      gmailThreadId: threadId,
      orderId,
      ticketId: orderId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function saveTicketMessage(orderId, message = {}) {
  const ticketRef = await ensureTicket(orderId, {
    customerEmail: message.customerEmail,
    customerName: message.customerName,
  });
  if (!ticketRef) return null;

  const messageId = safeDocId(
    message.gmailMessageId ||
      message.messageId ||
      `local_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
  const messageRef = ticketRef.collection("messages").doc(messageId);
  const existing = await messageRef.get();
  if (existing.exists && message.status !== "failed") {
    return messageRef;
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const direction = normalizeDirection(message.direction || "unknown");
  const cleanedBody = message.cleanedEmailBody || cleanCustomerReplyBody(message.rawEmailBody || message.text || stripHtml(message.html || ""));
  const preview = direction === "received"
    ? (cleanedBody || message.subject || message.snippet || "")
    : (message.subject || message.rawAdminMessage || message.snippet || makeSnippet(message));
  const payload = {
    ...message,
    orderId,
    ticketId: orderId,
    direction,
    read: direction === "sent" ? true : (direction === "received" ? Boolean(message.read) : null),
    isRead: direction === "sent" ? true : (direction === "received" ? Boolean(message.read) : null),
    emailType: direction === "sent" ? inferEmailType(message) : null,
    emailTypeLabel: direction === "sent" ? (EMAIL_TYPE_LABELS[inferEmailType(message)] || "Sent email") : null,
    cleanedEmailBody: direction === "received" ? cleanedBody : null,
    createdAt: message.createdAt || now,
    updatedAt: now,
  };
  await messageRef.set(cleanFirestorePayload(payload), { merge: true });

  const incrementUnread = direction === "received" && !payload.read && !existing.exists;
  await ticketRef.set(
    {
      lastMessageAt: payload.sentAt || payload.receivedAt || now,
      lastMessagePreview: preview,
      lastMessageDirection: direction,
      lastMessageFromCustomer: direction === "received",
      lastSubject: message.subject || "",
      lastGmailThreadId: message.gmailThreadId || null,
      messageCount: admin.firestore.FieldValue.increment(existing.exists ? 0 : 1),
      unreadCount: incrementUnread ? admin.firestore.FieldValue.increment(1) : admin.firestore.FieldValue.increment(0),
      waitingOn: direction === "received" ? "admin" : "customer",
      updatedAt: now,
    },
    { merge: true }
  );

  await db.collection("orders").doc(orderId).set(
    {
      emailTicketId: orderId,
      emailTicketLastMessageAt: payload.sentAt || payload.receivedAt || now,
      emailTicketLastPreview: preview,
      emailTicketLastDirection: direction,
      emailTicketLastFromCustomer: direction === "received",
      emailTicketMessageCount: admin.firestore.FieldValue.increment(existing.exists ? 0 : 1),
      emailTicketUnreadCount: incrementUnread ? admin.firestore.FieldValue.increment(1) : admin.firestore.FieldValue.increment(0),
      emailTicketWaitingOn: direction === "received" ? "admin" : "customer",
      emailTicketUpdatedAt: now,
    },
    { merge: true }
  ).catch((error) => {
    console.error("Failed to update order email ticket summary:", error?.message || error);
  });

  if (message.gmailThreadId) {
    await mapGmailThreadToTicket(message.gmailThreadId, orderId);
  }
  if (message.gmailMessageId) {
    await messageIndexCollection().doc(safeDocId(message.gmailMessageId)).set(
      {
        gmailMessageId: message.gmailMessageId,
        gmailThreadId: message.gmailThreadId || null,
        orderId,
        ticketId: orderId,
        direction,
        importedAt: now,
      },
      { merge: true }
    );
  }
  if (message.rfcMessageId) {
    await messageIndexCollection().doc(safeDocId(message.rfcMessageId)).set(
      {
        rfcMessageId: message.rfcMessageId,
        gmailMessageId: message.gmailMessageId || null,
        gmailThreadId: message.gmailThreadId || null,
        orderId,
        ticketId: orderId,
        direction,
        importedAt: now,
      },
      { merge: true }
    );
  }
  return messageRef;
}

async function buildRawEmail(mailOptions = {}, orderId = "") {
  const headers = {
    ...(mailOptions.headers || {}),
    "X-SHC-Mail-System": "gmail-ticket",
  };
  if (orderId) headers["X-SHC-Order-ID"] = orderId;

  const from =
    mailOptions.from ||
    `"${EMAIL_DISPLAY_NAME}" <${CONNECTED_MAILBOX}>`;
  const composer = new MailComposer({
    ...mailOptions,
    from,
    replyTo: mailOptions.replyTo || CONNECTED_MAILBOX,
    headers,
  });
  const buffer = await composer.compile().build();
  return base64Url(buffer);
}

async function sendViaGmail(mailOptions = {}, { orderId = "", gmailThreadId = "" } = {}) {
  const raw = await buildRawEmail(mailOptions, orderId);
  const body = { raw };
  if (gmailThreadId) body.threadId = gmailThreadId;
  return gmailRequest("post", "/messages/send", body);
}

async function sendTrackedEmail(mailOptions = {}, options = {}) {
  const orderId = normalizeOrderId(options.orderId || extractOrderId(mailOptions));
  const accountEmail = isLikelyAccountEmail(mailOptions);
  const toEmail = extractEmailAddress(mailOptions.to);
  const internalRecipient =
    Boolean(toEmail) &&
    (toEmail === CONNECTED_MAILBOX || toEmail.endsWith("@secondhandcell.com"));
  const fallbackTransporter = options.fallbackTransporter || null;

  if (!orderId || accountEmail || (internalRecipient && options.forceTicket !== true)) {
    if (!fallbackTransporter) {
      throw new Error("No fallback mail transporter provided for non-ticket email.");
    }
    return fallbackTransporter.sendMail(mailOptions);
  }

  await ensureTicket(orderId, {
    customerEmail: toEmail,
    customerName: "",
  });

  const ticketSnap = await ticketsCollection().doc(orderId).get();
  const gmailThreadId = options.gmailThreadId || ticketSnap.data()?.lastGmailThreadId || "";

  try {
    const result = await sendViaGmail(
      {
        ...mailOptions,
        from: `"${EMAIL_DISPLAY_NAME}" <${CONNECTED_MAILBOX}>`,
      },
      { orderId, gmailThreadId }
    );
    await saveTicketMessage(orderId, {
      direction: "sent",
      status: "sent",
      from: CONNECTED_MAILBOX,
      to: normalizeAddress(mailOptions.to),
      customerEmail: toEmail,
      subject: mailOptions.subject || "",
      html: mailOptions.html || "",
      text: mailOptions.text || stripHtml(mailOptions.html || ""),
      rawAdminMessage: mailOptions.text || '',
      renderedHtmlEmail: mailOptions.html || '',
      snippet: makeSnippet(mailOptions),
      gmailMessageId: result.id || null,
      gmailThreadId: result.threadId || gmailThreadId || null,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { ...result, orderId, ticketTracked: true };
  } catch (error) {
    await saveTicketMessage(orderId, {
      direction: "sent",
      status: "failed",
      from: CONNECTED_MAILBOX,
      to: normalizeAddress(mailOptions.to),
      customerEmail: toEmail,
      subject: mailOptions.subject || "",
      html: mailOptions.html || "",
      text: mailOptions.text || stripHtml(mailOptions.html || ""),
      snippet: `Failed to send: ${error?.message || "Unknown Gmail error"}`,
      error: error?.message || String(error),
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    if (fallbackTransporter && String(process.env.GMAIL_TICKET_FALLBACK || "true").toLowerCase() !== "false") {
      const fallbackResult = await fallbackTransporter.sendMail(mailOptions);
      await saveTicketMessage(orderId, {
        direction: "sent",
        status: "sent_fallback",
        from: mailOptions.from || CONNECTED_MAILBOX,
        to: normalizeAddress(mailOptions.to),
        customerEmail: toEmail,
        subject: mailOptions.subject || "",
        snippet: `Sent by fallback after Gmail API failed: ${makeSnippet(mailOptions)}`,
        fallback: true,
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { ...fallbackResult, orderId, ticketTracked: true, fallback: true };
    }
    throw error;
  }
}

function getHeader(headers = [], name) {
  const target = String(name || "").toLowerCase();
  const found = headers.find((h) => String(h.name || "").toLowerCase() === target);
  return found?.value || "";
}

function walkParts(part, collector) {
  if (!part) return;
  const mimeType = part.mimeType || "";
  const data = part.body?.data;
  if (data) {
    if (mimeType === "text/html") collector.html.push(decodeBase64Url(data));
    if (mimeType === "text/plain") collector.text.push(decodeBase64Url(data));
  }
  (part.parts || []).forEach((child) => walkParts(child, collector));
}

function parseGmailMessage(message = {}) {
  const payload = message.payload || {};
  const headers = payload.headers || [];
  const content = { html: [], text: [] };
  walkParts(payload, content);
  return {
    gmailMessageId: message.id,
    gmailThreadId: message.threadId,
    subject: getHeader(headers, "Subject"),
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To"),
    date: getHeader(headers, "Date"),
    inReplyTo: getHeader(headers, "In-Reply-To"),
    references: getHeader(headers, "References"),
    rfcMessageId: getHeader(headers, "Message-ID"),
    shcOrderId: normalizeOrderId(getHeader(headers, "X-SHC-Order-ID")),
    snippet: message.snippet || "",
    html: content.html.join("\n"),
    text: content.text.join("\n"),
    internalDate: message.internalDate,
    labelIds: Array.isArray(message.labelIds) ? message.labelIds : [],
  };
}

function detectMessageDirection({ from = "", to = "", labelIds = [] } = {}) {
  const fromEmail = extractEmailAddress(from);
  const toEmail = extractEmailAddress(to);
  if (Array.isArray(labelIds) && labelIds.includes("SENT")) return "sent";
  if (fromEmail === CONNECTED_MAILBOX) return "sent";
  if (toEmail === CONNECTED_MAILBOX && fromEmail && fromEmail !== CONNECTED_MAILBOX) return "received";
  return "unknown";
}

async function resolveTicketForIncoming(parsed = {}) {
  if (parsed.gmailThreadId) {
    const mapped = await threadMapCollection().doc(safeDocId(parsed.gmailThreadId)).get();
    if (mapped.exists && mapped.data()?.orderId) {
      return normalizeOrderId(mapped.data().orderId);
    }
  }

  const replyHeaders = [parsed.inReplyTo, parsed.references]
    .filter(Boolean)
    .join(" ")
    .match(/<[^>]+>/g) || [];
  for (const headerId of replyHeaders) {
    const indexed = await messageIndexCollection().doc(safeDocId(headerId)).get();
    if (indexed.exists && indexed.data()?.orderId) {
      return normalizeOrderId(indexed.data().orderId);
    }
  }

  const headerOrderId = normalizeOrderId(parsed.shcOrderId || "");
  if (headerOrderId) {
    const orderSnap = await db.collection("orders").doc(headerOrderId).get();
    if (orderSnap.exists) return headerOrderId;
  }

  const fromHeader = [parsed.subject, parsed.shcOrderId, parsed.text, parsed.html].join(" ");
  const orderId = normalizeOrderId(fromHeader);
  if (orderId) {
    const orderSnap = await db.collection("orders").doc(orderId).get();
    if (orderSnap.exists) return orderId;
  }
  return "";
}

async function importGmailMessage(messageId) {
  const indexDoc = await messageIndexCollection().doc(safeDocId(messageId)).get();
  if (indexDoc.exists) {
    return { skipped: true, reason: "duplicate" };
  }

  const full = await gmailRequest("get", `/messages/${encodeURIComponent(messageId)}`, null, {
    params: { format: "full" },
  });
  const parsed = parseGmailMessage(full);
  const fromEmail = extractEmailAddress(parsed.from);
  const detectedDirection = detectMessageDirection(parsed);
  if (detectedDirection === "sent") {
    await messageIndexCollection().doc(safeDocId(messageId)).set({
      gmailMessageId: messageId,
      gmailThreadId: parsed.gmailThreadId || null,
      direction: "outbound_existing",
      importedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { skipped: true, reason: "sent_by_us" };
  }

  const orderId = await resolveTicketForIncoming(parsed);
  const receivedAt = parsed.internalDate
    ? admin.firestore.Timestamp.fromMillis(Number(parsed.internalDate))
    : admin.firestore.FieldValue.serverTimestamp();

  if (orderId) {
    const rawEmailBody = parsed.text || stripHtml(parsed.html);
    const cleanedEmailBody = cleanCustomerReplyBody(rawEmailBody);
    await saveTicketMessage(orderId, {
      direction: detectedDirection,
      fromName: String(parsed.from || "").split("<")[0].replace(/\"/g, "").trim() || null,
      status: "received",
      from: parsed.from,
      to: parsed.to,
      customerEmail: fromEmail,
      subject: parsed.subject,
      html: parsed.html,
      text: parsed.text,
      snippet: parsed.snippet || parsed.text || stripHtml(parsed.html),
      rawEmailBody,
      cleanedEmailBody,
      gmailMessageId: parsed.gmailMessageId,
      gmailThreadId: parsed.gmailThreadId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      receivedAt,
      read: detectedDirection === "received" ? false : true,
      labelIds: parsed.labelIds || [],
    });
    return { imported: true, orderId };
  }

  await unassignedCollection().doc(safeDocId(parsed.gmailMessageId)).set({
    ...parsed,
    fromEmail,
    status: "unassigned",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    receivedAt,
  });
  await messageIndexCollection().doc(safeDocId(messageId)).set({
    gmailMessageId: messageId,
    gmailThreadId: parsed.gmailThreadId || null,
    direction: "inbound_unassigned",
    importedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { imported: true, unassigned: true };
}

async function getSyncSinceMs() {
  const stored = await getGmailConfig({ includeSecrets: true });
  const syncSinceMs = Number(stored.syncSinceMs || stored.connectedAtMs || 0);
  if (syncSinceMs > 0) return syncSinceMs;

  const nowMs = Date.now();
  await configRef().set(
    {
      syncSinceMs: nowMs,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return nowMs;
}

async function importNewGmailMessage(messageId, { syncSinceMs = 0 } = {}) {
  const indexDoc = await messageIndexCollection().doc(safeDocId(messageId)).get();
  if (indexDoc.exists) {
    return { skipped: true, reason: "duplicate" };
  }

  const full = await gmailRequest("get", `/messages/${encodeURIComponent(messageId)}`, null, {
    params: { format: "full" },
  });
  const messageMs = Number(full.internalDate || 0);
  if (syncSinceMs && messageMs && messageMs < syncSinceMs) {
    await messageIndexCollection().doc(safeDocId(messageId)).set({
      gmailMessageId: messageId,
      gmailThreadId: full.threadId || null,
      direction: "ignored_before_sync_start",
      importedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { skipped: true, reason: "before_sync_start" };
  }
  return importParsedGmailMessage(full);
}

async function importParsedGmailMessage(full) {
  const parsed = parseGmailMessage(full);
  const fromEmail = extractEmailAddress(parsed.from);
  const detectedDirection = detectMessageDirection(parsed);
  if (detectedDirection === "sent") {
    await messageIndexCollection().doc(safeDocId(parsed.gmailMessageId)).set({
      gmailMessageId: parsed.gmailMessageId,
      gmailThreadId: parsed.gmailThreadId || null,
      direction: "outbound_existing",
      importedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { skipped: true, reason: "sent_by_us" };
  }

  const orderId = await resolveTicketForIncoming(parsed);
  const receivedAt = parsed.internalDate
    ? admin.firestore.Timestamp.fromMillis(Number(parsed.internalDate))
    : admin.firestore.FieldValue.serverTimestamp();

  if (orderId) {
    const rawEmailBody = parsed.text || stripHtml(parsed.html);
    const cleanedEmailBody = cleanCustomerReplyBody(rawEmailBody);
    await saveTicketMessage(orderId, {
      direction: detectedDirection,
      fromName: String(parsed.from || "").split("<")[0].replace(/\"/g, "").trim() || null,
      status: "received",
      from: parsed.from,
      to: parsed.to,
      customerEmail: fromEmail,
      subject: parsed.subject,
      html: parsed.html,
      text: parsed.text,
      snippet: parsed.snippet || parsed.text || stripHtml(parsed.html),
      rawEmailBody,
      cleanedEmailBody,
      gmailMessageId: parsed.gmailMessageId,
      gmailThreadId: parsed.gmailThreadId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      receivedAt,
      read: detectedDirection === "received" ? false : true,
      labelIds: parsed.labelIds || [],
    });
    return { imported: true, orderId };
  }

  await unassignedCollection().doc(safeDocId(parsed.gmailMessageId)).set({
    ...parsed,
    fromEmail,
    status: "unassigned",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    receivedAt,
  });
  await messageIndexCollection().doc(safeDocId(parsed.gmailMessageId)).set({
    gmailMessageId: parsed.gmailMessageId,
    gmailThreadId: parsed.gmailThreadId || null,
    direction: "inbound_unassigned",
    importedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { imported: true, unassigned: true };
}

async function assignUnassignedToTicket(unassignedId, orderId, metadata = {}) {
  const normalizedOrderId = normalizeOrderId(orderId);
  if (!normalizedOrderId) {
    throw new Error("A valid order number is required.");
  }

  const orderSnap = await db.collection("orders").doc(normalizedOrderId).get();
  if (!orderSnap.exists) {
    throw new Error(`Order ${normalizedOrderId} was not found.`);
  }

  const safeId = safeDocId(unassignedId);
  const unassignedRef = unassignedCollection().doc(safeId);
  const unassignedSnap = await unassignedRef.get();
  if (!unassignedSnap.exists) {
    throw new Error("Unassigned email was not found.");
  }

  const message = unassignedSnap.data() || {};
  await saveTicketMessage(normalizedOrderId, {
    direction: "received",
    fromName: String(message.from || "").split("<")[0].replace(/\"/g, "").trim() || null,
    status: "received",
    from: message.from || "",
    to: message.to || "",
    customerEmail: message.fromEmail || extractEmailAddress(message.from),
    subject: message.subject || "",
    html: message.html || "",
    text: message.text || "",
    snippet: message.snippet || message.text || stripHtml(message.html || ""),
    rawEmailBody: message.text || stripHtml(message.html || ""),
    cleanedEmailBody: cleanCustomerReplyBody(message.text || stripHtml(message.html || "")),
    gmailMessageId: message.gmailMessageId || safeId,
    gmailThreadId: message.gmailThreadId || null,
    inReplyTo: message.inReplyTo || "",
    references: message.references || "",
    receivedAt: message.receivedAt || admin.firestore.FieldValue.serverTimestamp(),
    read: false,
    assignedBy: metadata.uid || null,
    assignedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  if (message.gmailThreadId) {
    await mapGmailThreadToTicket(message.gmailThreadId, normalizedOrderId);
  }

  await messageIndexCollection().doc(safeDocId(message.gmailMessageId || safeId)).set(
    {
      gmailMessageId: message.gmailMessageId || safeId,
      gmailThreadId: message.gmailThreadId || null,
      orderId: normalizedOrderId,
      ticketId: normalizedOrderId,
      direction: "inbound_assigned",
      assignedBy: metadata.uid || null,
      assignedAt: admin.firestore.FieldValue.serverTimestamp(),
      importedAt: message.importedAt || admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await unassignedRef.delete();
  return { ok: true, orderId: normalizedOrderId };
}

async function syncGmail({ maxResults = 50, query = "" } = {}) {
  const syncSinceMs = await getSyncSinceMs();
  const syncAfter = new Date(syncSinceMs);
  const syncAfterQuery = `${syncAfter.getUTCFullYear()}/${syncAfter.getUTCMonth() + 1}/${syncAfter.getUTCDate()}`;
  const q = query || `after:${syncAfterQuery}`;
  const list = await gmailRequest("get", "/messages", null, {
    params: { maxResults, q },
  });
  const messages = Array.isArray(list.messages) ? list.messages : [];
  const result = { scanned: messages.length, imported: 0, skipped: 0, unassigned: 0, failed: 0 };
  for (const item of messages) {
    try {
      const imported = await importNewGmailMessage(item.id, { syncSinceMs });
      if (imported.skipped) result.skipped += 1;
      else {
        result.imported += 1;
        if (imported.unassigned) result.unassigned += 1;
      }
    } catch (error) {
      result.failed += 1;
      console.error("Failed to import Gmail message:", item.id, error?.message || error);
    }
  }
  await configRef().set(
    {
      lastSuccessfulSyncAt: admin.firestore.FieldValue.serverTimestamp(),
      lastSyncResult: result,
      lastError: result.failed ? `${result.failed} message(s) failed to import.` : admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return result;
}

async function getTicket(orderId, { create = false } = {}) {
  const normalizedOrderId = normalizeOrderId(orderId);
  if (!normalizedOrderId) return null;
  const ticketSnap = await ticketsCollection().doc(normalizedOrderId).get();
  if (!ticketSnap.exists) {
    if (!create) return null;
    await ensureTicket(normalizedOrderId);
  }
  const messagesSnap = await ticketsCollection()
    .doc(normalizedOrderId)
    .collection("messages")
    .orderBy("createdAt", "asc")
    .limit(100)
    .get();
  return {
    id: normalizedOrderId,
    ...(ticketSnap.data() || {}),
    messages: messagesSnap.docs
      .map((doc) => normalizeTicketMessage(doc.id, doc.data() || {}))
      .sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || ""))),
  };
}

async function markTicketRead(orderId) {
  const normalizedOrderId = normalizeOrderId(orderId);
  if (!normalizedOrderId) return null;
  const ticketRef = ticketsCollection().doc(normalizedOrderId);
  const unread = await ticketRef.collection("messages").where("direction", "==", "received").where("read", "==", false).get();
  const batch = db.batch();
  unread.docs.forEach((doc) => batch.set(doc.ref, { read: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }));
  batch.set(ticketRef, { unreadCount: 0, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  batch.set(db.collection("orders").doc(normalizedOrderId), {
    emailTicketUnreadCount: 0,
    emailTicketUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  await batch.commit();
  return { ok: true, marked: unread.size };
}

async function listInbox({ filter = "all", limit = 50 } = {}) {
  const requestedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  if (filter === "unassigned") {
    const snap = await unassignedCollection().orderBy("createdAt", "desc").limit(requestedLimit).get();
    return snap.docs.map((doc) => ({ id: doc.id, type: "unassigned", unassigned: true, ...doc.data() }));
  }
  const queryLimit = filter === "unread" ? Math.max(requestedLimit, 150) : requestedLimit;
  const query = ticketsCollection().orderBy("updatedAt", "desc").limit(queryLimit);
  const snap = await query.get();
  let tickets = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  if (filter === "unread") {
    tickets = tickets.filter((ticket) => Number(ticket.unreadCount || 0) > 0);
  }
  return tickets.slice(0, requestedLimit);
}

module.exports = {
  CONNECTED_MAILBOX,
  GMAIL_SCOPES,
  assignUnassignedToTicket,
  buildAuthUrl,
  connectWithCode,
  disconnectGmail,
  ensureTicket,
  extractOrderId,
  getConnectionStatus,
  getTicket,
  listInbox,
  markTicketRead,
  normalizeOrderId,
  sendTrackedEmail,
  syncGmail,
};
