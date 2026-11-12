'use strict';
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setClient } = require('../src/ai/client');
const analyst = require('../src/ai/analyst');

// Scripted fake of the Messages API to test the agent loop without network.
function fakeClient(script) {
  const calls = [];
  return { calls, messages: { create: async (req) => { calls.push(structuredClone(req)); return script.shift(); } } };
}
const db = { query: async () => ({ rows: [{ n: 0 }] }) };
const engineer = { id: 5, role: 'engineer', name: 'مهدي', project: 'النخيل' };

test('analyst runs allowed tools as the user and refuses tools outside the role', async () => {
  const fc = fakeClient([
    { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 't1', name: 'search_requests', input: { status: 'pending' } },
      { type: 'tool_use', id: 't2', name: 'audit_integrity', input: {} }, // not allowed for engineer
    ] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'لا توجد طلبات معلّقة.' }], usage: {} },
  ]);
  setClient(fc);
  const out = await analyst.ask(db, engineer, 'ما طلباتي المعلّقة؟');
  assert.equal(out.answer, 'لا توجد طلبات معلّقة.');
  assert.deepEqual(out.trace.map((t) => [t.tool, t.ok]), [['search_requests', true], ['audit_integrity', false]]);
  assert.deepEqual(fc.calls[0].tools.map((t) => t.name), ['search_requests']);
  assert.match(fc.calls[0].system, /10,000/);
  assert.equal(fc.calls[1].messages.at(-1).content[1].is_error, true);
});

test('analyst stops after max steps', async () => {
  const loop = () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'search_requests', input: {} }] });
  setClient(fakeClient(Array.from({ length: 10 }, loop)));
  const out = await analyst.ask(db, engineer, 'loop');
  assert.match(out.answer, /الحد الأقصى/);
});
