'use strict';
// CFO delegations; validation is XPO.createDelegation / XPO.revokeDelegation.
const { XPO, delegation: toEng, user: toEngUser, ms } = require('./xpo');
const audit = require('./audit');
const { bad, forbidden, notFound } = require('../errors');

async function list(db, user) {
  const all = ['cfo', 'ceo', 'admin'].includes(user.role);
  const { rows } = await db.query(
    `SELECT d.*, a.name AS from_name, b.name AS to_name,
       (d.revoked_at IS NULL AND now() >= d.starts_at AND now() <= d.ends_at) AS is_active
     FROM delegations d JOIN users a ON a.id = d.from_id JOIN users b ON b.id = d.to_id
     ${all ? '' : 'WHERE d.from_id = $1 OR d.to_id = $1'} ORDER BY d.starts_at DESC`, all ? [] : [user.id]);
  return rows;
}

async function create(db, actor, input) {
  return db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(724200, $1)', [actor.id]);
    const { rows: users } = await c.query('SELECT * FROM users WHERE id = ANY($1) AND active', [[actor.id, input.to_id]]);
    const { rows: existing } = await c.query('SELECT * FROM delegations WHERE from_id = $1 AND revoked_at IS NULL', [actor.id]);
    const st = { users: users.map(toEngUser), delegations: existing.map(toEng), audit: [], notices: [], dseq: 0 };
    const now = Date.now();
    const res = XPO.createDelegation(st, toEngUser(actor),
      { toId: input.to_id, start: ms(input.starts_at), end: ms(input.ends_at), reason: input.reason || '' }, now);
    if (!res.ok) throw bad(res.error);
    const { rows: [d] } = await c.query(
      `INSERT INTO delegations (from_id, to_id, starts_at, ends_at, reason) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [actor.id, input.to_id, input.starts_at, input.ends_at, input.reason || '']);
    await audit.append(c, { actorId: actor.id, action: 'delegate', entity: 'delegation', entityId: d.id, at: new Date(now),
      data: { to_id: d.to_id, starts_at: d.starts_at, ends_at: d.ends_at } });
    return d;
  });
}

async function revoke(db, actor, id) {
  return db.tx(async (c) => {
    const { rows: [d] } = await c.query('SELECT * FROM delegations WHERE id = $1 FOR UPDATE', [id]);
    if (!d) throw notFound('التفويض غير موجود');
    const st = { delegations: [toEng(d)], audit: [], notices: [] };
    const res = XPO.revokeDelegation(st, toEngUser(actor), d.id, Date.now());
    if (!res.ok) throw (res.error.includes('غير موجود') ? notFound(res.error) : forbidden(res.error));
    const { rows: [u] } = await c.query('UPDATE delegations SET revoked_at = now() WHERE id = $1 RETURNING *', [id]);
    await audit.append(c, { actorId: actor.id, action: 'revoke_delegation', entity: 'delegation', entityId: id });
    return u;
  });
}

module.exports = { list, create, revoke };
