'use strict';
// Role -> permission matrix (route guards + AI tool gating). Roles follow src/xpo/engine.js.
// Stage-level approval rights are NOT here: XPO.canApprove decides those per request.
const ROLES = ['engineer', 'pm', 'cfo', 'ceo', 'finance', 'ops', 'procurement', 'supplier', 'admin'];

const P = {
  REQ_CREATE: 'request:create',
  REQ_READ: 'request:read',
  REQ_APPROVE: 'request:approve',
  REQ_OVERRIDE: 'request:override_grouping',
  REQ_DISPATCH: 'request:dispatch',
  DELEG_READ: 'delegation:read',
  DELEG_CREATE: 'delegation:create',
  DELEG_REVOKE: 'delegation:revoke',
  INV_CREATE: 'invoice:create',
  INV_READ: 'invoice:read',
  INV_POST: 'invoice:post',
  INV_REJECT: 'invoice:reject',
  REPORT_KPI: 'report:kpi',
  REPORT_BUDGET: 'report:budget',
  REPORT_VENDOR: 'report:vendor_risk',
  REPORT_EXPORT: 'report:export',
  AUDIT_READ: 'audit:read',
  USER_READ: 'user:read',
  SUPPLIER_ORDERS: 'supplier:orders',
  AI_ANALYST: 'ai:analyst',
  AI_INVOICE: 'ai:invoice',
};

const MATRIX = {
  engineer: [P.REQ_CREATE, P.REQ_READ, P.AI_ANALYST],
  pm: [P.REQ_READ, P.REQ_APPROVE, P.REPORT_KPI, P.REPORT_BUDGET, P.AI_ANALYST],
  cfo: [P.REQ_READ, P.REQ_APPROVE, P.REQ_OVERRIDE, P.DELEG_READ, P.DELEG_CREATE, P.DELEG_REVOKE, P.INV_CREATE, P.INV_READ,
    P.INV_POST, P.INV_REJECT, P.REPORT_KPI, P.REPORT_BUDGET, P.REPORT_VENDOR, P.REPORT_EXPORT, P.AUDIT_READ, P.USER_READ,
    P.AI_ANALYST, P.AI_INVOICE],
  ceo: [P.REQ_READ, P.REQ_APPROVE, P.DELEG_READ, P.DELEG_REVOKE, P.INV_READ, P.REPORT_KPI, P.REPORT_BUDGET, P.REPORT_VENDOR,
    P.REPORT_EXPORT, P.AUDIT_READ, P.USER_READ, P.AI_ANALYST],
  // finance/ops approve only as an active CFO delegate (engine-enforced)
  finance: [P.REQ_READ, P.REQ_APPROVE, P.REQ_OVERRIDE, P.DELEG_READ, P.INV_CREATE, P.INV_READ, P.INV_POST, P.INV_REJECT,
    P.REPORT_KPI, P.REPORT_BUDGET, P.REPORT_VENDOR, P.REPORT_EXPORT, P.AUDIT_READ, P.AI_ANALYST, P.AI_INVOICE],
  ops: [P.REQ_READ, P.REQ_APPROVE, P.REQ_OVERRIDE, P.DELEG_READ, P.INV_CREATE, P.INV_READ, P.REPORT_KPI, P.AI_ANALYST, P.AI_INVOICE],
  procurement: [P.REQ_READ, P.REQ_DISPATCH, P.INV_CREATE, P.INV_READ, P.INV_REJECT, P.REPORT_KPI, P.REPORT_VENDOR,
    P.REPORT_EXPORT, P.AI_ANALYST, P.AI_INVOICE],
  supplier: [P.SUPPLIER_ORDERS],
  admin: [P.REQ_READ, P.DELEG_READ, P.INV_READ, P.REPORT_KPI, P.REPORT_BUDGET, P.REPORT_VENDOR, P.REPORT_EXPORT,
    P.AUDIT_READ, P.USER_READ, P.AI_ANALYST],
};
const SETS = Object.fromEntries(Object.entries(MATRIX).map(([r, ps]) => [r, new Set(ps)]));

const can = (user, perm) => Boolean(user && SETS[user.role]?.has(perm));

module.exports = { ROLES, P, MATRIX, can };
