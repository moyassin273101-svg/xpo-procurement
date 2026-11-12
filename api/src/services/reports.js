'use strict';
// Reports: budgets, SLA aging, vendor risk, KPIs, CSV export — computed by XENT on the user's visible requests.
const { XENT, request: toEngReq, user: toEngUser, approvalsFor } = require('./xpo');
const requests = require('./requests');
const invoices = require('./invoices');
const audit = require('./audit');

/** Engine state from the requests this user may see (XPO.visible semantics via SQL scope). */
async function state(db, user) {
  const params = [];
  const { rows } = await db.query(`${requests.BASE} WHERE ${requests.scope(user, params)} ORDER BY r.created_at DESC, r.id DESC`, params);
  const aps = await approvalsFor(db, rows.map((r) => r.id));
  const invs = (await db.query('SELECT * FROM invoices')).rows.map(invoices.ROW);
  const { rows: budgets } = await db.query('SELECT project, amount FROM budgets WHERE fiscal_year = $1', [new Date().getUTCFullYear()]);
  return {
    requests: rows.map((r) => toEngReq(r, aps.get(r.id) || [])),
    invoices: user.role === 'pm' ? invs.filter((v) => v.project === user.project) : invs,
    budgets: budgets.length ? Object.fromEntries(budgets.map((b) => [b.project, Number(b.amount)])) : undefined,
    users: (await db.query('SELECT id, name, role, project FROM users')).rows.map(toEngUser),
    audit: [],
  };
}

async function kpis(db, user) {
  const st = await state(db, user);
  return { ...XENT.kpis(st, Date.now()), totalRequests: st.requests.length };
}

async function budgets(db, user) {
  const st = await state(db, user);
  const all = XENT.allBudgets(st);
  return user.role === 'pm' ? all.filter((b) => b.project === user.project) : all;
}

async function aging(db, user) {
  const st = await state(db, user);
  const dbId = new Map(st.requests.map((r) => [r.no, r.dbId]));
  return XENT.aging(st, Date.now()).map((a) => ({ ...a, id: dbId.get(a.no) }));
}

async function vendorRisk(db, user) {
  return XENT.vendorRisk(await state(db, user));
}

// Neutralise spreadsheet formulas in free-text cells before XENT's CSV writer (it quotes but does not escape =,+,-,@).
const safe = (s) => (typeof s === 'string' && /^[=+\-@\t\r]/.test(s) ? "'" + s : s);

async function exportRequests(db, user) {
  const st = await state(db, user);
  st.requests = st.requests.map((r) => ({ ...r, item: safe(r.item), vendor: safe(r.vendor), project: safe(r.project) }));
  return XENT.exportRequestsCsv(st);
}

async function exportAudit(db) {
  const { rows } = await db.query('SELECT * FROM audit_log ORDER BY id');
  const users = (await db.query('SELECT id, name, role FROM users')).rows.map(toEngUser);
  const st = { users, audit: rows.map((a) => ({ i: Number(a.id), at: a.at, actor: a.actor_id, action: a.action, ref: a.entity_id || '',
    detail: safe(JSON.stringify(a.data)), hash: a.hash })) };
  return XENT.exportAuditCsv(st);
}

module.exports = { state, kpis, budgets, aging, vendorRisk, exportRequests, exportAudit, verify: audit.verify };
