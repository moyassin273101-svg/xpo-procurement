'use strict';
// Invoices; matching and posting rules are XENT (src/xpo/enterprise.js).
const { XENT, XPO, request: toEngReq, user: toEngUser } = require('./xpo');
const audit = require('./audit');
const { bad, notFound, forbidden, conflict } = require('../errors');
const { BASE } = require('./requests');

const ROW = (i) => ({ id: i.code, dbId: i.id, poNo: i.po_no, project: i.project, vendor: i.vendor, invoiceNo: i.invoice_no,
  vatNo: i.vat_no, subtotal: i.subtotal, vat: i.vat, amount: Number(i.amount), qty: i.qty == null ? null : Number(i.qty),
  date: i.date, source: i.source, status: i.status, verdict: i.verdict, flags: i.flags, createdBy: i.created_by });

/** Build the minimal engine state for matching `inv`: its PO plus the vendor's other invoices. */
async function matchState(c, inv) {
  const { rows: pos } = await c.query(`${BASE} WHERE r.no = $1`, [inv.poNo]);
  const vendor = inv.vendor || pos[0]?.vendor_name || '';
  const { rows: others } = await c.query('SELECT * FROM invoices WHERE invoice_no <> \'\'');
  return { requests: pos.map((r) => toEngReq(r)), invoices: others.map(ROW).filter((v) => XPO.vendorKey(v.vendor) === XPO.vendorKey(vendor)),
    audit: [], users: [] };
}

/** Run XENT.matchInvoice without persisting (used by the AI agent preview). */
async function preview(db, inv) {
  const st = await matchState(db, inv);
  const po = st.requests[0];
  const rec = { ...inv, vendor: inv.vendor || po?.vendor || '' };
  const m = XENT.matchInvoice(st, rec, Date.now());
  return { flags: m.flags, verdict: XENT.matchVerdict(m.flags), po: m.po ? { no: m.po.no, total: m.po.total, vendor: m.po.vendor, status: m.po.status } : null };
}

async function create(db, actor, input) {
  return db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(724300)'); // invoice numbering + duplicate check
    const st = await matchState(c, { poNo: input.po_no, vendor: input.vendor || '' });
    const { rows: [{ n }] } = await c.query('SELECT count(*)::int AS n FROM invoices');
    st.invSeq = n;
    const now = Date.now();
    const res = XENT.addInvoice(st, toEngUser(actor), {
      poNo: input.po_no, vendor: input.vendor, invoiceNo: input.invoice_no, vatNo: input.vat_no, subtotal: input.subtotal,
      vat: input.vat, amount: input.amount, qty: input.qty, date: input.date, source: input.source, extractedBy: input.extracted_by,
      raw: input.raw }, now);
    if (!res.ok) throw (res.error.includes('للمشتريات') ? forbidden(res.error) : bad(res.error));
    const v = res.inv;
    const { rows: [row] } = await c.query(
      `INSERT INTO invoices (code, po_no, project, vendor, invoice_no, vat_no, subtotal, vat, amount, qty, date, source, extracted_by, raw,
         status, verdict, flags, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [v.id, v.poNo, v.project, v.vendor, v.invoiceNo, v.vatNo, v.subtotal, v.vat, v.amount, v.qty, v.date, v.source, v.extractedBy,
        String(v.raw || '').slice(0, 50_000), v.status, v.verdict, JSON.stringify(v.flags), actor.id, new Date(now)]);
    await audit.append(c, { actorId: actor.id, action: 'invoice_add', entity: 'invoice', entityId: v.id, at: new Date(now),
      data: { poNo: v.poNo, amount: v.amount, verdict: v.verdict, source: v.source } });
    return row;
  });
}

async function list(db, f = {}) {
  const params = [], where = ['TRUE'];
  if (f.status) { params.push(f.status); where.push(`status = $${params.length}`); }
  if (f.verdict) { params.push(f.verdict); where.push(`verdict = $${params.length}`); }
  const limit = Math.min(Number(f.limit) || 50, 200);
  return (await db.query(`SELECT * FROM invoices WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${limit}`, params)).rows;
}

async function get(db, id) {
  const { rows: [i] } = await db.query(
    `SELECT i.*, r.id AS request_id FROM invoices i LEFT JOIN requests r ON r.no = i.po_no WHERE i.id = $1`, [id]);
  if (!i) throw notFound('الفاتورة غير موجودة');
  return i;
}

async function post(db, actor, id, { override, reason }) {
  return db.tx(async (c) => {
    const { rows: [i] } = await c.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [id]);
    if (!i) throw notFound('الفاتورة غير موجودة');
    if (i.status === 'rejected') throw conflict('الفاتورة معادة؛ أدخلها من جديد بعد التصحيح');
    const st = { invoices: [ROW(i)], audit: [], users: [] };
    const now = Date.now();
    const res = XENT.postInvoice(st, toEngUser(actor), i.code, now, { override, reason });
    if (!res.ok) throw (res.error.includes('للمالية') ? forbidden(res.error) : conflict(res.error));
    const v = st.invoices[0];
    const { rows: [u] } = await c.query(
      `UPDATE invoices SET status='posted', posted_by=$2, posted_at=$3, override=$4 WHERE id=$1 RETURNING *`,
      [id, actor.id, new Date(now), v.override ? JSON.stringify(v.override) : null]);
    await audit.append(c, { actorId: actor.id, action: 'invoice_post', entity: 'invoice', entityId: i.code, at: new Date(now),
      data: { override: v.override ? reason : null } });
    return u;
  });
}

async function reject(db, actor, id, reason) {
  return db.tx(async (c) => {
    const { rows: [i] } = await c.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [id]);
    if (!i) throw notFound('الفاتورة غير موجودة');
    if (i.status !== 'review') throw conflict('لا يمكن إعادة فاتورة بعد ترحيلها أو إعادتها');
    const st = { invoices: [ROW(i)], audit: [], users: [] };
    const res = XENT.rejectInvoice(st, toEngUser(actor), i.code, reason, Date.now());
    if (!res.ok) throw (res.error === 'لا صلاحية' ? forbidden(res.error) : bad(res.error));
    const { rows: [u] } = await c.query(`UPDATE invoices SET status='rejected', reject_reason=$2 WHERE id=$1 RETURNING *`, [id, reason]);
    await audit.append(c, { actorId: actor.id, action: 'invoice_reject', entity: 'invoice', entityId: i.code, data: { reason } });
    return u;
  });
}

module.exports = { create, list, get, post, reject, preview, ROW };
