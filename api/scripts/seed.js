'use strict';
// Load the company's real seed.json (280 requests from their Excel) into PostgreSQL.
// Stages and split/dup flags are recomputed by replaying every request through XPO.assess in date order;
// the Excel's own audit flags are kept alongside, and the original row is stored in requests.legacy.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { XPO, XENT } = require('../src/services/xpo');
const audit = require('../src/services/audit');

const HOUR = 3_600_000;

// People named in the Excel, with their roles from the company's authority matrix.
const PEOPLE = [
  { key: 'مهدي', email: 'mahdi@x.sa', role: 'engineer', project: 'النخيل' },
  { key: 'طلال', email: 'talal@x.sa', role: 'engineer', project: 'النخيل' },
  { key: 'مازن', email: 'mazen@x.sa', role: 'engineer', project: 'النخيل' },
  { key: 'مالك', email: 'malek@x.sa', role: 'engineer', project: 'الواحة' },
  { key: 'حمد', email: 'hamad@x.sa', role: 'engineer', project: 'الواحة' },
  { key: 'قصي', email: 'qusai@x.sa', role: 'engineer', project: 'الواحة' },
  { key: 'جابر', email: 'jaber@x.sa', role: 'engineer', project: 'برج الياسمين' },
  { key: 'منصور', email: 'mansour@x.sa', role: 'engineer', project: 'برج الياسمين' },
  { key: 'رامي', email: 'rami@x.sa', role: 'pm', project: 'النخيل' },
  { key: 'خالد', email: 'khaled@x.sa', role: 'pm', project: 'الواحة' },
  { key: 'ياسر', email: 'yasser@x.sa', role: 'pm', project: 'برج الياسمين' },
  { key: 'فهد', email: 'fahad@x.sa', role: 'cfo' },
  { key: 'سعد', email: 'saad@x.sa', role: 'finance' },          // approves CFO stage only "بالنيابة"
  { key: 'CEO', name: 'الرئيس التنفيذي', email: 'ceo@x.sa', role: 'ceo' },
  // Operational accounts not present in the Excel
  { key: 'ops', name: 'نواف (العمليات)', email: 'ops@x.sa', role: 'ops' },
  { key: 'proc', name: 'وليد (المشتريات)', email: 'procurement@x.sa', role: 'procurement' },
  { key: 'admin', name: 'مسؤول النظام', email: 'admin@x.sa', role: 'admin' },
  { key: 'supplier', name: 'مورد: مؤسسة إيه 31', email: 'supplier@x.sa', role: 'supplier', vendor: 'مؤسسة إيه 31 لمواد البناء' },
];

const STAGE_OF_ROLE = { pm: 'pm', cfo: 'cfo', ceo: 'ceo', finance: 'cfo' };

/** Replay all requests through XPO.assess exactly as if submitted in order. Pure; exported for tests. */
function replay(reqs) {
  const ordered = [...reqs].sort((a, b) => a.date.localeCompare(b.date) || a.no.localeCompare(b.no));
  const st = { requests: [] };
  const out = new Map();
  for (const r of ordered) {
    const now = Date.parse(r.date + 'T08:00:00Z');
    const d = { id: r.no, requesterId: r.req, project: r.proj, vendor: r.vendor, item: r.item, total: r.amt };
    const a = XPO.assess(st, d, now);
    out.set(r.no, { createdAt: now, assess: a, flags: new Set() });
    if (a.escalated) {
      out.get(r.no).flags.add('split');
      for (const rel of a.related) out.get(rel.no).flags.add('split');
    }
    if (a.dups.length) out.get(r.no).flags.add('dup');
    st.requests.push({ ...d, no: r.no, createdAt: now, status: r.st });
  }
  return { ordered, out };
}

