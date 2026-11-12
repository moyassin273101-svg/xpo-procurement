'use strict';
// Purchase requests on PostgreSQL; every rule decision is delegated to XPO (src/xpo/engine.js).
const { XPO, request: toEng, approvalState, approvalsFor, user: toEngUser } = require('./xpo');
const audit = require('./audit');
const { bad, forbidden, notFound, conflict, HttpError } = require('../errors');

const BASE = `SELECT r.*, v.name AS vendor_name, u.name AS requester_name FROM requests r
  JOIN vendors v ON v.id = r.vendor_id JOIN users u ON u.id = r.requester_id`;

/** Row-level scope mirroring XPO.visible: engineer -> own, pm -> own project, others -> all. */
function scope(user, params) {
  if (user.role === 'engineer') { params.push(user.id); return `r.requester_id = $${params.length}`; }
  if (user.role === 'pm') { params.push(user.project); return `r.project = $${params.length}`; }
  if (user.role === 'supplier') return 'FALSE';
  return 'TRUE';
}

const LOOKBACK_DAYS = Math.max(XPO.CFG.GROUP_DAYS, XPO.CFG.DUP_DAYS) + 1;

/** Load the requester's recent requests in engine shape (enough for XPO.assess windows). */
async function recentForAssess(c, requesterId, at) {
  const { rows } = await c.query(
    `${BASE} WHERE r.requester_id = $1 AND r.created_at BETWEEN $2::timestamptz - make_interval(days => $3)
       AND $2::timestamptz + make_interval(days => $3)`, [requesterId, at, LOOKBACK_DAYS]);
  return rows.map((r) => toEng(r));
}

function flagsFrom(a, legacy = []) {
  const f = new Set(legacy);
  if (a.escalated) f.add('split');
  if (a.dups.length) f.add('dup');
  return [...f];
}

