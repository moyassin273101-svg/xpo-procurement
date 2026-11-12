'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const config = require('./config');
const db = require('./db');
const { P, MATRIX, can } = require('./rbac');
const { wrap, authenticate, permit, validate } = require('./middleware');
const { HttpError } = require('./errors');
const requests = require('./services/requests');
const delegations = require('./services/delegations');
const invoices = require('./services/invoices');
const reports = require('./services/reports');
const audit = require('./services/audit');
const { XPO } = require('./services/xpo');
const analyst = require('./ai/analyst');
const invoiceAgent = require('./ai/invoiceAgent');

const r = express.Router();
const id = z.coerce.number().int().positive();
const money = z.coerce.number().positive().max(1e10);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max) => z.string().trim().max(max);
const pid = (req) => { const p = id.safeParse(req.params.id); if (!p.success) throw new HttpError(400, 'معرّف غير صالح'); return p.data; };

// ---------- Auth ----------
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: config.isTest ? 1000 : 20, standardHeaders: 'draft-7', legacyHeaders: false });
r.post('/auth/login', loginLimiter, validate(z.object({ email: z.string().email(), password: z.string().min(1).max(200) })),
  wrap(async (req, res) => {
    const { rows: [u] } = await db.query('SELECT * FROM users WHERE lower(email) = lower($1)', [req.body.email]);
    const ok = u && u.active && (await bcrypt.compare(req.body.password, u.password_hash));
    if (!ok) throw new HttpError(401, 'بيانات الدخول غير صحيحة');
    const token = jwt.sign({ sub: u.id, role: u.role }, config.jwtSecret, { algorithm: 'HS256', expiresIn: config.jwtTtl });
    await db.tx((c) => audit.append(c, { actorId: u.id, action: 'login', entity: 'user', entityId: u.id }));
    res.json({ token, user: { id: u.id, name: u.name, email: u.email, role: u.role, project: u.project } });
  }));

r.use(authenticate);

r.get('/me', (req, res) => res.json({ user: req.user, permissions: MATRIX[req.user.role],
  config: { thresholds: { cfo: XPO.CFG.T_CFO, ceo: XPO.CFG.T_CEO }, vat: XPO.CFG.VAT, stages: XPO.STAGE_AR } }));
r.get('/users', permit(P.USER_READ), wrap(async (_req, res) => {
  res.json((await db.query('SELECT id, name, email, role, project FROM users WHERE active ORDER BY role, name')).rows);
}));
r.get('/vendors', wrap(async (_req, res) => res.json((await db.query('SELECT id, name FROM vendors ORDER BY name')).rows)));

// ---------- Requests ----------
r.post('/requests', permit(P.REQ_CREATE), validate(z.object({
  vendor_id: id, item: text(300).min(1), qty: z.coerce.number().positive().max(1e9), amount: money,
  vat_included: z.boolean(), quote_ref: text(200).min(1), quotes_count: z.coerce.number().int().min(1).max(20).optional(),
  notes: text(1000).optional(), project: text(100).optional(), confirm_dup: z.boolean().optional(),
})), wrap(async (req, res) => res.status(201).json(await requests.create(db, req.user, req.body))));

r.get('/requests', permit(P.REQ_READ), wrap(async (req, res) => {
  const q = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(), project: z.string().max(100).optional(),
    flag: z.string().max(40).optional(), flagged: z.enum(['true', 'false']).optional(), q: z.string().max(100).optional(),
    limit: z.coerce.number().optional(), offset: z.coerce.number().optional() }).parse(req.query);
  res.json(await requests.list(db, req.user, { ...q, flagged: q.flagged === 'true' }));
}));
r.get('/requests/inbox', permit(P.REQ_APPROVE), wrap(async (req, res) => res.json(await requests.inbox(db, req.user))));
r.get('/requests/:id', permit(P.REQ_READ), wrap(async (req, res) => res.json(await requests.get(db, req.user, pid(req)))));
// Stage eligibility (pm of project, CFO or active delegate, CEO) is decided by XPO.canApprove.
r.post('/requests/:id/decision', permit(P.REQ_APPROVE),
  validate(z.object({ decision: z.enum(['approved', 'rejected']), comment: text(1000).optional() })),
  wrap(async (req, res) => res.json(await requests.decide(db, req.user, pid(req), req.body))));
r.post('/requests/:id/cancel', permit(P.REQ_CREATE), validate(z.object({ reason: text(500).optional() })),
  wrap(async (req, res) => res.json(await requests.cancel(db, req.user, pid(req), req.body.reason))));
r.post('/requests/:id/override-grouping', permit(P.REQ_OVERRIDE), validate(z.object({ reason: text(500).min(1) })),
  wrap(async (req, res) => res.json(await requests.overrideGrouping(db, req.user, pid(req), req.body.reason))));
