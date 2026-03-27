const { getFirestore } = require('firebase-admin/firestore');
const { initFirebaseAdmin } = require('../../functions/helpers/firebaseAdmin');

initFirebaseAdmin();

const db = getFirestore();
const sessionsCollection = db.collection('analytics_sessions');

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function serializeSession(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    session_id: data.session_id || doc.id,
    root_session_id: data.root_session_id || null,
    session_index: Number.isFinite(Number(data.session_index)) ? Number(data.session_index) : 1,
    first_seen: toDate(data.first_seen),
    last_seen: toDate(data.last_seen),
    landing_url: data.landing_url || null,
    landing_path: data.landing_path || null,
    landing_query: data.landing_query || null,
    referrer: data.referrer || null,
    source: data.source || null,
    utm: data.utm || {},
    user_agent: data.user_agent || null,
    ip_masked: data.ip_masked || null,
    ip_full: data.ip_full || null,
    country: data.country || null,
    region: data.region || null,
    city: data.city || null,
    notes: Array.isArray(data.notes) ? data.notes : [],
    converted: Boolean(data.converted),
    conversion_time: toDate(data.conversion_time),
    landing_extra: data.landing_extra || null,
    event_count: Number.isFinite(Number(data.event_count)) ? Number(data.event_count) : 0,
  };
}

function serializeEvent(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    session_id: data.session_id || null,
    ts: toDate(data.ts),
    event_type: data.event_type || null,
    page_url: data.page_url || null,
    path: data.path || null,
    query: data.query || null,
    referrer: data.referrer || null,
    element: data.element || null,
    extra: data.extra || null,
    seq: Number.isFinite(Number(data.seq)) ? Number(data.seq) : 0,
  };
}

async function resolveServerSession(cookieSessionId, sessionTimeoutMs) {
  const snapshot = await sessionsCollection
    .where('root_session_id', '==', cookieSessionId)
    .get();

  if (snapshot.empty) {
    return {
      sessionId: cookieSessionId,
      sessionIndex: 1,
      isNewSession: true,
    };
  }

  const sessions = snapshot.docs.map(serializeSession);
  const latest = sessions.reduce((acc, session) => {
    if (!acc) return session;
    const accMs = acc.last_seen ? acc.last_seen.getTime() : 0;
    const sessionMs = session.last_seen ? session.last_seen.getTime() : 0;
    return sessionMs > accMs ? session : acc;
  }, null);

  const maxIndex = sessions.reduce((acc, session) => Math.max(acc, session.session_index || 1), 1);
  const latestMs = latest?.last_seen ? latest.last_seen.getTime() : 0;
  const isTimedOut = Date.now() - latestMs > sessionTimeoutMs;

  if (!isTimedOut) {
    return {
      sessionId: latest.session_id,
      sessionIndex: latest.session_index || 1,
      isNewSession: false,
    };
  }

  return {
    sessionId: `${cookieSessionId}:${maxIndex + 1}`,
    sessionIndex: maxIndex + 1,
    isNewSession: true,
  };
}

async function setSession(sessionId, payload) {
  await sessionsCollection.doc(sessionId).set(payload, { merge: true });
}

async function addSessionEvent(sessionId, payload) {
  await sessionsCollection.doc(sessionId).collection('events').add(payload);
}

async function getSession(sessionId) {
  const doc = await sessionsCollection.doc(sessionId).get();
  if (!doc.exists) return null;
  return serializeSession(doc);
}

async function getSessionEvents(sessionId) {
  const snapshot = await sessionsCollection.doc(sessionId).collection('events').get();
  return snapshot.docs
    .map(serializeEvent)
    .sort((a, b) => {
      const aMs = a.ts ? a.ts.getTime() : 0;
      const bMs = b.ts ? b.ts.getTime() : 0;
      if (aMs !== bMs) return aMs - bMs;
      return a.seq - b.seq;
    });
}

async function listSessionsInRange(from, to) {
  const snapshot = await sessionsCollection
    .where('first_seen', '>=', from)
    .where('first_seen', '<=', to)
    .get();

  return snapshot.docs
    .map(serializeSession)
    .sort((a, b) => (b.first_seen?.getTime() || 0) - (a.first_seen?.getTime() || 0));
}

async function listEventsInRange(from, to) {
  const snapshot = await db
    .collectionGroup('events')
    .where('ts', '>=', from)
    .where('ts', '<=', to)
    .get();

  return snapshot.docs
    .map(serializeEvent)
    .sort((a, b) => {
      const aMs = a.ts ? a.ts.getTime() : 0;
      const bMs = b.ts ? b.ts.getTime() : 0;
      if (aMs !== bMs) return aMs - bMs;
      return a.seq - b.seq;
    });
}

module.exports = {
  addSessionEvent,
  getSession,
  getSessionEvents,
  listEventsInRange,
  listSessionsInRange,
  resolveServerSession,
  setSession,
  toDate,
};
