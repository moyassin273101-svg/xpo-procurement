'use strict';
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
const bad = (m, d) => new HttpError(400, m, d);
const forbidden = (m = 'غير مصرح') => new HttpError(403, m);
const notFound = (m = 'غير موجود') => new HttpError(404, m);
const conflict = (m, d) => new HttpError(409, m, d);

module.exports = { HttpError, bad, forbidden, notFound, conflict };
