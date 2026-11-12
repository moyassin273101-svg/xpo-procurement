'use strict';
// Vanilla SPA for شركة إكس. All dynamic text goes through esc() — never insert API data as raw HTML.
const API = '/api';
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const state = { token: null, user: null, perms: new Set(), cfg: null, vendors: null, chat: [] };

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sar = (n) => n == null ? '—' : new Intl.NumberFormat('ar-SA', { style: 'currency', currency: 'SAR', maximumFractionDigits: 2 }).format(n);
const num = (n) => n == null ? '—' : new Intl.NumberFormat('ar-SA', { maximumFractionDigits: 2 }).format(n);
const pct = (x) => x == null ? '—' : num(Math.round(x * 1000) / 10) + '٪';
const date = (d) => d ? new Intl.DateTimeFormat('ar-SA-u-ca-gregory', { dateStyle: 'medium' }).format(new Date(d)) : '—';
const dateTime = (d) => d ? new Intl.DateTimeFormat('ar-SA-u-ca-gregory', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(d)) : '—';
const can = (p) => state.perms.has(p);

const STATUS = { pending: 'قيد الاعتماد', approved: 'معتمد', rejected: 'مرفوض', cancelled: 'ملغى',
  review: 'للمراجعة', posted: 'مرحّلة', clean: 'مطابقة', blocked: 'موقوفة' };
const STAGE = { pm: 'مدير المشروع', cfo: 'المدير المالي', ceo: 'الرئيس التنفيذي' };
const ROLE = { engineer: 'مهندس موقع', pm: 'مدير مشروع', cfo: 'المدير المالي', ceo: 'الرئيس التنفيذي', finance: 'الإدارة المالية',
  ops: 'العمليات', procurement: 'المشتريات', supplier: 'مورد', admin: 'مسؤول النظام' };
const FLAG = { split: 'تجزئة محتملة', dup: 'تكرار محتمل', after_reject: 'تنفيذ بعد الرفض', missing_cfo: 'ينقصه اعتماد المالي',
  missing_ceo: 'ينقصه اعتماد الرئيس', near_threshold: 'قريب من الحد', no_approver: 'بلا معتمد' };
const SEV = { c: 'exception', h: 'rejected', m: 'pending', ok: 'approved' };
const badge = (cls, label) => `<span class="badge ${esc(cls)}">${esc(label ?? STATUS[cls] ?? cls)}</span>`;
const flagBadges = (flags = []) => flags.map((f) => badge(['split', 'dup', 'after_reject', 'missing_cfo', 'missing_ceo', 'no_approver'].includes(f) ? 'flag' : 'pending', '⚠ ' + (FLAG[f] || f))).join('');

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = ''), 3500);
}

class ApiError extends Error { constructor(msg, status, details) { super(msg); this.status = status; this.details = details; } }

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(API + path, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && state.token) { logout(); throw new ApiError('انتهت الجلسة', 401); }
  if (raw) { if (!res.ok) throw new ApiError('فشل التحميل', res.status); return res; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(Array.isArray(data.details) && data.details[0]?.message ? `${data.error}: ${data.details[0].message}` : data.error || 'خطأ غير متوقع', res.status, data.details);
  return data;
}

const act = (fn) => async (ev) => {
  ev?.preventDefault?.();
  const btn = ev?.submitter || (ev?.currentTarget?.tagName === 'BUTTON' ? ev.currentTarget : null);
  if (btn) btn.disabled = true;
  try { await fn(ev); } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; }
};

// ---------------- Session ----------------
function saveSession() { try { sessionStorage.setItem('session', JSON.stringify({ token: state.token })); } catch {} }
function logout() {
  Object.assign(state, { token: null, user: null, perms: new Set(), chat: [] });
  try { sessionStorage.removeItem('session'); } catch {}
  location.hash = '#/login';
  render();
}
$('#logout').addEventListener('click', logout);

async function loadMe() {
  const me = await api('/me');
  state.user = me.user;
  state.perms = new Set(me.permissions);
  state.cfg = me.config;
  $('#who').textContent = `${me.user.name} · ${ROLE[me.user.role]}${me.user.project ? ' · ' + me.user.project : ''}`;
}

// ---------------- Router ----------------
const NAV = [
  { href: '#/', ico: '⌂', label: 'الرئيسية', show: () => !can('supplier:orders') },
  { href: '#/orders', ico: '📦', label: 'أوامري', show: () => can('supplier:orders') },
  { href: '#/inbox', ico: '✓', label: 'للاعتماد', show: () => can('request:approve') },
  { href: '#/requests', ico: '☰', label: 'الطلبات', show: () => can('request:read') },
  { href: '#/invoices', ico: '🧾', label: 'الفواتير', show: () => can('invoice:read') },
  { href: '#/delegations', ico: '⇄', label: 'التفويض', show: () => can('delegation:read') },
  { href: '#/reports', ico: '▤', label: 'التقارير', show: () => can('report:budget') || can('report:vendor_risk') || can('audit:read') },
  { href: '#/ai', ico: '✦', label: 'المحلل', show: () => can('ai:analyst') },
];

