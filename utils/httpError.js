// Small helper to throw errors that carry an HTTP status code.
// Express 5 forwards rejected promises from async handlers to the error
// middleware automatically, so controllers can simply `throw httpError(...)`.
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = httpError;
