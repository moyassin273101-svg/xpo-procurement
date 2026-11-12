'use strict';
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const XPO = require('../src/xpo/engine.js');
const XENT = require('../src/xpo/enterprise.js');
const audit = require('../src/services/audit');
const { replay } = require('../scripts/seed');
const { can, P, MATRIX } = require('../src/rbac');
const { toolsFor } = require('../src/ai/analyst');

const seed = require('../seed.json');
const DAY = XPO.DAY;

test('vendored engine.js / enterprise.js are byte-identical to the company originals', (t) => {
  for (const f of ['engine.js', 'enterprise.js']) {
    const original = path.join(__dirname, '..', '..', f);
    if (!fs.existsSync(original)) { t.skip('originals not present (e.g. inside the Docker image)'); return; }
    assert.equal(fs.readFileSync(path.join(__dirname, '..', 'src', 'xpo', f), 'utf8'), fs.readFileSync(original, 'utf8'), f);
  }
});

test('approval thresholds follow the authority matrix: 10,000 and 50,000', () => {
  assert.deepEqual([XPO.CFG.T_CFO, XPO.CFG.T_CEO], [10000, 50000]);
  assert.deepEqual(XPO.stagesFor(XPO.tierOf(9999.99)), ['pm']);
  assert.deepEqual(XPO.stagesFor(XPO.tierOf(10000)), ['pm', 'cfo']);
  assert.deepEqual(XPO.stagesFor(XPO.tierOf(49999.99)), ['pm', 'cfo']);
  assert.deepEqual(XPO.stagesFor(XPO.tierOf(50000)), ['pm', 'cfo', 'ceo']);
});

// ---- The real seed: engine-recomputed flags vs the company's splits/dups lists ----
const { out } = replay(seed.reqs);
const flagged = (f) => [...out].filter(([, v]) => v.flags.has(f)).map(([no]) => no).sort();

test('seed.json has 280 requests', () => assert.equal(seed.reqs.length, 280));

test('dup flags match seed.dups exactly (7 requests)', () => {
  const expected = seed.dups.map((d) => d.nos[1]).sort();
  assert.equal(expected.length, 7);
  assert.deepEqual(flagged('dup'), expected);
});

test('split flags cover every seed.splits request; extras come only from the 3-day GROUP_DAYS window', () => {
  const split = flagged('split');
  const expected = seed.splits.flatMap((s) => s.nos);
  assert.equal(new Set(expected).size, 9);
  for (const no of expected) assert.ok(split.includes(no), `${no} from seed.splits not flagged`);
  // Documented divergence: engine.js groups within 3 days, seed.splits was built on same-day groups.
  assert.deepEqual(split.filter((n) => !expected.includes(n)), ['PR-2026-0103', 'PR-2026-0116', 'PR-2026-0117', 'PR-2026-0124',
    'PR-2026-0180', 'PR-2026-0182', 'PR-2026-0191', 'PR-2026-0192', 'PR-2026-0263', 'PR-2026-0264', 'PR-2026-0270', 'PR-2026-0280']);
  assert.equal(split.length, 21);
});

test('split groups escalate to the tier the company expected (need_level)', () => {
  for (const s of seed.splits) {
    const last = s.nos.map((no) => out.get(no)).sort((a, b) => b.assess.tier - a.assess.tier)[0];
    assert.equal(last.assess.tier, s.need_level, s.nos.join('+'));
  }
});

// ---- Engine behaviour relied on by the services ----
const users = [
  { id: 'e1', role: 'engineer', project: 'النخيل' }, { id: 'pm1', role: 'pm', project: 'النخيل' },
  { id: 'pm2', role: 'pm', project: 'الواحة' }, { id: 'cfo', role: 'cfo' }, { id: 'ceo', role: 'ceo' },
  { id: 'fin', role: 'finance', name: 'سعد' }, { id: 'proc', role: 'procurement' },
];
const U = Object.fromEntries(users.map((u) => [u.id, u]));
const mkState = () => ({ users, requests: [], delegations: [], audit: [], notices: [], vendors: ['مورد'], seq: 0 });
const NOW = Date.parse('2026-11-01T08:00:00Z');
const submit = (st, total, extra = {}) => XPO.submit(st, U.e1, { project: 'النخيل', item: 'اسمنت', qty: 1, amount: total, vatIncluded: true,
  vendor: 'مورد', quoteRef: 'Q1', ...extra }, extra.at || NOW, { confirmDup: extra.confirmDup });

