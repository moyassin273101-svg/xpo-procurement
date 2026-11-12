/* طبقة مؤسسية فوق محرك القواعد: الموازنات، الفواتير، المطابقة الثلاثية، أعمار الاعتماد، مؤشرات المخاطر، التصدير. دوال نقية. */
(function (root) {
  'use strict';
  const X = root.XPO || (typeof require !== 'undefined' && require('./engine.js'));
  const DAY = 86400000;
  const r2 = (x) => Math.round(x * 100) / 100;

  // موازنات سنوية افتراضية للمشاريع (قابلة للتعديل من الإعدادات)
  const DEFAULT_BUDGETS = { 'النخيل': 4200000, 'الواحة': 3500000, 'برج الياسمين': 4800000 };

  // تفاوت مقبول في المطابقة: 2% أو 500 ر.س أيهما أكبر على الإجمالي، وبند الكمية 1%
  const MATCH = { amountPct: 0.02, amountAbs: 500, qtyPct: 0.01, dupDays: 30 };

  /* ----- الموازنة والالتزامات ----- */
  function budgetView(st, project){
    const budget = (st.budgets || DEFAULT_BUDGETS)[project] || 0;
    const reqs = st.requests.filter((r) => r.project === project);
    const committed = reqs.filter((r) => r.status === 'approved').reduce((s, r) => s + r.total, 0);
    const pending = reqs.filter((r) => r.status === 'pending').reduce((s, r) => s + r.total, 0);
    const invoiced = (st.invoices || []).filter((v) => v.project === project && v.status === 'posted').reduce((s, v) => s + v.amount, 0);
    return { project, budget, committed: r2(committed), pending: r2(pending), invoiced: r2(invoiced),
      remaining: r2(budget - committed), utilization: budget ? committed / budget : 0, atRisk: r2(committed + pending) };
  }
  function allBudgets(st){ return Object.keys(st.budgets || DEFAULT_BUDGETS).map((p) => budgetView(st, p)); }

  /* ----- أعمار الطلبات المعلّقة (SLA) ----- */
  const SLA_HOURS = 48;
  function aging(st, nowTs){
    return st.requests.filter((r) => r.status === 'pending').map((r) => {
      const last = r.approvals.length ? r.approvals[r.approvals.length - 1].at : r.createdAt;
      const hrs = (nowTs - last) / 3600000;
      return { no: r.no, id: r.id, stage: X.nextStage(r), total: r.total, hours: Math.round(hrs), breached: hrs > SLA_HOURS, since: last };
    }).sort((a, b) => b.hours - a.hours);
  }

  /* ----- مؤشر مخاطر المورد ----- */
  function vendorRisk(st){
    const m = {};
    const approved = st.requests.filter((r) => r.status === 'approved');
    const total = approved.reduce((s, r) => s + r.total, 0) || 1;
    approved.forEach((r) => {
      const k = X.vendorKey(r.vendor);
      (m[k] = m[k] || { vendor: r.vendor, spend: 0, orders: 0, singleQuote: 0, invoices: 0, disputes: 0 });
      m[k].spend += r.total; m[k].orders++;
      if (/عرض سعر واحد|المورد الوحيد/.test(r.notes || '')) m[k].singleQuote++;
    });
    (st.invoices || []).forEach((v) => { const k = X.vendorKey(v.vendor); if (m[k]) { m[k].invoices++; if ((v.flags || []).length) m[k].disputes++; } });
    return Object.values(m).map((v) => {
      const concentration = v.spend / total;
      let score = 0;
      if (concentration > 0.25) score += 2; else if (concentration > 0.15) score += 1;
      if (v.orders && v.singleQuote / v.orders > 0.3) score += 2;
      if (v.invoices && v.disputes / v.invoices > 0.25) score += 2;
      if (v.orders >= 8) score += 1;
      return { vendor: v.vendor, spend: r2(v.spend), orders: v.orders, concentration, singleQuoteRate: v.orders ? v.singleQuote / v.orders : 0,
        disputeRate: v.invoices ? v.disputes / v.invoices : 0, score, band: score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low' };
    }).sort((a, b) => b.score - a.score || b.spend - a.spend);
  }

  /* ----- الفواتير والمطابقة الثلاثية ----- */
  // تطابق: الفاتورة ↔ أمر الشراء المعتمد ↔ عرض السعر. تُرجع النتائج والملاحظات، ولا تعتمد شيئًا.
  function matchInvoice(st, inv, nowTs){
    const flags = [];
    const po = st.requests.find((r) => r.no === inv.poNo);
    if (!po) { flags.push({ sev: 'c', code: 'no_po', text: 'لا يوجد أمر شراء بهذا الرقم' }); return { flags, po: null }; }
    if (po.status !== 'approved') flags.push({ sev: 'c', code: 'po_not_approved', text: 'أمر الشراء غير مكتمل الاعتماد (البند 5: لا صرف قبل الاعتماد)' });
    if (X.vendorKey(po.vendor) !== X.vendorKey(inv.vendor)) flags.push({ sev: 'h', code: 'vendor_mismatch', text: 'المورد في الفاتورة يختلف عن أمر الشراء: ' + inv.vendor + ' ≠ ' + po.vendor });
    // المبلغ
    const tol = Math.max(MATCH.amountAbs, po.total * MATCH.amountPct);
    const diff = r2(inv.amount - po.total);
    if (Math.abs(diff) > tol) flags.push({ sev: diff > 0 ? 'c' : 'm', code: 'amount_over', text: (diff > 0 ? 'الفاتورة تزيد عن أمر الشراء بـ ' : 'الفاتورة تقل عن أمر الشراء بـ ') + fmtNum(Math.abs(diff)) + ' ر.س (المسموح ' + fmtNum(r2(tol)) + ')' });
    else if (Math.abs(diff) > 0.009) flags.push({ sev: 'ok', code: 'amount_ok', text: 'فرق المبلغ ' + fmtNum(Math.abs(diff)) + ' ر.س ضمن التفاوت المسموح' });
    // الكمية
    if (inv.qty != null && po.qty && Math.abs(inv.qty - po.qty) > po.qty * MATCH.qtyPct)
      flags.push({ sev: 'h', code: 'qty_mismatch', text: 'الكمية في الفاتورة ' + fmtNum(inv.qty) + ' تخالف أمر الشراء ' + fmtNum(po.qty) });
    // الضريبة
    if (inv.vat != null && inv.subtotal != null) {
      const expected = r2(inv.subtotal * 0.15);
      if (Math.abs(inv.vat - expected) > 1) flags.push({ sev: 'm', code: 'vat', text: 'الضريبة ' + fmtNum(inv.vat) + ' لا تساوي 15% من الصافي (' + fmtNum(expected) + ')' });
    }
    // الرقم الضريبي
    if (inv.vatNo && !/^3\d{14}$/.test(String(inv.vatNo).replace(/\s/g, '')))
      flags.push({ sev: 'm', code: 'vatno', text: 'الرقم الضريبي للمورد غير مكتمل (يجب 15 رقمًا يبدأ بـ3)' });
    // تكرار الفاتورة
    const dup = (st.invoices || []).find((v) => v.id !== inv.id && X.vendorKey(v.vendor) === X.vendorKey(inv.vendor) && v.invoiceNo && inv.invoiceNo && String(v.invoiceNo).trim() === String(inv.invoiceNo).trim());
    if (dup) flags.push({ sev: 'c', code: 'dup_invoice', text: 'رقم الفاتورة مستخدم من قبل في ' + dup.id });
    // فاتورة على أمر مرفوض/ملغى
    if (['rejected', 'cancelled'].includes(po.status)) flags.push({ sev: 'c', code: 'po_dead', text: 'أمر الشراء ' + (po.status === 'rejected' ? 'مرفوض' : 'ملغى') });
    return { flags, po, diff };
  }
  function matchVerdict(flags){
    if (flags.some((f) => f.sev === 'c')) return { k: 'blocked', ar: 'موقوفة — تحتاج تصحيحًا' };
    if (flags.some((f) => f.sev === 'h' || f.sev === 'm')) return { k: 'review', ar: 'للمراجعة' };
    return { k: 'clean', ar: 'مطابقة' };
  }

  function addInvoice(st, actor, inv, nowTs){
    if (!actor || !['procurement', 'cfo', 'finance', 'ops'].includes(actor.role)) return { ok: false, error: 'إدخال الفواتير للمشتريات والمالية' };
    if (!inv.poNo) return { ok: false, error: 'اربط الفاتورة بأمر شراء' };
    if (!(inv.amount > 0)) return { ok: false, error: 'مبلغ الفاتورة غير صحيح' };
    st.invSeq = (st.invSeq || 0) + 1;
    const id = 'INV-' + String(st.invSeq).padStart(4, '0');
    const po = st.requests.find((r) => r.no === inv.poNo);
    const rec = { id, poNo: inv.poNo, project: po ? po.project : inv.project || '', vendor: inv.vendor || (po ? po.vendor : ''),
      invoiceNo: inv.invoiceNo || '', vatNo: inv.vatNo || '', subtotal: inv.subtotal != null ? r2(inv.subtotal) : null,
      vat: inv.vat != null ? r2(inv.vat) : null, amount: r2(inv.amount), qty: inv.qty != null ? inv.qty : null,
      date: inv.date || null, source: inv.source || 'manual', extractedBy: inv.extractedBy || null, raw: inv.raw || '',
      status: 'review', createdAt: nowTs, createdBy: actor.id, postedAt: null, postedBy: null };
    const m = matchInvoice(st, rec, nowTs);
    rec.flags = m.flags; rec.verdict = matchVerdict(m.flags).k;
    if (!st.invoices) st.invoices = [];
    st.invoices.unshift(rec);
    X.log(st, actor, 'invoice_add', id, rec.poNo + ' · ' + fmtNum(rec.amount) + ' ر.س · ' + matchVerdict(m.flags).ar, nowTs);
    return { ok: true, inv: rec, match: m };
  }
  function postInvoice(st, actor, id, nowTs, opts){
    opts = opts || {};
    const v = (st.invoices || []).find((x) => x.id === id);
    if (!v) return { ok: false, error: 'الفاتورة غير موجودة' };
    if (!['cfo', 'finance'].includes(actor.role)) return { ok: false, error: 'ترحيل الفواتير للمالية' };
    if (v.status === 'posted') return { ok: false, error: 'الفاتورة مرحّلة' };
    const blocked = (v.flags || []).some((f) => f.sev === 'c');
    if (blocked && !opts.override) return { ok: false, error: 'لا يمكن الترحيل مع ملاحظات حرجة دون تجاوز مبرَّر' };
    if (blocked && !String(opts.reason || '').trim()) return { ok: false, error: 'اكتب سبب التجاوز' };
    v.status = 'posted'; v.postedAt = nowTs; v.postedBy = actor.id; if (blocked) v.override = { by: actor.id, reason: opts.reason, at: nowTs };
    X.log(st, actor, 'invoice_post', id, blocked ? 'تجاوز: ' + opts.reason : 'مطابقة', nowTs);
    return { ok: true };
  }
  function rejectInvoice(st, actor, id, reason, nowTs){
    const v = (st.invoices || []).find((x) => x.id === id);
    if (!v) return { ok: false, error: 'الفاتورة غير موجودة' };
    if (!['cfo', 'finance', 'procurement'].includes(actor.role)) return { ok: false, error: 'لا صلاحية' };
    if (!String(reason || '').trim()) return { ok: false, error: 'اكتب سبب الإعادة' };
    v.status = 'rejected'; v.rejectReason = reason; v.rejectedBy = actor.id;
    X.log(st, actor, 'invoice_reject', id, reason, nowTs);
    return { ok: true };
  }

  /* ----- التصدير ----- */
  function fmtNum(n){ n = Number(n) || 0; return n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }); }
  function csvCell(v){ v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function exportRequestsCsv(st){
    const head = ['رقم الطلب', 'التاريخ', 'المشروع', 'الصنف', 'الكمية', 'الإجمالي', 'المورد', 'الحالة', 'المعتمدون', 'ملاحظات تدقيق'];
    const rows = st.requests.map((r) => {
      const appr = r.approvals.length ? r.approvals.map((a) => a.decision + ':' + (X.userById(st, a.userId) || {}).name + (a.onBehalfOf ? '(ن.ع ' + (X.userById(st, a.onBehalfOf) || {}).name + ')' : '')).join(' | ') : (r.legacyChain || '');
      return [r.no, new Date(r.createdAt).toLocaleDateString('en-GB'), r.project, r.item, r.qty, r.total, r.vendor, r.status, appr, (r.flags || []).join(';')];
    });
    return '\ufeff' + [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
  }
  function exportAuditCsv(st){
    const head = ['#', 'الوقت', 'المنفّذ', 'الإجراء', 'المرجع', 'التفاصيل', 'البصمة'];
    const rows = st.audit.map((e) => [e.i, new Date(e.at).toISOString(), (X.userById(st, e.actor) || {}).name || '—', e.action, e.ref, e.detail, e.hash]);
    return '\ufeff' + [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
  }

  /* ----- مؤشرات لوحة الإدارة ----- */
  function kpis(st, nowTs){
    const approved = st.requests.filter((r) => r.status === 'approved');
    const pending = st.requests.filter((r) => r.status === 'pending');
    const ag = aging(st, nowTs);
    const invs = st.invoices || [];
    return {
      totalApproved: r2(approved.reduce((s, r) => s + r.total, 0)),
      pendingCount: pending.length, pendingValue: r2(pending.reduce((s, r) => s + r.total, 0)),
      breaches: ag.filter((a) => a.breached).length,
      flagged: st.requests.filter((r) => (r.flags || []).some((f) => ['missing_cfo', 'missing_ceo', 'split', 'dup', 'after_reject'].includes(f))).length,
      invoicesReview: invs.filter((v) => v.status === 'review').length,
      invoicesBlocked: invs.filter((v) => v.verdict === 'blocked' && v.status === 'review').length,
      invoicesPosted: invs.filter((v) => v.status === 'posted').length,
    };
  }

  const API = { DEFAULT_BUDGETS, MATCH, SLA_HOURS, budgetView, allBudgets, aging, vendorRisk, matchInvoice, matchVerdict,
    addInvoice, postInvoice, rejectInvoice, exportRequestsCsv, exportAuditCsv, kpis, fmtNum };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.XENT = API;
})(typeof window !== 'undefined' ? window : globalThis);
