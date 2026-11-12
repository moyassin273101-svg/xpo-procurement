'use strict';
// End-to-end API tests on a real PostgreSQL seeded from the company's seed.json.
// DESTROYS the public schema of TEST_DATABASE_URL. Run: TEST_DATABASE_URL=postgres://... npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const URL = process.env.TEST_DATABASE_URL;
const skip = !URL && 'TEST_DATABASE_URL not set';
if (URL) { process.env.DATABASE_URL = URL; process.env.NODE_ENV = 'test'; }

let app, db, request;
const tokens = {};
async function login(email) {
  if (tokens[email]) return tokens[email];
  const r = await request(app).post('/api/auth/login').send({ email, password: 'Passw0rd!' });
  assert.equal(r.status, 200, `${email}: ${JSON.stringify(r.body)}`);
  return (tokens[email] = r.body.token);
}
const as = (who) => {
  const email = `${who}@x.sa`;
  const m = (verb) => async (url, body) => {
    const t = await login(email);
    const q = request(app)[verb](url).set('Authorization', `Bearer ${t}`);
    return body ? q.send(body) : q;
  };
  return { get: m('get'), post: m('post') };
};
const vendorId = async (name) => (await db.query('SELECT id FROM vendors WHERE name = $1', [name])).rows[0].id;
const VENDOR = 'مؤسسة إيه 31 لمواد البناء';
let n = 0;
const newReq = async (who, total, extra = {}) => as(who).post('/api/requests', {
  vendor_id: await vendorId(VENDOR), item: extra.item || `صنف اختبار ${++n}`, qty: 10, amount: total, vat_included: true,
  quote_ref: 'Q-TEST', ...extra });

before(async () => {
  if (skip) return;
  request = require('supertest');
  db = require('../src/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../scripts/migrate').migrate(db.pool);
  await require('../scripts/seed').seed(db.pool);
  app = require('../src/app').createApp();
});
after(async () => { if (!skip) await db.pool.end(); });

test('auth: unknown user, bad password, missing/invalid token', { skip }, async () => {
  assert.equal((await request(app).post('/api/auth/login').send({ email: 'someone@gmail.com', password: 'x' })).status, 401);
  assert.equal((await request(app).post('/api/auth/login').send({ email: 'mahdi@x.sa', password: 'nope' })).status, 401);
  assert.equal((await request(app).get('/api/requests')).status, 401);
  assert.equal((await request(app).get('/api/requests').set('Authorization', 'Bearer x.y.z')).status, 401);
});

test('seed: 280 requests; flags match seed.json (dup exactly, split ⊇ seed.splits); audit chain valid', { skip }, async () => {
  const seed = require('../seed.json');
  const all = await as('fahad').get('/api/requests?limit=1');
  assert.equal(all.body.total, 280);
  const nos = async (flag) => (await as('fahad').get(`/api/requests?flag=${flag}&limit=300`)).body.items.map((r) => r.no).sort();
  assert.deepEqual(await nos('dup'), seed.dups.map((d) => d.nos[1]).sort());
  const split = await nos('split');
  for (const no of seed.splits.flatMap((s) => s.nos)) assert.ok(split.includes(no), no);
  assert.equal(split.length, 21);
  assert.equal((await as('fahad').get('/api/audit/verify')).body.valid, true);
  // legacy Excel flags are kept too
  assert.equal((await as('fahad').get('/api/requests?flag=missing_cfo&limit=300')).body.total, 2);
});

test('RBAC and XPO.visible scoping', { skip }, async () => {
  assert.equal((await as('mahdi').get('/api/audit/verify')).status, 403);
  assert.equal((await as('mahdi').get('/api/invoices')).status, 403);
  assert.equal((await as('supplier').get('/api/requests')).status, 403);
  assert.equal((await as('rami').get('/api/reports/vendor-risk')).status, 403);
  assert.equal((await newReq('ceo', 100)).status, 403);
  const { rows: [mahdi] } = await db.query(`SELECT id FROM users WHERE email='mahdi@x.sa'`);
  const mine = await as('mahdi').get('/api/requests?limit=300');
  assert.ok(mine.body.total > 0 && mine.body.items.every((r) => r.requester_id === mahdi.id));
  const pm = await as('rami').get('/api/requests?limit=300');
  assert.ok(pm.body.items.every((r) => r.project === 'النخيل'));
  const { rows: [other] } = await db.query(`SELECT id FROM requests WHERE project <> 'النخيل' LIMIT 1`);
  assert.equal((await as('rami').get(`/api/requests/${other.id}`)).status, 404);
});

