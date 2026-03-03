function normalizeUtm(utmInput) {
  if (!utmInput || typeof utmInput !== 'object') return {};
  const allowed = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  const normalized = {};
  for (const key of allowed) {
    const value = utmInput[key];
    if (typeof value === 'string' && value.trim()) {
      normalized[key] = value.trim().slice(0, 200);
    }
  }
  return normalized;
}

function parseUrl(urlValue) {
  if (!urlValue || typeof urlValue !== 'string') return null;
  try {
    return new URL(urlValue);
  } catch (error) {
    return null;
  }
}

function deriveReferrerSource(referrer) {
  const refUrl = parseUrl(referrer);
  if (!refUrl) return 'direct';
  const host = refUrl.hostname.toLowerCase();
  if (host.includes('google.')) return 'organic_google';
  if (host.includes('bing.')) return 'organic_bing';
  if (host.includes('duckduckgo.')) return 'organic_duckduckgo';
  if (host.includes('facebook.') || host.includes('instagram.')) return 'social_meta';
  if (host.includes('t.co') || host.includes('twitter.') || host.includes('x.com')) return 'social_x';
  return `referral_${host}`.slice(0, 120);
}

function deriveSource({ pageUrl, referrer }) {
  const url = parseUrl(pageUrl);
  const utm = normalizeUtm(url ? Object.fromEntries(url.searchParams.entries()) : {});

  if (utm.utm_source) {
    const source = [utm.utm_source, utm.utm_medium, utm.utm_campaign].filter(Boolean).join(':');
    return { source: source.slice(0, 120), utm };
  }

  return {
    source: deriveReferrerSource(referrer),
    utm,
  };
}

module.exports = {
  deriveSource,
};
