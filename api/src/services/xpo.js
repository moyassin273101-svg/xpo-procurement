'use strict';
// Adapter between PostgreSQL rows and the company's reference engine (src/xpo/*.js, vendored unchanged).
// Services load rows, convert them to the engine's in-memory shape, call XPO/XENT, then persist results.
const XPO = require('../xpo/engine.js');
const XENT = require('../xpo/enterprise.js');

const ms = (d) => (d == null ? null : new Date(d).getTime());

const user = (u) => u && { id: u.id, name: u.name, role: u.role, project: u.project, vendor: u.vendor_name || null };

const delegation = (d) => ({ id: d.id, fromId: d.from_id, toId: d.to_id, start: ms(d.starts_at), end: ms(d.ends_at),
  reason: d.reason, revokedAt: ms(d.revoked_at) });

const approval = (a) => ({ stage: a.stage, userId: a.user_id, onBehalfOf: a.on_behalf_of, delegationId: a.delegation_id,
  decision: a.decision, comment: a.comment, at: ms(a.at) });

/** DB request row (+ vendor_name) -> engine request. */
function request(r, approvals = []) {
  return {
    id: r.no, no: r.no, dbId: r.id, createdAt: ms(r.created_at), requesterId: r.requester_id, project: r.project,
    item: r.item, qty: Number(r.qty), amount: Number(r.amount), vatIncluded: r.vat_included, total: Number(r.total),
    vendor: r.vendor_name, quoteRef: r.quote_ref, quotesCount: r.quotes_count, notes: r.notes || '', status: r.status,
    stages: r.stages, approvals: approvals.map(approval), grouping: r.grouping, flags: r.flags || [],
    legacyChain: r.legacy?.appr || '', dispatchedAt: ms(r.dispatched_at),
  };
}

/** Load the state the engine needs to decide on approvals for `actorId`. */
async function approvalState(c, actorId) {
  const { rows: delegs } = await c.query('SELECT * FROM delegations WHERE revoked_at IS NULL AND to_id = $1', [actorId]);
  const ids = [...new Set([actorId, ...delegs.map((d) => d.from_id)])];
  const { rows: users } = await c.query('SELECT * FROM users WHERE id = ANY($1)', [ids]);
  return { users: users.map(user), delegations: delegs.map(delegation), requests: [], audit: [] };
}

async function approvalsFor(c, requestIds) {
  if (!requestIds.length) return new Map();
  const { rows } = await c.query('SELECT * FROM approvals WHERE request_id = ANY($1) ORDER BY at, id', [requestIds]);
  const m = new Map();
  for (const a of rows) m.set(a.request_id, [...(m.get(a.request_id) || []), a]);
  return m;
}

module.exports = { XPO, XENT, ms, user, delegation, approval, request, approvalState, approvalsFor };