const routes = [
  [/^#\/login$/, viewLogin],
  [/^#\/?$/, () => (can('supplier:orders') ? viewOrders() : viewHome())],
  [/^#\/orders$/, viewOrders],
  [/^#\/inbox$/, viewInbox],
  [/^#\/requests$/, viewRequests],
  [/^#\/requests\/new$/, viewNewRequest],
  [/^#\/requests\/(\d+)$/, viewRequest],
  [/^#\/invoices$/, viewInvoices],
  [/^#\/invoices\/new$/, viewNewInvoice],
  [/^#\/invoices\/(\d+)$/, viewInvoice],
  [/^#\/delegations$/, viewDelegations],
  [/^#\/reports$/, viewReports],
  [/^#\/ai$/, viewAI],
];

async function render() {
  const hash = location.hash || '#/';
  const authed = Boolean(state.token && state.user);
  $('.topbar').hidden = !authed;
  $('#tabs').hidden = !authed;
  if (!authed && hash !== '#/login') { location.hash = '#/login'; return; }
  if (authed && hash === '#/login') { location.hash = '#/'; return; }
  if (authed) {
    $('#tabs').innerHTML = NAV.filter((n) => n.show()).map((n) =>
      `<a href="${n.href}" class="${(hash === n.href || (n.href !== '#/' && hash.startsWith(n.href))) ? 'active' : ''}"><span class="ico" aria-hidden="true">${n.ico}</span>${n.label}</a>`).join('');
  }
  const routePath = hash.split('?')[0];
  for (const [re, fn] of routes) {
    const m = routePath.match(re);
    if (m) {
      view.innerHTML = '<p class="empty">جارٍ التحميل…</p>';
      try { await fn(...m.slice(1)); } catch (e) { view.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
      window.scrollTo(0, 0);
      return;
    }
  }
  view.innerHTML = '<p class="empty">الصفحة غير موجودة</p>';
}
window.addEventListener('hashchange', render);

// ---------------- Views ----------------
function viewLogin() {
  view.innerHTML = `<div class="login card"><h1>تسجيل الدخول</h1>
    <form id="f"><label>البريد الإلكتروني<input name="email" type="email" autocomplete="username" required dir="ltr"></label>
    <label>كلمة المرور<input name="password" type="password" autocomplete="current-password" required dir="ltr"></label>
    <button>دخول</button></form>
    <p class="hint">حسابات تجريبية: mahdi@x.sa (مهندس) · rami@x.sa (مدير مشروع) · fahad@x.sa (المالي) · ceo@x.sa · saad@x.sa · procurement@x.sa · supplier@x.sa</p></div>`;
  $('#f').addEventListener('submit', act(async (e) => {
    const fd = new FormData(e.target);
    const r = await api('/auth/login', { method: 'POST', body: { email: fd.get('email'), password: fd.get('password') } });
    state.token = r.token;
    saveSession();
    await loadMe();
    location.hash = '#/';
  }));
}

const reqItem = (r) => `<a class="item" href="#/requests/${r.id}">
  <div class="row"><span class="t">${esc(r.item)}</span><span class="amt">${sar(r.total)}</span></div>
  <div class="row muted"><span>${esc(r.no)} · ${esc(r.project)} · ${esc(r.vendor_name)}${r.requester_name ? ' · ' + esc(r.requester_name) : ''}</span>
  <span>${badge(r.status)}</span></div>
  ${(r.flags || []).length ? `<div>${flagBadges(r.flags)}</div>` : ''}
  ${r.pending_stage ? `<div class="muted">المرحلة: ${STAGE[r.pending_stage]}${r.on_behalf_of ? ' (بالتفويض)' : ''}</div>` : ''}</a>`;

async function viewHome() {
  const [inbox, recent, k] = await Promise.all([
    can('request:approve') ? api('/requests/inbox') : Promise.resolve([]),
    api('/requests?limit=5'),
    can('report:kpi') ? api('/reports/kpis') : Promise.resolve(null),
  ]);
  const t = state.cfg.thresholds;
  view.innerHTML = `<h1>مرحبًا ${esc(state.user.name)}</h1>
    ${k ? `<div class="grid">
      <div class="card stat"><div class="v">${sar(k.totalApproved)}</div><div class="l">المعتمد</div></div>
      <div class="card stat"><div class="v">${num(k.pendingCount)}</div><div class="l">قيد الاعتماد · ${sar(k.pendingValue)}</div></div>
      <div class="card stat"><div class="v">${num(k.breaches)}</div><div class="l">تجاوزت ٤٨ ساعة</div></div>
      <div class="card stat"><div class="v">${num(k.flagged)}</div><div class="l">طلبات عليها ملاحظات</div></div>
      <div class="card stat"><div class="v">${num(k.invoicesReview)}</div><div class="l">فواتير للمراجعة</div></div>
      <div class="card stat"><div class="v">${num(k.invoicesBlocked)}</div><div class="l">فواتير موقوفة</div></div>
    </div>` : ''}
    <p class="muted">حدود الاعتماد: أقل من ${num(t.cfo)} مدير المشروع · من ${num(t.cfo)} يضاف المالي · من ${num(t.ceo)} يضاف الرئيس التنفيذي</p>
    ${can('request:approve') ? `<h2>بانتظار اعتمادك (${num(inbox.length)})</h2><div class="list">${inbox.slice(0, 5).map(reqItem).join('') || '<p class="empty">لا شيء بانتظارك</p>'}</div>` : ''}
    <h2>أحدث الطلبات</h2>
    ${can('request:create') ? '<p><a href="#/requests/new"><button>+ طلب شراء جديد</button></a></p>' : ''}
    <div class="list">${recent.items.map(reqItem).join('') || '<p class="empty">لا توجد طلبات</p>'}</div>`;
}

async function viewOrders() {
  const items = await api('/supplier/orders');
  view.innerHTML = `<h1>أوامر الشراء المرسلة إليكم</h1><div class="list">${items.map((o) => `<div class="item">
    <div class="row"><span class="t">${esc(o.item)}</span><span class="amt">${num(o.qty)}</span></div>
    <div class="row muted"><span>${esc(o.no)} · ${esc(o.project)}</span><span>${dateTime(o.dispatched_at)}</span></div></div>`).join('') || '<p class="empty">لا توجد أوامر</p>'}</div>`;
}

async function viewInbox() {
  const items = await api('/requests/inbox');
  view.innerHTML = `<h1>بانتظار اعتمادك</h1><div class="list">${items.map(reqItem).join('') || '<p class="empty">لا توجد طلبات بانتظارك 🎉</p>'}</div>`;
}

async function viewRequests() {
  view.innerHTML = `<h1>طلبات الشراء</h1>
    <div class="toolbar"><input id="q" type="search" placeholder="بحث بالصنف أو الرقم أو المورد">
    <select id="st"><option value="">كل الحالات</option>${['pending', 'approved', 'rejected', 'cancelled'].map((s) => `<option value="s:${s}">${STATUS[s]}</option>`).join('')}
    ${Object.entries(FLAG).map(([k, v]) => `<option value="f:${k}">⚠ ${v}</option>`).join('')}</select></div>
    ${can('request:create') ? '<p><a href="#/requests/new"><button>+ طلب جديد</button></a></p>' : ''}
    <p class="muted" id="count"></p><div id="res" class="list"></div><p><button class="secondary" id="more" hidden>المزيد</button></p>`;
  let offset = 0;
  const load = async (reset) => {
    if (reset) { offset = 0; $('#res').innerHTML = ''; }
    const [kind, val] = ($('#st').value || ':').split(':');
    const qs = new URLSearchParams({ limit: 30, offset, ...(kind === 's' ? { status: val } : {}), ...(kind === 'f' ? { flag: val } : {}),
      ...($('#q').value ? { q: $('#q').value } : {}) });
    const r = await api(`/requests?${qs}`);
    $('#count').textContent = `${num(r.total)} طلب`;
    $('#res').insertAdjacentHTML('beforeend', r.items.map(reqItem).join('') || (reset ? '<p class="empty">لا نتائج</p>' : ''));
    offset += r.items.length;
    $('#more').hidden = offset >= r.total;
  };
  let t;
  $('#q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load(true).catch((e) => toast(e.message, true)), 300); });
  $('#st').addEventListener('change', () => load(true).catch((e) => toast(e.message, true)));
  $('#more').addEventListener('click', act(() => load(false)));
  await load(true);
}

const vendors = async () => (state.vendors ||= await api('/vendors'));

async function viewNewRequest() {
  const vs = await vendors();
  const t = state.cfg.thresholds;
  view.innerHTML = `<h1>طلب شراء جديد</h1><form id="f" class="card">
    <p class="muted">المشروع: <strong>${esc(state.user.project)}</strong></p>
    <label>الصنف<input name="item" required maxlength="300"></label>
    <label>المورد<select name="vendor_id" required><option value="">اختر…</option>${vs.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select></label>
    <label>الكمية<input name="qty" type="number" inputmode="decimal" min="0.001" step="any" required dir="ltr"></label>
    <label>المبلغ (ريال)<input name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" required dir="ltr"></label>
    <label class="check"><input name="vat_included" type="checkbox" checked> المبلغ شامل ضريبة القيمة المضافة</label>
    <label>مرجع عرض السعر (إلزامي)<input name="quote_ref" required maxlength="200"></label>
    <label>عدد العروض<input name="quotes_count" type="number" min="1" max="20" value="1" dir="ltr"></label>
    <label>ملاحظات<textarea name="notes" rows="2" maxlength="1000"></textarea></label>
    <p class="muted" id="lv"></p><button>إرسال للاعتماد</button></form>`;
  const f = $('#f');
  const preview = () => {
    const a = Number(f.amount.value);
    const total = f.vat_included.checked ? a : a * (1 + state.cfg.vat);
    const stages = ['pm', ...(total >= t.cfo ? ['cfo'] : []), ...(total >= t.ceo ? ['ceo'] : [])];
    $('#lv').textContent = a > 0 ? `الإجمالي ${sar(Math.round(total * 100) / 100)} · المسار: ${stages.map((s) => STAGE[s]).join(' ← ')} (قد يُصعَّد عند تجميع طلبات متقاربة)` : '';
  };
  f.amount.addEventListener('input', preview);
  f.vat_included.addEventListener('change', preview);
  const send = async (confirm_dup) => {
    const fd = Object.fromEntries(new FormData(f));
    return api('/requests', { method: 'POST', body: { item: fd.item, vendor_id: Number(fd.vendor_id), qty: Number(fd.qty), amount: Number(fd.amount),
      vat_included: f.vat_included.checked, quote_ref: fd.quote_ref, quotes_count: Number(fd.quotes_count || 1), notes: fd.notes || undefined,
      ...(confirm_dup ? { confirm_dup: true } : {}) } });
  };
  f.addEventListener('submit', act(async () => {
    let r;
    try { r = await send(false); } catch (e) {
      if (e.status !== 409 || e.details?.code !== 'dup') throw e;
      const list = e.details.dups.map((d) => `${d.no}: ${d.item} (${num(d.total)})`).join('\n');
      if (!confirm(`يوجد طلب مشابه خلال الأيام الماضية:\n${list}\n\nهل تؤكد أنه ليس تكرارًا؟`)) return;
      r = await send(true);
    }
    toast(r.assess?.escalated ? 'أُرسل الطلب — صُعِّد بسبب تجميع طلبات متقاربة' : 'تم إرسال الطلب');
    location.hash = `#/requests/${r.id}`;
  }));
}

async function viewRequest(id) {
  const r = await api(`/requests/${id}`);
  const steps = r.stages.map((s) => {
    const a = r.approvals.filter((x) => x.stage === s).at(-1);
    return `<li>${STAGE[s]} — ${a ? `${badge(a.decision)} ${esc(a.user_name)}${a.on_behalf_of_name ? ` (نيابة عن ${esc(a.on_behalf_of_name)})` : ''}
      <div class="muted">${dateTime(a.at)}${a.comment ? ' · ' + esc(a.comment) : ''}</div>` : (r.status === 'pending' && r.next_stage === s ? badge('pending', 'الحالية') : '<span class="muted">—</span>')}</li>`;
  }).join('');
  const g = r.grouping;
  view.innerHTML = `<p><a href="#/requests">→ الطلبات</a></p>
    <div class="card"><div class="head"><h1>${esc(r.no)}</h1>${badge(r.status)}</div>
    <p>${esc(r.item)}</p><p class="amt big">${sar(r.total)}</p>
    <table><tr><td class="muted">المورد</td><td>${esc(r.vendor_name)}</td></tr>
    <tr><td class="muted">المشروع</td><td>${esc(r.project)}</td></tr>
    <tr><td class="muted">الكمية</td><td>${num(r.qty)}</td></tr>
    <tr><td class="muted">مقدم الطلب</td><td>${esc(r.requester_name)}</td></tr>
    <tr><td class="muted">عرض السعر</td><td>${esc(r.quote_ref)} (${num(r.quotes_count)} عرض)</td></tr>
    <tr><td class="muted">التاريخ</td><td>${dateTime(r.created_at)}</td></tr>
    ${r.notes ? `<tr><td class="muted">ملاحظات</td><td>${esc(r.notes)}</td></tr>` : ''}
    ${r.dispatched_at ? `<tr><td class="muted">أُرسل للمورد</td><td>${dateTime(r.dispatched_at)}</td></tr>` : ''}
    ${r.legacy ? `<tr><td class="muted">من السجل القديم</td><td>${esc(r.legacy.appr || '—')}</td></tr>` : ''}</table></div>
    ${(r.flags || []).length ? `<h2>ملاحظات التدقيق</h2><div class="card">${flagBadges(r.flags)}</div>` : ''}
    ${g ? `<div class="flag">تجميع احتياج: مع ${esc((g.relatedNos || []).join('، '))} — الإجمالي المجمّع ${sar(g.combinedTotal)}
      ${g.overridden ? `<div class="muted">فُصل التجميع: ${esc(g.overridden.reason)}</div>` : ''}</div>` : ''}
    ${r.dup_confirmed ? `<div class="flag">أكّد مقدم الطلب أنه ليس تكرارًا لـ ${esc(r.dup_confirmed.join('، '))}</div>` : ''}
    <h2>مسار الاعتماد</h2><div class="card"><ul class="timeline">${steps}</ul></div>
    <div id="acts"></div>`;
  const acts = $('#acts');
  if (r.can_decide) {
    acts.innerHTML = `<h2>قرارك — ${STAGE[r.decide_stage]}${r.on_behalf_of ? ' (بالتفويض)' : ''}</h2><div class="card"><form id="d">
      <label>ملاحظة (إلزامية عند الرفض)<textarea name="comment" rows="2"></textarea></label>
      <div class="actions"><button name="decision" value="approved">اعتماد</button><button class="danger" name="decision" value="rejected">رفض</button></div></form></div>`;
    $('#d').addEventListener('submit', act(async (e) => {
      const decision = e.submitter.value, comment = $('#d').comment.value.trim();
      if (decision === 'rejected' && !comment) throw new Error('اكتب سبب الرفض');
      await api(`/requests/${id}/decision`, { method: 'POST', body: { decision, ...(comment ? { comment } : {}) } });
      toast(decision === 'approved' ? 'تم الاعتماد' : 'تم الرفض');
      render();
    }));
  }
  if (r.can_override && can('request:override_grouping')) {
    acts.insertAdjacentHTML('beforeend', `<h2>فصل التجميع</h2><form id="ov" class="card">
      <label>سبب اعتباره احتياجًا منفصلًا<textarea name="reason" rows="2" required></textarea></label><button class="secondary">فصل وإعادة المسار</button></form>`);
    $('#ov').addEventListener('submit', act(async () => {
      await api(`/requests/${id}/override-grouping`, { method: 'POST', body: { reason: $('#ov').reason.value.trim() } }); toast('تم الفصل'); render();
    }));
  }
  if (r.status === 'pending' && r.requester_id === state.user.id) {
    acts.insertAdjacentHTML('beforeend', '<p><button class="secondary" id="cx">إلغاء الطلب</button></p>');
    $('#cx').addEventListener('click', act(async () => {
      const reason = prompt('سبب الإلغاء (اختياري)');
      if (reason === null) return;
      await api(`/requests/${id}/cancel`, { method: 'POST', body: reason ? { reason } : {} }); toast('تم الإلغاء'); render();
    }));
  }
  if (can('request:dispatch') && r.status === 'approved' && !r.dispatched_at) {
    acts.insertAdjacentHTML('beforeend', '<p><button id="dp">إرسال أمر الشراء للمورد</button></p>');
    $('#dp').addEventListener('click', act(async () => { await api(`/requests/${id}/dispatch`, { method: 'POST' }); toast('أُرسل للمورد'); render(); }));
  }
  if (can('invoice:create') && r.status === 'approved')
    acts.insertAdjacentHTML('beforeend', `<p><a href="#/invoices/new?po=${encodeURIComponent(r.no)}"><button class="secondary">+ فاتورة على هذا الطلب</button></a></p>`);
}

const invItem = (i) => `<a class="item" href="#/invoices/${i.id}"><div class="row"><span class="t">${esc(i.vendor)}</span><span class="amt">${sar(i.amount)}</span></div>
  <div class="row muted"><span>${esc(i.code)} · ${esc(i.po_no)}${i.invoice_no ? ' · ' + esc(i.invoice_no) : ''}${i.source === 'ai' ? ' · ✦' : ''}</span>
  <span>${badge(i.status)}${i.status === 'review' ? badge(i.verdict === 'clean' ? 'approved' : i.verdict === 'blocked' ? 'exception' : 'pending', STATUS[i.verdict]) : ''}</span></div></a>`;

async function viewInvoices() {
  view.innerHTML = `<h1>الفواتير</h1><div class="toolbar"><select id="st"><option value="">الكل</option>
    <option value="s:review">للمراجعة</option><option value="v:blocked">موقوفة</option><option value="s:posted">مرحّلة</option><option value="s:rejected">معادة</option></select></div>
    ${can('invoice:create') ? '<p><a href="#/invoices/new"><button>+ فاتورة (يدوي أو بالذكاء الاصطناعي)</button></a></p>' : ''}<div id="res" class="list"></div>`;
  const load = async () => {
    const [k, v] = ($('#st').value || ':').split(':');
    const items = await api(`/invoices${k ? `?${k === 's' ? 'status' : 'verdict'}=${v}` : ''}`);
    $('#res').innerHTML = items.map(invItem).join('') || '<p class="empty">لا توجد فواتير</p>';
  };
  $('#st').addEventListener('change', () => load().catch((e) => toast(e.message, true)));
  await load();
}

const flagList = (flags) => (flags || []).map((f) => `<div class="flag sev-${esc(f.sev)}">${esc(f.text)}</div>`).join('')
  || '<p class="muted">✅ لا ملاحظات</p>';

async function viewNewInvoice() {
  const po = new URLSearchParams(location.hash.split('?')[1] || '').get('po') || '';
  view.innerHTML = `<p><a href="#/invoices">→ الفواتير</a></p><h1>فاتورة جديدة</h1>
    ${can('ai:invoice') ? `<div class="card"><h2 class="first">✦ استخراج بالذكاء الاصطناعي</h2>
    <form id="ai"><label>الصق نص الفاتورة<textarea name="text" rows="5"></textarea></label>
    <label>أو ارفع PDF/صورة<input name="file" type="file" accept="application/pdf,image/png,image/jpeg,image/webp"></label>
    <button class="secondary">استخراج ومطابقة</button></form><div id="air"></div></div>` : ''}
    <form id="f" class="card"><h2 class="first">إدخال يدوي</h2>
    <label>رقم أمر الشراء<input name="po_no" required dir="ltr" placeholder="PR-2026-0001" value="${esc(po)}"></label>
    <label>رقم الفاتورة<input name="invoice_no" dir="ltr"></label>
    <label>المورد (يُؤخذ من أمر الشراء إن تُرك)<input name="vendor"></label>
    <label>الرقم الضريبي للمورد<input name="vat_no" dir="ltr" inputmode="numeric"></label>
    <label>الصافي قبل الضريبة<input name="subtotal" type="number" step="0.01" min="0" dir="ltr"></label>
    <label>الضريبة<input name="vat" type="number" step="0.01" min="0" dir="ltr"></label>
    <label>الإجمالي<input name="amount" type="number" step="0.01" min="0.01" required dir="ltr"></label>
    <label>الكمية<input name="qty" type="number" step="any" min="0" dir="ltr"></label>
    <label>التاريخ<input name="date" type="date"></label><button>حفظ ومطابقة</button></form>`;
  $('#f').addEventListener('submit', act(async () => {
    const fd = Object.fromEntries([...new FormData($('#f'))].filter(([, v]) => v !== ''));
    for (const k of ['subtotal', 'vat', 'amount', 'qty']) if (fd[k]) fd[k] = Number(fd[k]);
    const r = await api('/invoices', { method: 'POST', body: fd });
    toast(`${r.code}: ${STATUS[r.verdict]}`);
    location.hash = `#/invoices/${r.id}`;
  }));
  const aiForm = $('#ai');
  if (!aiForm) return;
  let last = null;
  aiForm.addEventListener('submit', act(async () => {
    const file = aiForm.file.files[0];
    const body = { text: aiForm.text.value.trim() || undefined };
    if (file) {
      if (file.size > 10 * 1024 * 1024) throw new Error('الحد الأقصى 10MB');
      body.file_base64 = await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.onerror = no; fr.readAsDataURL(file); });
      body.media_type = file.type;
    }
    if (!body.text && !body.file_base64) throw new Error('أدخل نصًا أو ملفًا');
    $('#air').innerHTML = '<p class="muted">جارٍ التحليل…</p>';
    last = body;
    const r = await api('/ai/invoice', { method: 'POST', body });
    const x = r.extracted;
    $('#air').innerHTML = `<h2>النتيجة</h2><table>
      <tr><td class="muted">المورد</td><td>${esc(x.vendor_name)}</td></tr>
      <tr><td class="muted">رقم الفاتورة</td><td>${esc(x.invoice_no || '—')}</td></tr>
      <tr><td class="muted">الإجمالي</td><td class="amt">${sar(x.total_amount)}</td></tr><tr><td class="muted">الضريبة</td><td class="amt">${sar(x.vat_amount)}</td></tr>
      <tr><td class="muted">أمر الشراء</td><td>${r.po.no ? esc(r.po.no) + (r.po.how === 'closest_amount' ? ' (أقرب مبلغ)' : '') : '❌ لم يُحدَّد'}</td></tr>
      ${x.confidence != null ? `<tr><td class="muted">الثقة</td><td>${pct(x.confidence)}</td></tr>` : ''}</table>
      ${x.notes ? `<div class="flag">${esc(x.notes)}</div>` : ''}
      ${r.match ? `<h2>المطابقة ${badge(r.match.verdict.k === 'clean' ? 'approved' : r.match.verdict.k === 'blocked' ? 'exception' : 'pending', r.match.verdict.ar)}</h2>${flagList(r.match.flags)}` : ''}
      ${r.po.no ? '<p><button id="save">تأكيد وحفظ الفاتورة</button></p>' : ''}`;
    $('#save')?.addEventListener('click', act(async () => {
      const s = await api('/ai/invoice', { method: 'POST', body: { ...last, save: true } });
      toast('تم حفظ الفاتورة');
      location.hash = `#/invoices/${s.saved.id}`;
    }));
  }));
}

async function viewInvoice(id) {
  const i = await api(`/invoices/${id}`);
  view.innerHTML = `<p><a href="#/invoices">→ الفواتير</a></p><div class="card">
    <div class="head"><h1>${esc(i.code)}</h1>${badge(i.status)}</div>
    <p class="amt big">${sar(i.amount)}</p><table>
    <tr><td class="muted">المورد</td><td>${esc(i.vendor)}</td></tr>
    <tr><td class="muted">أمر الشراء</td><td>${i.request_id ? `<a href="#/requests/${i.request_id}">${esc(i.po_no)}</a>` : esc(i.po_no)}</td></tr>
    <tr><td class="muted">رقم الفاتورة</td><td>${esc(i.invoice_no || '—')}</td></tr>
    <tr><td class="muted">الصافي / الضريبة</td><td class="amt">${sar(i.subtotal)} / ${sar(i.vat)}</td></tr>
    <tr><td class="muted">الكمية</td><td>${num(i.qty)}</td></tr><tr><td class="muted">التاريخ</td><td>${date(i.date)}</td></tr>
    <tr><td class="muted">المصدر</td><td>${i.source === 'ai' ? '✦ استخراج آلي' : 'يدوي'}</td></tr>
    ${i.override ? `<tr><td class="muted">تجاوز</td><td>${esc(i.override.reason)}</td></tr>` : ''}
    ${i.reject_reason ? `<tr><td class="muted">سبب الإعادة</td><td>${esc(i.reject_reason)}</td></tr>` : ''}</table></div>
    <h2>المطابقة — ${esc(STATUS[i.verdict])}</h2><div class="card">${flagList(i.flags)}</div><div id="acts"></div>`;
  if (i.status !== 'review') return;
  const blocked = i.verdict === 'blocked';
  const acts = $('#acts');
  if (can('invoice:post')) {
    acts.insertAdjacentHTML('beforeend', `<form id="p" class="card">${blocked ? '<label>سبب التجاوز (إلزامي لوجود ملاحظات حرجة)<textarea name="reason" rows="2" required></textarea></label>' : ''}
      <button>${blocked ? 'ترحيل مع تجاوز' : 'ترحيل الفاتورة'}</button></form>`);
    $('#p').addEventListener('submit', act(async () => {
      await api(`/invoices/${id}/post`, { method: 'POST', body: blocked ? { override: true, reason: $('#p').reason.value.trim() } : {} });
      toast('تم الترحيل'); render();
    }));
  }
  if (can('invoice:reject')) {
    acts.insertAdjacentHTML('beforeend', `<form id="rj" class="card"><label>سبب الإعادة<textarea name="reason" rows="2" required></textarea></label>
      <button class="danger">إعادة الفاتورة</button></form>`);
    $('#rj').addEventListener('submit', act(async () => {
      await api(`/invoices/${id}/reject`, { method: 'POST', body: { reason: $('#rj').reason.value.trim() } }); toast('أُعيدت'); render();
    }));
  }
}

async function viewDelegations() {
  const [list, users] = await Promise.all([api('/delegations'), can('delegation:create') ? api('/users') : Promise.resolve([])]);
  const now = new Date(), later = new Date(+now + 7 * 864e5);
  const local = (d) => new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  view.innerHTML = `<h1>التفويض</h1>
    ${can('delegation:create') ? `<form id="f" class="card"><h2 class="first">تفويض الاعتماد المالي</h2>
    <p class="muted">لموظف من الإدارة المالية أو العمليات، بحد أقصى ٣١ يومًا، ولا يتقاطع مع تفويض آخر.</p>
    <label>المفوَّض إليه<select name="to_id" required>${users.filter((u) => ['finance', 'ops'].includes(u.role))
      .map((u) => `<option value="${u.id}">${esc(u.name)} · ${ROLE[u.role]}</option>`).join('')}</select></label>
    <label>من<input name="starts_at" type="datetime-local" required value="${local(now)}"></label>
    <label>إلى<input name="ends_at" type="datetime-local" required value="${local(later)}"></label>
    <label>السبب<input name="reason" placeholder="إجازة، سفر عمل…"></label><button>إنشاء التفويض</button></form>` : ''}
    <h2>التفويضات</h2><div class="list">${list.map((d) => `<div class="item"><div class="row"><span class="t">${esc(d.from_name)} ← ${esc(d.to_name)}</span>
      ${d.revoked_at ? badge('cancelled', 'ملغى') : d.is_active ? badge('approved', 'ساري') : badge('pending', 'غير ساري')}</div>
      <div class="muted">${dateTime(d.starts_at)} — ${dateTime(d.ends_at)}${d.reason ? ' · ' + esc(d.reason) : ''}</div>
      ${!d.revoked_at && can('delegation:revoke') ? `<button class="link" data-revoke="${d.id}">إلغاء التفويض</button>` : ''}</div>`).join('') || '<p class="empty">لا توجد تفويضات</p>'}</div>`;
  $('#f')?.addEventListener('submit', act(async () => {
    const fd = Object.fromEntries(new FormData($('#f')));
    await api('/delegations', { method: 'POST', body: { to_id: Number(fd.to_id), starts_at: new Date(fd.starts_at).toISOString(),
      ends_at: new Date(fd.ends_at).toISOString(), ...(fd.reason ? { reason: fd.reason } : {}) } });
    toast('تم إنشاء التفويض'); render();
  }));
  view.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', act(async () => {
    if (!confirm('إلغاء هذا التفويض؟')) return;
    await api(`/delegations/${b.dataset.revoke}/revoke`, { method: 'POST' }); toast('تم الإلغاء'); render();
  })));
}

async function viewReports() {
  const [budgets, aging, risk] = await Promise.all([
    can('report:budget') ? api('/reports/budgets') : null, can('report:kpi') ? api('/reports/aging') : null,
    can('report:vendor_risk') ? api('/reports/vendor-risk') : null]);
  const band = { high: ['exception', 'مرتفع'], medium: ['pending', 'متوسط'], low: ['approved', 'منخفض'] };
  view.innerHTML = `<h1>التقارير</h1>
    ${budgets ? `<h2>الموازنات</h2>${budgets.map((b) => { const lvl = b.utilization >= 1 ? 'exceeded' : b.utilization >= 0.85 ? 'warning' : 'ok'; return `<div class="card">
      <div class="head"><strong>${esc(b.project)}</strong><span>${pct(b.utilization)}</span></div>
      <div class="muted">ملتزم ${sar(b.committed)} من ${sar(b.budget)} · معلّق ${sar(b.pending)} · مفوتر ${sar(b.invoiced)} · المتبقي ${sar(b.remaining)}</div>
      <div class="bar ${lvl}"><i data-w="${Math.min(100, Math.round((b.utilization || 0) * 100))}"></i></div></div>`; }).join('')}` : ''}
    ${aging ? `<h2>الطلبات المعلّقة (SLA ٤٨ ساعة)</h2><div class="card"><table><tr><th>الطلب</th><th>المرحلة</th><th>العمر</th></tr>
      ${aging.slice(0, 15).map((a) => `<tr><td><a href="#/requests/${esc(a.id)}">${esc(a.no)}</a></td><td>${esc(STAGE[a.stage] || '—')}</td>
      <td>${a.breached ? badge('exception', num(a.hours) + ' س') : num(a.hours) + ' س'}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">لا يوجد</td></tr>'}</table></div>` : ''}
    ${risk ? `<h2>مخاطر الموردين</h2><div class="card"><table><tr><th>المورد</th><th>الإنفاق</th><th>التركّز</th><th>المخاطر</th></tr>
      ${risk.map((v) => `<tr><td>${esc(v.vendor)}<div class="muted">${num(v.orders)} أمر · عرض وحيد ${pct(v.singleQuoteRate)}</div></td><td class="amt">${sar(v.spend)}</td>
      <td>${pct(v.concentration)}</td><td>${badge(...band[v.band])}</td></tr>`).join('')}</table></div>` : ''}
    <div class="actions">${can('report:export') ? '<button class="secondary" data-csv="requests">تصدير الطلبات CSV</button>' : ''}
    ${can('audit:read') ? '<button class="secondary" data-csv="audit">تصدير سجل التدقيق CSV</button><button class="secondary" id="ver">التحقق من سلامة السجل</button>' : ''}</div><div id="out"></div>`;
  view.querySelectorAll("[data-w]").forEach((i) => { i.style.width = i.dataset.w + "%"; });
  view.querySelectorAll('[data-csv]').forEach((b) => b.addEventListener('click', act(async () => {
    const res = await api(`/reports/export/${b.dataset.csv}.csv`, { raw: true });
    const url = URL.createObjectURL(await res.blob());
    Object.assign(document.createElement('a'), { href: url, download: `${b.dataset.csv}.csv` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  })));
  $('#ver')?.addEventListener('click', act(async () => {
    const v = await api('/audit/verify');
    $('#out').innerHTML = `<div class="card">${v.valid ? `✅ السلسلة سليمة — ${num(v.count)} سجل<div class="muted" dir="ltr">${esc(v.head.slice(0, 24))}…</div>`
      : `❌ السلسلة مكسورة عند السجل ${esc(v.brokenAt)} (${esc(v.reason)})`}</div>`;
  }));
}

async function viewAI() {
  const draw = () => {
    $('#chat').innerHTML = state.chat.map((m) => `<div class="msg ${m.role}">${esc(m.content)}</div>`).join('') ||
      '<p class="empty">اسأل عن الطلبات أو الإنفاق أو الموازنات أو الموردين.<br>مثال: ما الطلبات المشبوهة بالتجزئة هذا الشهر؟</p>';
  };
  view.innerHTML = `<h1>✦ المحلل الذكي</h1><p class="muted">يرى المحلل فقط ما تسمح به صلاحيات دورك (${ROLE[state.user.role]}).</p>
    <div id="chat" class="chat"></div><form id="f"><textarea name="q" rows="2" required placeholder="اكتب سؤالك…"></textarea><button>إرسال</button></form>`;
  draw();
  $('#f').addEventListener('submit', act(async () => {
    const q = $('#f').q.value.trim();
    if (!q) return;
    const history = state.chat.slice(-8);
    state.chat.push({ role: 'user', content: q });
    $('#f').q.value = '';
    draw();
    try {
      const r = await api('/ai/analyst', { method: 'POST', body: { question: q, history } });
      state.chat.push({ role: 'assistant', content: r.answer || '—' });
    } catch (e) {
      state.chat.pop();
      $('#f').q.value = q;
      throw e;
    } finally { draw(); }
  }));
}

// ---------------- Boot ----------------
(async () => {
  try { state.token = JSON.parse(sessionStorage.getItem('session') || '{}').token || null; } catch {}
  if (state.token) { try { await loadMe(); } catch { state.token = null; } }
  render();
})();