r.post('/requests/:id/dispatch', permit(P.REQ_DISPATCH),
  wrap(async (req, res) => res.json(await requests.dispatch(db, req.user, pid(req)))));

r.get('/supplier/orders', permit(P.SUPPLIER_ORDERS), wrap(async (req, res) => res.json(await requests.supplierOrders(db, req.user))));

// ---------- Delegations ----------
r.get('/delegations', permit(P.DELEG_READ), wrap(async (req, res) => res.json(await delegations.list(db, req.user))));
r.post('/delegations', permit(P.DELEG_CREATE), validate(z.object({
  to_id: id, starts_at: z.coerce.date(), ends_at: z.coerce.date(), reason: text(300).optional() })),
wrap(async (req, res) => res.status(201).json(await delegations.create(db, req.user, req.body))));
r.post('/delegations/:id/revoke', permit(P.DELEG_REVOKE),
  wrap(async (req, res) => res.json(await delegations.revoke(db, req.user, pid(req)))));

// ---------- Invoices ----------
const invoiceBody = z.object({
  po_no: text(40).min(1), vendor: text(200).optional(), invoice_no: text(60).optional(), vat_no: text(30).optional(),
  subtotal: z.coerce.number().min(0).optional(), vat: z.coerce.number().min(0).optional(), amount: money,
  qty: z.coerce.number().positive().optional(), date: isoDate.optional(),
});
r.get('/invoices', permit(P.INV_READ), wrap(async (req, res) => res.json(await invoices.list(db, req.query))));
r.post('/invoices', permit(P.INV_CREATE), validate(invoiceBody),
  wrap(async (req, res) => res.status(201).json(await invoices.create(db, req.user, { ...req.body, source: 'manual' }))));
r.get('/invoices/:id', permit(P.INV_READ), wrap(async (req, res) => res.json(await invoices.get(db, pid(req)))));
r.post('/invoices/:id/post', permit(P.INV_POST), validate(z.object({ override: z.boolean().optional(), reason: text(500).optional() })),
  wrap(async (req, res) => res.json(await invoices.post(db, req.user, pid(req), req.body))));
r.post('/invoices/:id/reject', permit(P.INV_REJECT), validate(z.object({ reason: text(500).min(1) })),
  wrap(async (req, res) => res.json(await invoices.reject(db, req.user, pid(req), req.body.reason))));

// ---------- Reports ----------
r.get('/reports/kpis', permit(P.REPORT_KPI), wrap(async (req, res) => res.json(await reports.kpis(db, req.user))));
r.get('/reports/aging', permit(P.REPORT_KPI), wrap(async (req, res) => res.json(await reports.aging(db, req.user))));
r.get('/reports/budgets', permit(P.REPORT_BUDGET), wrap(async (req, res) => res.json(await reports.budgets(db, req.user))));
r.get('/reports/vendor-risk', permit(P.REPORT_VENDOR), wrap(async (req, res) => res.json(await reports.vendorRisk(db, req.user))));
const csv = (name, fn) => wrap(async (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(await fn(req));
});
r.get('/reports/export/requests.csv', permit(P.REPORT_EXPORT), csv('requests.csv', (req) => reports.exportRequests(db, req.user)));
r.get('/reports/export/audit.csv', permit(P.AUDIT_READ), csv('audit.csv', () => reports.exportAudit(db)));

// ---------- Audit ----------
r.get('/audit', permit(P.AUDIT_READ), wrap(async (req, res) => res.json(await audit.list(db, req.query))));
r.get('/audit/verify', permit(P.AUDIT_READ), wrap(async (_req, res) => res.json(await audit.verify(db))));

// ---------- AI ----------
const aiLimiter = rateLimit({ windowMs: 60_000, limit: 10, keyGenerator: (req) => String(req.user.id), standardHeaders: 'draft-7', legacyHeaders: false });
r.post('/ai/analyst', permit(P.AI_ANALYST), aiLimiter, validate(z.object({
  question: text(2000).min(2),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) })).max(10).optional(),
})), wrap(async (req, res) => res.json(await analyst.ask(db, req.user, req.body.question, req.body.history || []))));
r.post('/ai/invoice', permit(P.AI_INVOICE), aiLimiter, validate(z.object({
  text: z.string().max(50_000).optional(), file_base64: z.string().max(14_000_000).optional(),
  media_type: z.string().optional(), save: z.boolean().optional(),
}).refine((b) => b.text || b.file_base64, 'أرسل نصًا أو ملفًا')),
wrap(async (req, res) => {
  if (req.body.save && !can(req.user, P.INV_CREATE)) throw new HttpError(403, 'ليست لديك صلاحية حفظ الفواتير');
  res.json(await invoiceAgent.process(db, req.user, req.body));
}));

module.exports = r;