test('stage order, project scoping for PMs, and segregation of duties', () => {
  const st = mkState();
  const r = submit(st, 60000).req;
  assert.deepEqual(r.stages, ['pm', 'cfo', 'ceo']);
  assert.equal(XPO.canApprove(st, U.cfo, r, NOW).ok, false, 'CFO before PM');
  assert.equal(XPO.canApprove(st, U.pm2, r, NOW).ok, false, 'PM of another project');
  assert.equal(XPO.decide(st, U.pm1, r.id, 'approved', '', NOW).ok, true);
  assert.equal(XPO.decide(st, U.ceo, r.id, 'approved', '', NOW).ok, false, 'CEO before CFO');
  assert.equal(XPO.decide(st, U.cfo, r.id, 'approved', '', NOW).ok, true);
  assert.equal(XPO.decide(st, U.ceo, r.id, 'approved', '', NOW).ok, true);
  assert.equal(r.status, 'approved');
  assert.equal(XPO.decide(st, U.pm1, submit(st, 500, { item: 'رمل' }).req.id, 'rejected', '', NOW).ok, false, 'rejection needs reason');
});

test('submit validation: only engineers, own project, quote required', () => {
  const st = mkState();
  assert.equal(XPO.submit(st, U.pm1, { project: 'النخيل', item: 'x', qty: 1, amount: 1, vendor: 'مورد', quoteRef: 'q' }, NOW).ok, false);
  assert.equal(submit(st, 100, { project: 'الواحة' }).ok, false);
  assert.equal(submit(st, 100, { quoteRef: '' }).ok, false);
  assert.equal(submit(st, 100, { vatIncluded: false }).req.total, 115);
});

test('grouping escalates tier within 3 days; CFO override restores own tier', () => {
  const st = mkState();
  submit(st, 6000, { item: 'بلاط 1' });
  const second = submit(st, 6000, { item: 'بلاط 2', at: NOW + 2 * DAY });
  assert.deepEqual(second.req.stages, ['pm', 'cfo']);
  assert.ok(second.req.grouping);
  assert.deepEqual(submit(st, 6000, { item: 'دهان', at: NOW + 10 * DAY }).req.stages, ['pm'], 'outside window');
  assert.equal(XPO.overrideGrouping(st, U.pm1, second.req.id, 'سبب', NOW).ok, false);
  assert.equal(XPO.overrideGrouping(st, U.cfo, second.req.id, '', NOW).ok, false, 'reason required');
  assert.equal(XPO.overrideGrouping(st, U.cfo, second.req.id, 'احتياج منفصل', NOW).ok, true);
  assert.deepEqual(second.req.stages, ['pm']);
});

