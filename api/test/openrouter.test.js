'use strict';
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const client = require('../src/ai/client');
const analyst = require('../src/ai/analyst');

const { toOpenAIRequest, fromOpenAIResponse, openRouterClient, OPENROUTER_URL } = client;

test('request conversion: system, tools, tool_choice, assistant tool_calls, tool results', () => {
  const body = toOpenAIRequest({
    max_tokens: 100, system: 'SYS',
    tools: [{ name: 'search_requests', description: 'd', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
    tool_choice: { type: 'tool', name: 'search_requests' },
    messages: [
      { role: 'user', content: 'سؤال' },
      { role: 'assistant', content: [{ type: 'text', text: 'سأبحث' }, { type: 'tool_use', id: 'c1', name: 'search_requests', input: { q: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"total":0}' },
        { type: 'tool_result', tool_use_id: 'c2', content: 'denied', is_error: true }] },
    ],
  }, 'vendor/model-x');
  assert.equal(body.model, 'vendor/model-x');
  assert.deepEqual(body.messages[0], { role: 'system', content: 'SYS' });
  assert.deepEqual(body.messages[1], { role: 'user', content: 'سؤال' });
  assert.deepEqual(body.messages[2].tool_calls, [{ id: 'c1', type: 'function', function: { name: 'search_requests', arguments: '{"q":"x"}' } }]);
  assert.equal(body.messages[2].content, 'سأبحث');
  assert.deepEqual(body.messages.slice(3), [
    { role: 'tool', tool_call_id: 'c1', content: '{"total":0}' }, { role: 'tool', tool_call_id: 'c2', content: 'ERROR: denied' }]);
  assert.deepEqual(body.tools[0], { type: 'function', function: { name: 'search_requests', description: 'd',
    parameters: { type: 'object', properties: { q: { type: 'string' } } } } });
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'search_requests' } });
});

test('request conversion: PDF and image invoice documents', () => {
  const b = toOpenAIRequest({ max_tokens: 1, messages: [{ role: 'user', content: [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'WFla' } },
    { type: 'text', text: 'Extract this invoice.' }] }] }, 'm');
  assert.deepEqual(b.messages[0].content, [
    { type: 'file', file: { filename: 'invoice.pdf', file_data: 'data:application/pdf;base64,QUJD' } },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,WFla' } },
    { type: 'text', text: 'Extract this invoice.' }]);
});

test('response conversion: tool_calls, plain text, truncation, malformed arguments', () => {
  const r = fromOpenAIResponse({ model: 'm', usage: { prompt_tokens: 3, completion_tokens: 4 }, choices: [{ finish_reason: 'tool_calls',
    message: { content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 't', arguments: '{"x":1}' } },
      { id: 'b', type: 'function', function: { name: 'u', arguments: '{bad' } }] } }] });
  assert.equal(r.stop_reason, 'tool_use');
  assert.deepEqual(r.content, [{ type: 'tool_use', id: 'a', name: 't', input: { x: 1 } },
    { type: 'tool_use', id: 'b', name: 'u', input: { _invalid_arguments: '{bad' } }]);
  assert.deepEqual(r.usage, { input_tokens: 3, output_tokens: 4 });
  const t = fromOpenAIResponse({ choices: [{ finish_reason: 'stop', message: { content: 'جواب' } }] });
  assert.deepEqual([t.stop_reason, t.content], ['end_turn', [{ type: 'text', text: 'جواب' }]]);
  assert.equal(fromOpenAIResponse({ choices: [{ finish_reason: 'length', message: { content: 'x' } }] }).stop_reason, 'max_tokens');
  assert.throws(() => fromOpenAIResponse({ choices: [] }), /OpenRouter/);
});

const reply = (status, body) => ({ status, ok: status < 400, json: async () => body });

test('OpenRouter transport: endpoint, auth header, retry on 429, auth errors surface as 503', async () => {
  const calls = [];
  const queue = [reply(429, {}), reply(200, { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] })];
  const c = openRouterClient({ apiKey: 'sk-or-test', model: 'm/x', fetchImpl: async (url, init) => { calls.push({ url, init }); return queue.shift(); } });
  const r = await c.messages.create({ max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.content[0].text, 'ok');
  assert.equal(calls.length, 2, 'retried once');
  assert.equal(calls[0].url, OPENROUTER_URL);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-or-test');
  assert.equal(JSON.parse(calls[0].init.body).model, 'm/x');

  const bad = openRouterClient({ apiKey: 'k', model: 'm', fetchImpl: async () => reply(401, { error: { message: 'No auth' } }) });
  await assert.rejects(bad.messages.create({ max_tokens: 1, messages: [] }), (e) => e.status === 503 && /No auth/.test(e.message));
});

test('analyst loop over OpenRouter: allowed tool runs, disallowed tool refused, final answer returned', async () => {
  const sent = [];
  const queue = [
    reply(200, { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'search_requests', arguments: '{"status":"pending"}' } },
      { id: 'c2', type: 'function', function: { name: 'audit_integrity', arguments: '{}' } }] } }] }),
    reply(200, { choices: [{ finish_reason: 'stop', message: { content: 'لا توجد طلبات معلّقة.' } }] }),
  ];
  client.setClient(openRouterClient({ apiKey: 'k', model: 'm', fetchImpl: async (_u, init) => { sent.push(JSON.parse(init.body)); return queue.shift(); } }));
  const db = { query: async () => ({ rows: [{ n: 0 }] }) };
  const out = await analyst.ask(db, { id: 5, role: 'engineer', name: 'مهدي', project: 'النخيل' }, 'ما المعلّق؟');
  assert.equal(out.answer, 'لا توجد طلبات معلّقة.');
  assert.deepEqual(out.trace.map((t) => [t.tool, t.ok]), [['search_requests', true], ['audit_integrity', false]]);
  assert.deepEqual(sent[0].tools.map((t) => t.function.name), ['search_requests'], 'role-gated tool list');
  const toolMsgs = sent[1].messages.filter((m) => m.role === 'tool');
  assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), ['c1', 'c2']);
  assert.match(toolMsgs[1].content, /^ERROR: /);
  client.setClient(null);
});

test('provider selection: OpenRouter when its key is set (model required), else Anthropic, else 503', () => {
  const saved = { ...config };
  try {
    Object.assign(config, { openrouterKey: 'k', openrouterModel: '', anthropicKey: 'a' });
    client.setClient(null);
    assert.throws(() => client.getClient(), /OPENROUTER_MODEL/);
    Object.assign(config, { openrouterModel: 'vendor/m' });
    client.setClient(null);
    assert.equal(client.label(), 'openrouter:vendor/m');
    Object.assign(config, { openrouterKey: '', claudeModel: 'claude-x' });
    client.setClient(null);
    assert.equal(client.label(), 'anthropic:claude-x');
    Object.assign(config, { anthropicKey: '' });
    client.setClient(null);
    assert.throws(() => client.getClient(), (e) => e.status === 503);
  } finally {
    Object.assign(config, saved);
    client.setClient(null);
  }
});
