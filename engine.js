/* محرك قواعد طلبات الشراء — شركة إكس. دوال نقية تعمل في المتصفح وفي Node. */
(function (root) {
  'use strict';
  const DAY = 86400000;
  const CFG = { T_CFO: 10000, T_CEO: 50000, GROUP_DAYS: 3, DUP_DAYS: 7, MAX_DELEG_DAYS: 31, VAT: 0.15 };
  const STAGES = ['pm', 'cfo', 'ceo'];
  const STAGE_AR = { pm: 'مدير المشروع', cfo: 'المدير المالي', ceo: 'الرئيس التنفيذي' };
  const r2 = (x) => Math.round(x * 100) / 100;

  // ≥ 50,000 تشمل الرئيس التنفيذي (جدول الصلاحيات: «50,000 فأكثر»)
  const tierOf = (t) => (t >= CFG.T_CEO ? 3 : t >= CFG.T_CFO ? 2 : 1);
  const stagesFor = (tier) => STAGES.slice(0, tier);

  const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
  function parseAmount(v, strict) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    let s = String(v == null ? '' : v)
      .replace(/[٠-٩]/g, (d) => AR_DIGITS.indexOf(d))
      .replace(/٫/g, '.')
      .replace(/[٬,،\s]/g, '')
      .replace(/ر\.?س|ريال|SAR/gi, '');
    let m = 1;
    if (!strict && /(ألف|k)$/i.test(s)) { m = 1000; s = s.replace(/(ألف|k)$/i, ''); }
    if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
    return parseFloat(s) * m;
  }

  const SYN = [[/بلوك/g, 'بلك'], [/بورسلين/g, 'بورسلان'], [/سراميك/g, 'سيراميك'], [/ملم/g, 'مم'], [/[xX*]/g, '×']];
  function itemKey(s) {
    let t = String(s || '').replace(/[٠-٩]/g, (d) => AR_DIGITS.indexOf(d)).replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ـ/g, '');
    SYN.forEach(([a, b]) => { t = t.replace(a, b); });
    return t.replace(/\(.*?\)/g, '').replace(/ - .*$/, '').replace(/[\s\-_.]/g, '');
  }
  const vendorKey = (s) => String(s || '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/\s+/g, '');
  const days = (a, b) => Math.abs(a - b) / DAY;
  const isLive = (r) => r.status !== 'rejected' && r.status !== 'cancelled';
  const userById = (st, id) => st.users.find((u) => u.id === id);

  /* ---------- سجل التدقيق المتسلسل ---------- */
  function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }
  const entryHash = (e) => hash(e.prev + JSON.stringify([e.i, e.at, e.actor, e.action, e.ref, e.detail]));
  function log(st, actor, action, ref, detail, now) {
    const prev = st.audit.length ? st.audit[st.audit.length - 1].hash : '0';
    const e = { i: st.audit.length + 1, at: now, actor: actor ? actor.id : null, action, ref: ref || '', detail: detail || '', prev };
    e.hash = entryHash(e);
    st.audit.push(e);
  }
  function verifyChain(st) {
    let prev = '0';
    for (const e of st.audit) {
      if (e.prev !== prev || entryHash(e) !== e.hash) return { ok: false, at: e.i };
      prev = e.hash;
    }
    return { ok: true, count: st.audit.length };
  }

  /* ---------- التقييم عند تقديم الطلب ---------- */
  function totalOf(amount, vatIncluded) { return r2(vatIncluded ? amount : amount * (1 + CFG.VAT)); }

  function assess(st, d, now) {
    const own = tierOf(d.total);
    const related = st.requests.filter((r) =>
      r.id !== d.id && isLive(r) && r.project === d.project && vendorKey(r.vendor) === vendorKey(d.vendor) &&
      r.requesterId === d.requesterId && days(r.createdAt, now) <= CFG.GROUP_DAYS);
    const combined = r2(d.total + related.reduce((s, r) => s + r.total, 0));
    const tier = Math.max(own, tierOf(combined));
    const dups = st.requests.filter((r) =>
      isLive(r) && r.requesterId === d.requesterId && itemKey(r.item) === itemKey(d.item) &&
      days(r.createdAt, now) <= CFG.DUP_DAYS && Math.abs(r.total - d.total) <= 0.005 * Math.max(r.total, d.total));
    return { ownTier: own, combinedTotal: combined, tier, escalated: tier > own, related, dups, stages: stagesFor(tier) };
  }

  function submit(st, actor, d, now, opts) {
    opts = opts || {};
    const err = (m, extra) => Object.assign({ ok: false, error: m }, extra || {});
    if (!actor || actor.role !== 'engineer') return err('تقديم الطلبات لمهندسي المواقع فقط');
    if (d.project !== actor.project) return err('لا يمكنك تقديم طلب لمشروع غير مشروعك');
    if (!String(d.item || '').trim()) return err('اكتب الصنف');
    if (!st.vendors.includes(d.vendor)) return err('اختر المورد من القائمة');
    if (!(d.qty > 0)) return err('الكمية غير صحيحة');
    if (!(d.amount > 0) || !isFinite(d.amount)) return err('المبلغ غير صحيح');
    if (!String(d.quoteRef || '').trim()) return err('أرفق عرض السعر؛ لا يُقدَّم طلب بلا عرض');
    const draft = { id: 'new', requesterId: actor.id, project: d.project, vendor: d.vendor, item: String(d.item).trim(), total: totalOf(d.amount, d.vatIncluded) };
    const a = assess(st, draft, now);
    if (a.dups.length && !opts.confirmDup) return err('dup', { dups: a.dups });
    st.seq += 1;
    const no = 'PR-2026-' + String(st.seq).padStart(4, '0');
    const req = {
      id: no, no, createdAt: now, requesterId: actor.id, project: d.project, item: draft.item, qty: d.qty,
      amount: d.amount, vatIncluded: !!d.vatIncluded, total: draft.total, vendor: d.vendor, quoteRef: d.quoteRef,
      quotesCount: d.quotesCount || 1, notes: d.notes || '', status: 'pending', stages: a.stages, approvals: [],
      grouping: a.escalated ? { combinedTotal: a.combinedTotal, relatedNos: a.related.map((r) => r.no), overridden: null } : null,
      dupConfirmed: a.dups.length ? a.dups.map((r) => r.no) : null,
    };
    st.requests.unshift(req);
    log(st, actor, 'submit', no, 'إجمالي ' + req.total + ' — مراحل: ' + req.stages.join('>') + (a.escalated ? ' — تصعيد لتجميع احتياج' : ''), now);
    return { ok: true, req, assess: a };
  }

  /* ---------- الاعتماد والتفويض ---------- */
  const nextStage = (r) => r.stages.find((s) => !r.approvals.some((a) => a.stage === s && a.decision === 'approved'));
  const activeDelegations = (st, now) => st.delegations.filter((d) => !d.revokedAt && d.start <= now && now <= d.end);

  function canApprove(st, user, req, now) {
    const no = (m) => ({ ok: false, reason: m });
    if (!user) return no('سجّل الدخول');
    if (req.status !== 'pending') return no('الطلب ليس قيد الاعتماد');
    const stage = nextStage(req);
    if (!stage) return no('لا توجد مرحلة معلّقة');
    if (user.id === req.requesterId) return no('لا يعتمد أحد طلبًا قدّمه بنفسه');
    if (req.approvals.some((a) => a.userId === user.id && a.decision === 'approved')) return no('لا يجوز لشخص واحد اعتماد مرحلتين');
    if (stage === 'pm') return user.role === 'pm' && user.project === req.project ? { ok: true, stage } : no('بانتظار مدير المشروع');
    if (stage === 'ceo') return user.role === 'ceo' ? { ok: true, stage } : no('بانتظار الرئيس التنفيذي');
    if (user.role === 'cfo') return { ok: true, stage };
    const del = activeDelegations(st, now).find((d) => d.toId === user.id && (userById(st, d.fromId) || {}).role === 'cfo');
    if (del) {
      if (req.approvals.some((a) => a.onBehalfOf === del.fromId)) return no('اعتُمد من المدير المالي بالفعل');
      return { ok: true, stage, onBehalfOf: del.fromId, delegation: del };
    }
    return no('بانتظار المدير المالي أو مفوَّضه');
  }

  function decide(st, user, reqId, decision, comment, now) {
    const req = st.requests.find((r) => r.id === reqId);
    if (!req) return { ok: false, error: 'الطلب غير موجود' };
    const c = canApprove(st, user, req, now);
    if (!c.ok) return { ok: false, error: c.reason };
    if (decision === 'rejected' && !String(comment || '').trim()) return { ok: false, error: 'اكتب سبب الرفض' };
    req.approvals.push({ stage: c.stage, userId: user.id, onBehalfOf: c.onBehalfOf || null, delegationId: c.delegation ? c.delegation.id : null, decision, comment: comment || '', at: now });
    if (decision === 'rejected') req.status = 'rejected';
    else if (!nextStage(req)) req.status = 'approved';
    log(st, user, decision === 'approved' ? 'approve' : 'reject', req.no,
      c.stage + (c.onBehalfOf ? ' نيابةً عن ' + userById(st, c.onBehalfOf).name : '') + (comment ? ' — ' + comment : ''), now);
    return { ok: true, req };
  }

  function cancel(st, user, reqId, reason, now) {
    const req = st.requests.find((r) => r.id === reqId);
    if (!req || req.status !== 'pending') return { ok: false, error: 'لا يمكن إلغاء هذا الطلب' };
    if (req.requesterId !== user.id) return { ok: false, error: 'الإلغاء لصاحب الطلب فقط' };
    req.status = 'cancelled';
    log(st, user, 'cancel', req.no, reason || '', now);
    return { ok: true };
  }

  // فصل طلب عن التجميع التلقائي: للمدير المالي أو مفوَّضه الساري فقط، بسبب مكتوب
  function overrideGrouping(st, user, reqId, reason, now) {
    const req = st.requests.find((r) => r.id === reqId);
    if (!req || !req.grouping || req.status !== 'pending') return { ok: false, error: 'لا يوجد تجميع قابل للفصل' };
    const isCfo = user.role === 'cfo' || activeDelegations(st, now).some((d) => d.toId === user.id);
    if (!isCfo) return { ok: false, error: 'الفصل للمدير المالي أو مفوَّضه' };
    if (!String(reason || '').trim()) return { ok: false, error: 'اكتب سبب اعتباره احتياجًا منفصلًا' };
    req.stages = stagesFor(tierOf(req.total));
    req.grouping.overridden = { by: user.id, at: now, reason };
    log(st, user, 'override_grouping', req.no, reason, now);
    return { ok: true };
  }

  function createDelegation(st, actor, p, now) {
    const err = (m) => ({ ok: false, error: m });
    if (!actor || actor.role !== 'cfo') return err('التفويض يصدر من المدير المالي نفسه');
    const to = userById(st, p.toId);
    if (!to || to.id === actor.id) return err('اختر مفوَّضًا آخر');
    if (!['finance', 'ops'].includes(to.role)) return err('التفويض لموظف من الإدارة المالية أو العمليات فقط');
    if (!(p.start < p.end)) return err('تاريخ النهاية يجب أن يلي البداية');
    if (p.end <= now) return err('تاريخ النهاية في الماضي');
    if (p.end - p.start > CFG.MAX_DELEG_DAYS * DAY) return err('أقصى مدة تفويض ' + CFG.MAX_DELEG_DAYS + ' يومًا');
    if (st.delegations.some((d) => !d.revokedAt && d.fromId === actor.id && d.end > now && p.start < d.end && p.end > d.start)) return err('يوجد تفويض آخر يتقاطع مع هذه الفترة');
    st.dseq = (st.dseq || 0) + 1;
    const d = { id: 'D' + st.dseq, fromId: actor.id, toId: to.id, start: p.start, end: p.end, reason: p.reason || '', createdAt: now, revokedAt: null };
    st.delegations.push(d);
    st.notices.unshift({ at: now, text: 'تفويض: ' + to.name + ' ينوب عن ' + actor.name + ' في الاعتماد المالي من ' + new Date(p.start).toLocaleDateString('en-GB') + ' إلى ' + new Date(p.end).toLocaleDateString('en-GB') });
    log(st, actor, 'delegate', d.id, to.name, now);
    return { ok: true, d };
  }
  function revokeDelegation(st, actor, id, now) {
    const d = st.delegations.find((x) => x.id === id);
    if (!d || d.revokedAt) return { ok: false, error: 'التفويض غير موجود' };
    if (!['cfo', 'ceo'].includes(actor.role)) return { ok: false, error: 'الإلغاء للمدير المالي أو الرئيس التنفيذي' };
    d.revokedAt = now;
    st.notices.unshift({ at: now, text: 'أُلغي التفويض ' + id });
    log(st, actor, 'revoke_delegation', id, '', now);
    return { ok: true };
  }

  // البند 5 من الجدول: لا تعاقد قبل اكتمال الاعتماد
  function dispatchToVendor(st, user, reqId, now) {
    const req = st.requests.find((r) => r.id === reqId);
    if (!req) return { ok: false, error: 'الطلب غير موجود' };
    if (user.role !== 'procurement') return { ok: false, error: 'الإرسال للمورد من المشتريات' };
    if (req.status !== 'approved') return { ok: false, error: 'لا تعاقد قبل اكتمال الاعتماد' };
    req.dispatchedAt = now;
    log(st, user, 'dispatch', req.no, req.vendor, now);
    return { ok: true };
  }

  /* ---------- نطاق الرؤية ---------- */
  function visible(st, user) {
    const R = st.requests;
    switch (user.role) {
      case 'engineer': return R.filter((r) => r.requesterId === user.id);
      case 'pm': return R.filter((r) => r.project === user.project);
      case 'supplier':
        return R.filter((r) => r.status === 'approved' && r.vendor === user.vendor && r.dispatchedAt)
          .map((r) => ({ no: r.no, item: r.item, qty: r.qty, project: r.project, dispatchedAt: r.dispatchedAt }));
      default: return R;
    }
  }

  /* ---------- إعادة فحص السجل القديم بنفس القواعد ---------- */
  function recheckLegacy(l) {
    const tier = tierOf(l.amt);
    const miss = [];
    if (l.st === 'approved') {
      if (tier >= 2 && !l.roles.includes('cfo')) miss.push('cfo');
      if (tier >= 3 && !l.roles.includes('ceo')) miss.push('ceo');
    }
    return miss;
  }

  const API = { CFG, DAY, STAGES, STAGE_AR, tierOf, stagesFor, parseAmount, itemKey, vendorKey, totalOf, assess, submit, nextStage,
    activeDelegations, canApprove, decide, cancel, overrideGrouping, createDelegation, revokeDelegation, dispatchToVendor, visible,
    log, verifyChain, recheckLegacy, userById, isLive, r2 };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.XPO = API;
})(typeof window !== 'undefined' ? window : globalThis);