test('submission rules: own project only, quote required, VAT added when excluded', { skip }, async () => {
  assert.equal((await newReq('mahdi', 100, { project: 'الواحة' })).status, 400);
  assert.equal((await newReq('mahdi', 100, { quote_ref: ' ' })).status, 400);
  const r = await newReq('mahdi', 1000, { vat_included: false });
  assert.equal(r.status, 201);
  assert.equal(r.body.total, 1150);
  assert.match(r.body.no, /^PR-\d{4}-\d{4}$/);
});

test('three-stage approval ≥ 50,000 with order, project and SoD enforced; then dispatch to supplier', { skip }, async () => {
  const c = await newReq('mahdi', 60000);
  assert.deepEqual(c.body.stages, ['pm', 'cfo', 'ceo']);
  const id = c.body.id, url = `/api/requests/${id}/decision`;
  assert.equal((await as('khaled').post(url, { decision: 'approved' })).status, 403, 'PM of another project');
  assert.equal((await as('fahad').post(url, { decision: 'approved' })).status, 403, 'CFO before PM');
  assert.equal((await as('rami').post(url, { decision: 'approved' })).body.status, 'pending');
  assert.equal((await as('ceo').post(url, { decision: 'approved' })).status, 403, 'CEO before CFO');
  assert.equal((await as('fahad').post(url, { decision: 'approved' })).body.status, 'pending');
  assert.equal((await as('ceo').post(url, { decision: 'approved' })).body.status, 'approved');
  assert.equal((await as('fahad').post(`/api/requests/${id}/dispatch`)).status, 403);
  assert.equal((await as('procurement').post(`/api/requests/${id}/dispatch`)).status, 200);
  const orders = await as('supplier').get('/api/supplier/orders');
  assert.ok(orders.body.some((o) => o.no === c.body.no));
  assert.deepEqual(Object.keys(orders.body[0]).sort(), ['dispatched_at', 'item', 'no', 'project', 'qty']);
});

test('dispatch is blocked before approval; rejection needs a reason', { skip }, async () => {
  const c = await newReq('talal', 3000);
  assert.equal((await as('procurement').post(`/api/requests/${c.body.id}/dispatch`)).status, 409);
  assert.equal((await as('rami').post(`/api/requests/${c.body.id}/decision`, { decision: 'rejected' })).status, 403);
  assert.equal((await as('rami').post(`/api/requests/${c.body.id}/decision`, { decision: 'rejected', comment: 'لا حاجة' })).body.status, 'rejected');
});