async function create(db, actor, input) {
  return db.tx(async (c) => {
    const { rows: [vendor] } = await c.query('SELECT * FROM vendors WHERE id = $1', [input.vendor_id]);
    if (!vendor) throw bad('اختر المورد من القائمة');
    // Serialise submissions per requester so concurrent requests see each other for grouping/dup checks
    await c.query('SELECT pg_advisory_xact_lock(724100, $1)', [actor.id]);
    const now = Date.now();
    const st = { requests: await recentForAssess(c, actor.id, new Date(now)), vendors: [vendor.name], users: [toEngUser(actor)],
      delegations: [], audit: [], notices: [], seq: 0 };
    const d = { project: input.project ?? actor.project, item: input.item, qty: input.qty, amount: input.amount,
      vatIncluded: input.vat_included, vendor: vendor.name, quoteRef: input.quote_ref, quotesCount: input.quotes_count,
      notes: input.notes };
    const res = XPO.submit(st, toEngUser(actor), d, now, { confirmDup: Boolean(input.confirm_dup) });
    if (!res.ok) {
      if (res.error === 'dup')
        throw new HttpError(409, 'يوجد طلب مشابه خلال آخر ' + XPO.CFG.DUP_DAYS + ' أيام؛ أكّد أنه ليس تكرارًا', {
          code: 'dup', dups: res.dups.map((r) => ({ no: r.no, item: r.item, total: r.total, createdAt: r.createdAt, status: r.status })) });
      throw bad(res.error);
    }
    const { req, assess } = res;
    const { rows: [{ id }] } = await c.query(`SELECT nextval('requests_id_seq') AS id`);
    const no = `PR-${new Date(now).getUTCFullYear()}-${String(id).padStart(4, '0')}`;
    const { rows: [row] } = await c.query(
      `INSERT INTO requests (id, no, requester_id, project, vendor_id, item, qty, amount, vat_included, total, quote_ref, quotes_count,
         notes, stages, grouping, dup_confirmed, flags, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [id, no, actor.id, req.project, vendor.id, req.item, req.qty, req.amount, req.vatIncluded, req.total, req.quoteRef,
        req.quotesCount, req.notes, req.stages, req.grouping, req.dupConfirmed, flagsFrom(assess), new Date(now)]);
    // Grouped (split) requests are flagged on every member, not only the one that triggered escalation
    if (assess.escalated)
      await c.query(`UPDATE requests SET flags = array_append(flags, 'split') WHERE no = ANY($1) AND NOT ('split' = ANY(flags))`,
        [assess.related.map((r) => r.no)]);
    await audit.append(c, { actorId: actor.id, action: 'submit', entity: 'request', entityId: no, at: new Date(now),
      data: { total: req.total, stages: req.stages, escalated: assess.escalated, related: req.grouping?.relatedNos || [],
        dupConfirmed: req.dupConfirmed || [] } });
    return { ...row, vendor_name: vendor.name, assess: { ownTier: assess.ownTier, tier: assess.tier, combinedTotal: assess.combinedTotal,
      escalated: assess.escalated } };
  });
}

async function list(db, user, f = {}) {
  const params = [];
  const where = [scope(user, params)];
  const add = (sql, v) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (f.status) add('r.status = ?', f.status);
  if (f.project) add('r.project = ?', f.project);
  if (f.flag) add('? = ANY(r.flags)', f.flag);
  if (f.flagged) where.push(`cardinality(r.flags) > 0`);
  if (f.q) add('(r.item ILIKE ? OR r.no ILIKE ? OR v.name ILIKE ?)', `%${f.q}%`);
  const limit = Math.min(Number(f.limit) || 50, 300), offset = Math.max(Number(f.offset) || 0, 0);
  const w = where.join(' AND ');
  const { rows } = await db.query(`${BASE} WHERE ${w} ORDER BY r.created_at DESC, r.id DESC LIMIT ${limit} OFFSET ${offset}`, params);
  const { rows: [{ n }] } = await db.query(
    `SELECT count(*)::int AS n FROM requests r JOIN vendors v ON v.id = r.vendor_id WHERE ${w}`, params);
  return { items: rows, total: n, limit, offset };
}

async function loadEngineReq(c, id, lock = false) {
  const { rows: [r] } = await c.query(`${BASE} WHERE r.id = $1 ${lock ? 'FOR UPDATE OF r' : ''}`, [id]);
  if (!r) return null;
  const aps = (await approvalsFor(c, [r.id])).get(r.id) || [];
  return { row: r, eng: toEng(r, aps), approvals: aps };
}

async function get(db, user, id) {
  const params = [id];
  const { rows: [visible] } = await db.query(`${BASE} WHERE r.id = $1 AND ${scope(user, params)}`, params);
  const loaded = await loadEngineReq(db, id);
  if (!loaded) throw notFound('الطلب غير موجود');
  const st = await approvalState(db, user.id);
  const decision = XPO.canApprove(st, toEngUser(user), loaded.eng, Date.now());
  if (!visible && !decision.ok) throw notFound('الطلب غير موجود');
  const { rows: approvals } = await db.query(
    `SELECT a.*, u.name AS user_name, ob.name AS on_behalf_of_name FROM approvals a JOIN users u ON u.id = a.user_id
     LEFT JOIN users ob ON ob.id = a.on_behalf_of WHERE a.request_id = $1 ORDER BY a.at, a.id`, [id]);
  return { ...loaded.row, approvals, next_stage: XPO.nextStage(loaded.eng) || null, can_decide: decision.ok,
    decide_stage: decision.stage || null, on_behalf_of: decision.onBehalfOf || null,
    can_override: Boolean(loaded.row.grouping && !loaded.row.grouping.overridden && loaded.row.status === 'pending' &&
      (user.role === 'cfo' || XPO.activeDelegations(st, Date.now()).some((d) => d.toId === user.id))) };
}

async function inbox(db, user) {
  const { rows } = await db.query(`${BASE} WHERE r.status = 'pending' ORDER BY r.created_at`);
  if (!rows.length) return [];
  const aps = await approvalsFor(db, rows.map((r) => r.id));
  const st = await approvalState(db, user.id);
  const me = toEngUser(user), now = Date.now();
  return rows.map((r) => ({ r, d: XPO.canApprove(st, me, toEng(r, aps.get(r.id) || []), now) }))
    .filter((x) => x.d.ok).map(({ r, d }) => ({ ...r, pending_stage: d.stage, on_behalf_of: d.onBehalfOf || null }));
}

async function decide(db, user, id, { decision, comment }) {
  return db.tx(async (c) => {
    const loaded = await loadEngineReq(c, id, true);
    if (!loaded) throw notFound('الطلب غير موجود');
    const st = await approvalState(c, user.id);
    st.requests = [loaded.eng];
    const now = Date.now();
    const res = XPO.decide(st, toEngUser(user), loaded.eng.id, decision, comment, now);
    if (!res.ok) throw forbidden(res.error);
    const a = loaded.eng.approvals.at(-1);
    await c.query(
      `INSERT INTO approvals (request_id, stage, user_id, on_behalf_of, delegation_id, decision, comment, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, a.stage, user.id, a.onBehalfOf, a.delegationId, decision, a.comment, new Date(now)]);
    const done = res.req.status !== 'pending';
    const { rows: [u] } = await c.query(
      `UPDATE requests SET status = $2, decided_at = CASE WHEN $3 THEN $4::timestamptz ELSE decided_at END WHERE id = $1 RETURNING *`,
      [id, res.req.status, done, new Date(now)]);
    await audit.append(c, { actorId: user.id, action: decision === 'approved' ? 'approve' : 'reject', entity: 'request',
      entityId: loaded.eng.no, at: new Date(now), data: { stage: a.stage, onBehalfOf: a.onBehalfOf, comment: a.comment, status: u.status } });
    return u;
  });
}

