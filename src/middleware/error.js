// Last-resort error handler. The client expects every response to follow the
// `{ ok: false, error }` envelope, so coerce unexpected throws into it.

export function notFound(req, res) {
  res.status(404).json({ ok: false, error: `No route for ${req.method} ${req.path}` });
}

export function errorHandler(err, req, res, _next) {
  // eslint-disable-next-line no-console
  console.error('[server]', err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    ok: false,
    error: err.publicMessage || (status >= 500 ? 'Internal error' : err.message),
  });
}