test('duplicates block submission until confirmed', () => {
  const st = mkState();
  submit(st, 5000, { item: 'بلوك 20 سم' });
  const dup = submit(st, 5010, { item: 'بلك 20 سم', at: NOW + DAY });
  assert.equal(dup.error, 'dup');
  const ok = submit(st, 5010, { item: 'بلك 20 سم', at: NOW + DAY, confirmDup: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.req.dupConfirmed.length, 1);
});

test('CFO delegation: finance/ops only, ≤31 days, only the CFO stage, revocable', () => {
  const st = mkState();
  const mk = (to, days) => XPO.createDelegation(st, U.cfo, { toId: to, start: NOW, end: NOW + days * DAY }, NOW);
  assert.equal(XPO.createDelegation(st, U.pm1, { toId: 'fin', start: NOW, end: NOW + DAY }, NOW).ok, false);
  assert.equal(mk('pm1', 5).ok, false, 'PM cannot be delegate');
  assert.equal(mk('fin', 40).ok, false, 'over 31 days');
  const d = mk('fin', 10);
  assert.equal(d.ok, true);
  assert.equal(mk('fin', 5).ok, false, 'overlapping');
  const r = submit(st, 20000).req;
  assert.equal(XPO.canApprove(st, U.fin, r, NOW).ok, false, 'not before PM stage');
  XPO.decide(st, U.pm1, r.id, 'approved', '', NOW);
  const c = XPO.canApprove(st, U.fin, r, NOW + 1);
  assert.deepEqual([c.ok, c.onBehalfOf], [true, 'cfo']);
  assert.equal(XPO.revokeDelegation(st, U.pm1, d.d.id, NOW).ok, false);
  assert.equal(XPO.revokeDelegation(st, U.ceo, d.d.id, NOW).ok, true);
  assert.equal(XPO.canApprove(st, U.fin, r, NOW + 2).ok, false);
});

test('invoice match: tolerance max(2%, 500), vendor, qty, VAT, VAT no., duplicates', () => {
  const st = mkState();
  const r = submit(st, 20000).req;
  r.status = 'approved'; r.qty = 100;
  const m = (inv) => XENT.matchVerdict(XENT.matchInvoice(st, { vendor: 'مورد', poNo: r.no, ...inv }, NOW).flags).k;
  assert.equal(m({ amount: 20400 }), 'clean');
  assert.equal(m({ amount: 21000 }), 'blocked');
  assert.equal(m({ amount: 20000, vendor: 'آخر' }), 'review');
  assert.equal(m({ amount: 20000, qty: 120 }), 'review');
  assert.equal(m({ amount: 20000, subtotal: 17391.3, vat: 1000 }), 'review');
  assert.equal(m({ amount: 20000, vatNo: '123' }), 'review');
  assert.equal(m({ amount: 20000, poNo: 'PR-0000' }), 'blocked');
  assert.equal(XENT.addInvoice(st, U.e1, { poNo: r.no, amount: 1 }, NOW).ok, false, 'engineers cannot add invoices');
  const a = XENT.addInvoice(st, U.proc, { poNo: r.no, amount: 20000, invoiceNo: 'F-1' }, NOW);
  assert.equal(a.inv.verdict, 'clean');
  assert.equal(XENT.matchVerdict(XENT.addInvoice(st, U.proc, { poNo: r.no, amount: 20000, invoiceNo: 'F-1' }, NOW).inv.flags).k, 'blocked', 'dup no.');
});

test('SHA-256 audit chain verifies and detects tampering; key order does not matter', () => {
  const rows = [];
  let prev = audit.GENESIS;
  for (let i = 1; i <= 5; i++) {
    const row = { id: i, at: new Date(Date.UTC(2026, 0, i)), actor_id: i, action: 'x', entity: 'request', entity_id: String(i), data: { n: i, o: { b: 1, a: 2 } } };
    row.prev_hash = prev; row.hash = audit.auditHash(prev, row); prev = row.hash;
    rows.push(row);
  }
  assert.equal(audit.verifyChain(rows).valid, true);
  rows[2] = { ...rows[2], data: { o: { a: 2, b: 1 }, n: 3 } };
  assert.equal(audit.verifyChain(rows).valid, true);
  rows[2] = { ...rows[2], data: { n: 999 } };
  assert.deepEqual([audit.verifyChain(rows).valid, audit.verifyChain(rows).brokenAt], [false, 3]);
});

test('RBAC matrix', () => {
  assert.equal(can({ role: 'engineer' }, P.REQ_CREATE), true);
  assert.equal(can({ role: 'pm' }, P.REQ_CREATE), false);
  assert.equal(can({ role: 'engineer' }, P.AUDIT_READ), false);
  assert.equal(can({ role: 'supplier' }, P.REQ_READ), false);
  assert.equal(can({ role: 'cfo' }, P.DELEG_CREATE), true);
  assert.equal(can({ role: 'finance' }, P.DELEG_CREATE), false);
  assert.equal(can({ role: 'ceo' }, P.DELEG_REVOKE), true);
  for (const ps of Object.values(MATRIX)) for (const p of ps) assert.ok(Object.values(P).includes(p));
});

test('AI analyst tools are gated per role', () => {
  const names = (role) => toolsFor({ role }).map((t) => t.def.name);
  assert.deepEqual(names('engineer'), ['search_requests']);
  assert.ok(names('pm').includes('my_approval_inbox') && !names('pm').includes('get_vendor_risk'));
  assert.ok(!names('procurement').includes('audit_integrity'));
  assert.ok(names('cfo').includes('audit_integrity'));
  assert.deepEqual(names('supplier'), []);
});