async function cancel(db, user, id, reason) {
  return db.tx(async (c) => {
    const loaded = await loadEngineReq(c, id, true);
    if (!loaded) throw notFound('الطلب غير موجود');
    const st = { requests: [loaded.eng], audit: [] };
    const res = XPO.cancel(st, toEngUser(user), loaded.eng.id, reason, Date.now());
    if (!res.ok) throw conflict(res.error);
    const { rows: [u] } = await c.query(`UPDATE requests SET status = 'cancelled' WHERE id = $1 RETURNING *`, [id]);
    await audit.append(c, { actorId: user.id, action: 'cancel', entity: 'request', entityId: loaded.eng.no, data: { reason: reason || '' } });
    return u;
  });
}

async function overrideGrouping(db, user, id, reason) {
  return db.tx(async (c) => {
    const loaded = await loadEngineReq(c, id, true);
    if (!loaded) throw notFound('الطلب غير موجود');
    const st = await approvalState(c, user.id);
    st.requests = [loaded.eng];
    const now = Date.now();
    const res = XPO.overrideGrouping(st, toEngUser(user), loaded.eng.id, reason, now);
    if (!res.ok) throw forbidden(res.error);
    const eng = loaded.eng;
    // If the remaining stages were already approved, the request is complete (engine leaves status untouched).
    const status = XPO.nextStage(eng) ? 'pending' : 'approved';
    const { rows: [u] } = await c.query(
      `UPDATE requests SET stages = $2, grouping = $3, status = $4, decided_at = CASE WHEN $4 = 'approved' THEN $5::timestamptz ELSE decided_at END
       WHERE id = $1 RETURNING *`, [id, eng.stages, eng.grouping, status, new Date(now)]);
    await audit.append(c, { actorId: user.id, action: 'override_grouping', entity: 'request', entityId: eng.no, at: new Date(now),
      data: { reason, stages: eng.stages, status } });
    return u;
  });
}

async function dispatch(db, user, id) {
  return db.tx(async (c) => {
    const loaded = await loadEngineReq(c, id, true);
    if (!loaded) throw notFound('الطلب غير موجود');
    if (loaded.row.dispatched_at) throw conflict('أُرسل الطلب للمورد مسبقًا');
    const st = { requests: [loaded.eng], audit: [] };
    const now = Date.now();
    const res = XPO.dispatchToVendor(st, toEngUser(user), loaded.eng.id, now);
    if (!res.ok) throw conflict(res.error);
    const { rows: [u] } = await c.query('UPDATE requests SET dispatched_at = $2 WHERE id = $1 RETURNING *', [id, new Date(now)]);
    await audit.append(c, { actorId: user.id, action: 'dispatch', entity: 'request', entityId: loaded.eng.no, at: new Date(now),
      data: { vendor: loaded.row.vendor_name } });
    return u;
  });
}

/** XPO.visible for suppliers: only dispatched, approved orders for their vendor, minimal fields. */
async function supplierOrders(db, user) {
  const { rows } = await db.query(
    `SELECT r.no, r.item, r.qty, r.project, r.dispatched_at FROM requests r
     WHERE r.vendor_id = $1 AND r.status = 'approved' AND r.dispatched_at IS NOT NULL ORDER BY r.dispatched_at DESC`, [user.vendor_id]);
  return rows;
}

module.exports = { scope, create, list, get, inbox, decide, cancel, overrideGrouping, dispatch, supplierOrders, flagsFrom, BASE };