test('duplicate needs confirmation; then flagged dup', { skip }, async () => {
  const item = 'بلوك 20 سم للسور';
  assert.equal((await newReq('mazen', 4000, { item })).status, 201);
  const dup = await newReq('mazen', 4010, { item: 'بلك 20 سم للسور' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.details.code, 'dup');
  const ok = await newReq('mazen', 4010, { item: 'بلك 20 سم للسور', confirm_dup: true });
  assert.equal(ok.status, 201);
  assert.ok(ok.body.flags.includes('dup'));
});

test('grouping escalates and flags both requests; CFO override restores PM-only', { skip }, async () => {
  const a = await newReq('jaber', 6000, { item: 'كيابل 4 مم' });
  assert.deepEqual(a.body.stages, ['pm']);
  const b = await newReq('jaber', 6000, { item: 'كيابل 6 مم' });
  assert.deepEqual(b.body.stages, ['pm', 'cfo']);
  assert.ok(b.body.flags.includes('split'));
  assert.ok((await as('jaber').get(`/api/requests/${a.body.id}`)).body.flags.includes('split'));
  assert.equal((await as('yasser').post(`/api/requests/${b.body.id}/override-grouping`, { reason: 'x' })).status, 403);
  const o = await as('fahad').post(`/api/requests/${b.body.id}/override-grouping`, { reason: 'احتياجان مختلفان' });
  assert.deepEqual(o.body.stages, ['pm']);
  assert.equal((await as('yasser').post(`/api/requests/${b.body.id}/decision`, { decision: 'approved' })).body.status, 'approved');
});

test('CFO delegation to finance: on-behalf approval, PM cannot delegate, CEO revokes', { skip }, async () => {
  const { rows: [saad] } = await db.query(`SELECT id FROM users WHERE email='saad@x.sa'`);
  const { rows: [rami] } = await db.query(`SELECT id FROM users WHERE email='rami@x.sa'`);
  const now = Date.now();
  const body = { to_id: saad.id, starts_at: new Date(now - 60_000).toISOString(), ends_at: new Date(now + 5 * 86_400_000).toISOString() };
  assert.equal((await as('rami').post('/api/delegations', body)).status, 403);
  assert.equal((await as('fahad').post('/api/delegations', { ...body, to_id: rami.id })).status, 400, 'delegate must be finance/ops');
  assert.equal((await as('fahad').post('/api/delegations', { ...body, ends_at: new Date(now + 40 * 86_400_000).toISOString() })).status, 400);
  const d = await as('fahad').post('/api/delegations', body);
  assert.equal(d.status, 201, JSON.stringify(d.body));

  const c = await newReq('qusai', 20000);
  await as('khaled').post(`/api/requests/${c.body.id}/decision`, { decision: 'approved' });
  const inbox = await as('saad').get('/api/requests/inbox');
  assert.ok(inbox.body.some((r) => r.id === c.body.id && r.on_behalf_of));
  assert.equal((await as('saad').post(`/api/requests/${c.body.id}/decision`, { decision: 'approved' })).body.status, 'approved');
  const { rows: [a] } = await db.query(`SELECT on_behalf_of FROM approvals WHERE request_id=$1 AND stage='cfo'`, [c.body.id]);
  assert.ok(a.on_behalf_of);

  assert.equal((await as('ceo').post(`/api/delegations/${d.body.id}/revoke`)).status, 200);
  const c2 = await newReq('qusai', 20000, { item: 'صنف بعد الإلغاء' });
  await as('khaled').post(`/api/requests/${c2.body.id}/decision`, { decision: 'approved' });
  assert.equal((await as('saad').post(`/api/requests/${c2.body.id}/decision`, { decision: 'approved' })).status, 403);
});

test('invoices: XENT matching, duplicate number blocked, posting needs override reason', { skip }, async () => {
  const c = await newReq('malek', 20000);
  await as('khaled').post(`/api/requests/${c.body.id}/decision`, { decision: 'approved' });
  await as('fahad').post(`/api/requests/${c.body.id}/decision`, { decision: 'approved' });
  assert.equal((await as('mahdi').post('/api/invoices', { po_no: c.body.no, amount: 20000 })).status, 403);
  const ok = await as('procurement').post('/api/invoices', { po_no: c.body.no, invoice_no: 'F-100', amount: 20300 });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.verdict, 'clean');
  assert.equal(ok.body.vendor, VENDOR, 'vendor defaults to the PO vendor');
  const dup = await as('procurement').post('/api/invoices', { po_no: c.body.no, invoice_no: 'F-100', amount: 20000 });
  assert.equal(dup.body.verdict, 'blocked');
  assert.equal((await as('procurement').post(`/api/invoices/${ok.body.id}/post`, {})).status, 403);
  assert.equal((await as('saad').post(`/api/invoices/${ok.body.id}/post`, {})).body.status, 'posted');
  assert.equal((await as('fahad').post(`/api/invoices/${dup.body.id}/post`, {})).status, 409);
  assert.equal((await as('fahad').post(`/api/invoices/${dup.body.id}/post`, { override: true })).status, 409, 'reason required');
  assert.equal((await as('fahad').post(`/api/invoices/${dup.body.id}/post`, { override: true, reason: 'فاتورة مصححة' })).body.status, 'posted');
  const ghost = await as('procurement').post('/api/invoices', { po_no: 'PR-2026-9999', amount: 5 });
  assert.equal(ghost.body.verdict, 'blocked');
  assert.equal((await as('procurement').post(`/api/invoices/${ghost.body.id}/reject`, { reason: 'لا يوجد أمر شراء' })).body.status, 'rejected');
  assert.equal((await as('fahad').post(`/api/invoices/${ghost.body.id}/post`, { override: true, reason: 'x' })).status, 409);
});

test('reports, exports and immutable audit log', { skip }, async () => {
  const k = await as('ceo').get('/api/reports/kpis');
  assert.ok(k.body.totalRequests >= 280 && k.body.flagged > 0);
  const b = await as('rami').get('/api/reports/budgets');
  assert.deepEqual(b.body.map((x) => x.project), ['النخيل']);
  assert.ok((await as('fahad').get('/api/reports/aging')).body.length >= 7);
  assert.ok((await as('procurement').get('/api/reports/vendor-risk')).body.length > 0);
  const csv = await as('fahad').get('/api/reports/export/requests.csv');
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.ok(csv.text.includes('PR-2026-0001'));
  assert.equal((await as('procurement').get('/api/reports/export/audit.csv')).status, 403);
  await assert.rejects(db.query(`UPDATE audit_log SET action='x' WHERE id=1`), /append-only/);
  assert.equal((await as('fahad').get('/api/audit/verify')).body.valid, true);
});

test('AI endpoints: role-gated and 503 without a key', { skip }, async () => {
  assert.equal((await as('mahdi').post('/api/ai/invoice', { text: 'x' })).status, 403);
  assert.equal((await as('supplier').post('/api/ai/analyst', { question: 'كم؟' })).status, 403);
  require('../src/ai/client').setClient(null);
  assert.equal((await as('mahdi').post('/api/ai/analyst', { question: 'كم طلبًا لدي؟' })).status, 503);
});
