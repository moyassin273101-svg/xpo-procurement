'use strict';
const jwt = require('jsonwebtoken');
const { ZodError } = require('zod');
const config = require('./config');
const db = require('./db');
const { can } = require('./rbac');
const { HttpError } = require('./errors');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Verify JWT and reload the user each request so deactivation/role change applies immediately. */
const authenticate = wrap(async (req, _res, next) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) throw new HttpError(401, 'مطلوب تسجيل الدخول');
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    throw new HttpError(401, 'جلسة غير صالحة أو منتهية');
  }
  if (!Number.isInteger(payload.sub)) throw new HttpError(401, 'جلسة غير صالحة أو منتهية');
  const { rows } = await db.query(
    'SELECT id, email, name, role, project, vendor_id, active FROM users WHERE id = $1', [payload.sub]);
  if (!rows[0] || !rows[0].active) throw new HttpError(401, 'الحساب غير نشط');
  req.user = rows[0];
  next();
});

const permit = (...perms) => (req, _res, next) => {
  if (!perms.every((p) => can(req.user, p))) return next(new HttpError(403, 'ليست لديك صلاحية لهذا الإجراء'));
  next();
};

const validate = (schema, where = 'body') => (req, _res, next) => {
  const r = schema.safeParse(req[where]);
  if (!r.success) return next(r.error);
  req[where === 'body' ? 'body' : 'valid'] = r.data;
  next();
};

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError)
    return res.status(400).json({ error: 'بيانات غير صالحة', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
  if (err.code === '23505') return res.status(409).json({ error: 'سجل مكرر', details: err.detail });
  if (err.code === '23503') return res.status(400).json({ error: 'مرجع غير موجود', details: err.detail });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON غير صالح' });
  console.error(err);
  res.status(500).json({ error: 'خطأ داخلي في الخادم' });
}

module.exports = { wrap, authenticate, permit, validate, errorHandler };
