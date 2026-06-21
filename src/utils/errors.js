function notFoundHandler(req, res) {
  res.status(404).json({
    ok: false,
    error: 'Not found',
    path: req.originalUrl,
  });
}

function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Unexpected server error';
  console.error('[API] unhandled route error:', {
    method: req.method,
    path: req.originalUrl || req.url,
    status,
    message,
    detail: err.detail || null,
    stack: err.stack || null,
  });
  res.status(status).json({
    ok: false,
    error: message,
    detail: err.detail || null,
  });
}

module.exports = { notFoundHandler, errorHandler };
