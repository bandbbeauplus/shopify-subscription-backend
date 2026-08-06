function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  console.error(`${req.method} ${req.originalUrl} failed:`, err);

  const status = err.statusCode || err.status || 500;
  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : err.message,
  });
}

module.exports = errorHandler;
