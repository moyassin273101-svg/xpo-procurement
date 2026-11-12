'use strict';
// Hash-chained audit log. Same chain structure as XPO.log (prev hash + entry), but SHA-256
// instead of the engine's 53-bit non-cryptographic hash, so tampering cannot be forged.
const crypto = require('crypto');

const GENESIS = '0'.repeat(64);
const AUDIT_LOCK = 724001; // advisory lock key serialising chain appends

function canonical(v) {
  if (v === null || v === undefined) return 'null';
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

function auditHash(prevHash, e) {
  const body = canonical({ at: new Date(e.at).toISOString(), actor_id: e.actor_id ?? null, action: e.action,
    entity: e.entity, entity_id: e.entity_id == null ? null : String(e.entity_id), data: e.data ?? {} });
  return crypto.createHash('sha256').update(prevHash + '|' + body).digest('hex');
}

function verifyChain(rows) {
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev) return { valid: false, brokenAt: r.id, reason: 'prev_hash mismatch' };
    if (auditHash(prev, r) !== r.hash) return { valid: false, brokenAt: r.id, reason: 'hash mismatch' };
    prev = r.hash;
  }
  return { valid: true, count: rows.length, head: prev };
}

/** Append inside the caller's transaction. Chain stays linear under concurrency. */
async function append(client, { actorId = null, action, entity, entityId = null, data = {}, at = new Date() }) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK]);
  const { rows } = await client.query('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
  const prev = rows[0]?.hash || GENESIS;
  const entry = { at: new Date(at), actor_id: actorId, action, entity,
    entity_id: entityId == null ? null : String(entityId), data: JSON.parse(JSON.stringify(data)) };
  const hash = auditHash(prev, entry);
  await client.query(
    `INSERT INTO audit_log (at, actor_id, action, entity, entity_id, data, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [entry.at, actorId, action, entity, entry.entity_id, entry.data, prev, hash]);
  return hash;
}

async function verify(db) {
  const { rows } = await db.query('SELECT * FROM audit_log ORDER BY id');
  return verifyChain(rows);
}

async function list(db, { entity, entityId, limit = 100 } = {}) {
  const params = [];
  let where = 'TRUE';
  if (entity) { params.push(entity); where += ` AND entity = $${params.length}`; }
  if (entityId) { params.push(String(entityId)); where += ` AND entity_id = $${params.length}`; }
  params.push(Math.min(Number(limit) || 100, 500));
  const { rows } = await db.query(
    `SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
     WHERE ${where} ORDER BY a.id DESC LIMIT $${params.length}`, params);
  return rows;
}

module.exports = { GENESIS, canonical, auditHash, verifyChain, append, verify, list };
