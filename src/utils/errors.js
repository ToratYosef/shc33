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
  res.status(status).json({
    ok: false,
    error: message,
    detail: err.detail || null,
  });
}

module.exports = { notFoundHandler, errorHandler };