async function seed(pool, file = path.join(__dirname, '..', 'seed.json')) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data.reqs) || data.reqs.length === 0) throw new Error('seed.json: expected { reqs: [...] }');
  const hash = await bcrypt.hash(process.env.SEED_PASSWORD || 'Passw0rd!', 10);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if ((await c.query('SELECT count(*)::int AS n FROM users')).rows[0].n > 0) throw new Error('Database already seeded');

    const vid = {};
    for (const name of [...new Set(data.reqs.map((r) => r.vendor))].sort())
      vid[name] = (await c.query('INSERT INTO vendors (name) VALUES ($1) RETURNING id', [name])).rows[0].id;

    const uid = {};
    for (const p of PEOPLE)
      uid[p.key] = (await c.query(
        'INSERT INTO users (email, name, role, project, vendor_id, password_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [p.email, p.name || p.key, p.role, p.project || null, p.vendor ? vid[p.vendor] : null, hash])).rows[0].id;
    const roleOf = Object.fromEntries(PEOPLE.map((p) => [p.key, p.role]));

    const year = Number(data.reqs[0].date.slice(0, 4));
    for (const [project, amount] of Object.entries(XENT.DEFAULT_BUDGETS))
      await c.query('INSERT INTO budgets (project, fiscal_year, amount) VALUES ($1,$2,$3)', [project, year, amount]);

    const { ordered, out } = replay(data.reqs);
    const ids = {};
    const stats = { split: 0, dup: 0, approvals: 0, stuckPending: [] };

    for (const r of ordered) {
      const { createdAt, assess: a, flags } = out.get(r.no);
      const at = (h) => new Date(createdAt + h * HOUR);
      const allFlags = [...new Set([...r.flags, ...flags])];
      const grouping = a.escalated ? { combinedTotal: a.combinedTotal, relatedNos: a.related.map((x) => x.no), overridden: null } : null;
      const approvals = r.names.map((name, i) => {
        const stage = STAGE_OF_ROLE[r.roles[i]];
        const onBehalf = name === 'سعد' ? uid['فهد'] : null;
        return { stage, user: uid[name], onBehalf, decision: 'approved', at: at(i + 1) };
      });
      if (r.rejBy) approvals.push({ stage: STAGE_OF_ROLE[roleOf[r.rejBy]], user: uid[r.rejBy], onBehalf: null, decision: 'rejected',
        comment: 'مرفوض (من السجل)', at: at(approvals.length + 1) });
      if (approvals.some((x) => !x.user || !x.stage)) throw new Error(`Unknown approver on ${r.no}: ${r.appr}`);
      const decidedAt = ['approved', 'rejected'].includes(r.st) && approvals.length ? approvals.at(-1).at : null;

      const { rows: [ins] } = await c.query(
        `INSERT INTO requests (no, requester_id, project, vendor_id, item, qty, amount, vat_included, total, quote_ref, notes, status,
           stages, grouping, dup_confirmed, flags, legacy, created_at, decided_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,$7,'EXCEL',$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [r.no, uid[r.req], r.proj, vid[r.vendor], r.item, r.qty, r.amt, r.notes, r.st, a.stages, grouping,
          a.dups.length ? a.dups.map((x) => x.no) : null, allFlags,
          { appr: r.appr, roles: r.roles, names: r.names, rejBy: r.rejBy, flags: r.flags, item_raw: r.item_raw, date: r.date },
          new Date(createdAt), decidedAt]);
      ids[r.no] = ins.id;
      await audit.append(c, { actorId: uid[r.req], action: 'submit', entity: 'request', entityId: r.no, at: new Date(createdAt),
        data: { total: r.amt, stages: a.stages, escalated: a.escalated, imported: true } });
      for (const x of approvals) {
        await c.query(`INSERT INTO approvals (request_id, stage, user_id, on_behalf_of, decision, comment, at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [ins.id, x.stage, x.user, x.onBehalf, x.decision, x.comment || '', x.at]);
        await audit.append(c, { actorId: x.user, action: x.decision === 'approved' ? 'approve' : 'reject', entity: 'request', entityId: r.no,
          at: x.at, data: { stage: x.stage, onBehalfOf: x.onBehalf, imported: true } });
        stats.approvals++;
      }
      if (r.st === 'cancelled')
        await audit.append(c, { actorId: uid[r.req], action: 'cancel', entity: 'request', entityId: r.no, at: at(approvals.length + 1),
          data: { imported: true } });
      if (r.st === 'pending') {
        const done = approvals.filter((x) => x.decision === 'approved').map((x) => x.stage);
        if (a.stages.every((s) => done.includes(s))) stats.stuckPending.push(r.no);
      }
      if (allFlags.includes('split')) stats.split++;
      if (allFlags.includes('dup')) stats.dup++;
    }
    await c.query(`SELECT setval('requests_id_seq', (SELECT max(id) FROM requests))`);
    await c.query('COMMIT');
    console.log(`seeded ${PEOPLE.length} users, ${Object.keys(vid).length} vendors, ${ordered.length} requests, ` +
      `${stats.approvals} approvals; flags: split=${stats.split} dup=${stats.dup}` +
      (stats.stuckPending.length ? `; WARNING fully-approved but pending: ${stats.stuckPending.join(',')}` : ''));
    return stats;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

if (require.main === module) {
  const db = require('../src/db');
  const { migrate } = require('./migrate');
  migrate(db.pool).then(() => seed(db.pool)).then(() => db.pool.end()).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { seed, replay, PEOPLE };
