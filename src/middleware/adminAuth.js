function adminAuth(req, res, next) {
  const expected = process.env.ANALYTICS_ADMIN_TOKEN;
  if (!expected) {
    return res.status(500).json({ error: 'analytics_admin_token_not_configured' });
  }

  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const token = auth.slice('Bearer '.length).trim();
  if (token !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  return next();
}

module.exports = adminAuth;
