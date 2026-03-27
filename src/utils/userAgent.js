function inferUserAgentMetadata(userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  if (!ua) {
    return {
      browser: null,
      os: null,
      deviceType: null,
      deviceName: null,
      isBot: false,
    };
  }

  let browser = null;
  if (ua.includes('edg/')) browser = 'Edge';
  else if (ua.includes('opr/') || ua.includes('opera')) browser = 'Opera';
  else if (ua.includes('chrome/') && !ua.includes('edg/')) browser = 'Chrome';
  else if (ua.includes('safari/') && !ua.includes('chrome/')) browser = 'Safari';
  else if (ua.includes('firefox/')) browser = 'Firefox';
  else if (ua.includes('msie') || ua.includes('trident/')) browser = 'Internet Explorer';

  let os = null;
  if (ua.includes('windows nt')) os = 'Windows';
  else if (ua.includes('android')) os = 'Android';
  else if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios')) os = 'iOS';
  else if (ua.includes('mac os x') || ua.includes('macintosh')) os = 'macOS';
  else if (ua.includes('linux')) os = 'Linux';

  let deviceType = null;
  if (ua.includes('ipad') || ua.includes('tablet')) deviceType = 'tablet';
  else if (ua.includes('mobile') || ua.includes('iphone') || ua.includes('android')) deviceType = 'mobile';
  else deviceType = 'desktop';

  const isBot = /(bot|crawler|spider|slurp|headless|preview|facebookexternalhit|pingdom|uptimerobot)/i.test(ua);

  let deviceName = null;
  if (ua.includes('iphone')) deviceName = 'iPhone';
  else if (ua.includes('ipad')) deviceName = 'iPad';
  else if (ua.includes('macintosh') || ua.includes('mac os x')) deviceName = 'Mac';
  else if (ua.includes('windows nt')) deviceName = 'Windows PC';
  else if (ua.includes('android')) {
    const buildMatch = userAgent.match(/Android [^;)]*;\s*([^;)]+?)\s+Build/i);
    const androidModel = buildMatch?.[1]?.trim();
    if (androidModel) {
      deviceName = androidModel;
    } else if (ua.includes('samsung')) {
      deviceName = 'Samsung Android Device';
    } else if (ua.includes('pixel')) {
      deviceName = 'Google Pixel';
    } else {
      deviceName = 'Android Device';
    }
  } else if (deviceType === 'desktop') {
    deviceName = 'Desktop';
  } else if (deviceType === 'tablet') {
    deviceName = 'Tablet';
  } else if (deviceType === 'mobile') {
    deviceName = 'Mobile Device';
  }

  return {
    browser,
    os,
    deviceType,
    deviceName,
    isBot,
  };
}

module.exports = {
  inferUserAgentMetadata,
};
