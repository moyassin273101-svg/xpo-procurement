'use strict';
// LLM transport layer. Agents speak one internal (Messages-API-shaped) format; this module sends it to
//   - OpenRouter (OpenAI-compatible chat/completions + function calling) when OPENROUTER_API_KEY is set, else
//   - Anthropic directly (ANTHROPIC_API_KEY).
// Agent loops, tools and permissions are unaware of which provider is used.
const config = require('../config');
const { HttpError } = require('../errors');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;

let client = null;

// ---------- Internal -> OpenAI (OpenRouter) ----------
function toOpenAIContentPart(b) {
  if (b.type === 'text') return { type: 'text', text: b.text };
  if (b.type === 'image') return { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
  if (b.type === 'document')
    return { type: 'file', file: { filename: 'invoice.pdf', file_data: `data:${b.source.media_type};base64,${b.source.data}` } };
  throw new Error(`unsupported content block: ${b.type}`);
}

function toOpenAIMessages(system, messages) {
  const out = system ? [{ role: 'system', content: system }] : [];
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // user turn: tool results become role:"tool" messages; other blocks stay in one user message
    for (const b of m.content.filter((x) => x.type === 'tool_result'))
      out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? 'ERROR: ' : '') + String(b.content) });
    const parts = m.content.filter((x) => x.type !== 'tool_result').map(toOpenAIContentPart);
    if (parts.length) out.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
  }
  return out;
}

function toOpenAIRequest(req, model) {
  const body = { model, max_tokens: req.max_tokens, messages: toOpenAIMessages(req.system, req.messages) };
  if (req.tools?.length)
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  if (req.tool_choice?.type === 'tool') body.tool_choice = { type: 'function', function: { name: req.tool_choice.name } };
  return body;
}

// ---------- OpenAI (OpenRouter) -> Internal ----------
function fromOpenAIResponse(data) {
  const choice = data.choices?.[0];
  if (!choice?.message) throw new HttpError(502, 'رد غير متوقع من OpenRouter');
  const msg = choice.message;
  const content = [];
  if (typeof msg.content === 'string' && msg.content.trim()) content.push({ type: 'text', text: msg.content });
  for (const call of msg.tool_calls || []) {
    let input;
    try { input = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { input = { _invalid_arguments: call.function.arguments }; }
    content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
  }
  const hasTools = content.some((b) => b.type === 'tool_use');
  const stop_reason = hasTools ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
  return { content, stop_reason, model: data.model,
    usage: data.usage && { input_tokens: data.usage.prompt_tokens, output_tokens: data.usage.completion_tokens } };
}

function openRouterClient({ apiKey, model, fetchImpl = fetch }) {
  return {
    provider: 'openrouter',
    model,
    messages: {
      async create(req) {
        const body = JSON.stringify(toOpenAIRequest(req, model));
        for (let attempt = 0; ; attempt++) {
          let res;
          try {
            res = await fetchImpl(OPENROUTER_URL, {
              method: 'POST',
              headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'XPO Procurement' },
              body, signal: AbortSignal.timeout(TIMEOUT_MS),
            });
          } catch (e) {
            if (attempt < MAX_RETRIES) { await sleep(attempt); continue; }
            throw new HttpError(504, 'تعذّر الاتصال بـ OpenRouter');
          }
          if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) { await sleep(attempt); continue; }
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.error) {
            const detail = data.error?.message || `HTTP ${res.status}`;
            throw new HttpError(res.status === 401 || res.status === 403 ? 503 : 502, `خطأ من OpenRouter: ${detail}`);
          }
          return fromOpenAIResponse(data);
        }
      },
    },
  };
}
const sleep = (attempt) => new Promise((r) => setTimeout(r, 500 * 2 ** attempt));

function anthropicClient({ apiKey, model }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const sdk = new Anthropic({ apiKey, maxRetries: MAX_RETRIES, timeout: TIMEOUT_MS });
  return { provider: 'anthropic', model, messages: { create: (req) => sdk.messages.create({ ...req, model }) } };
}

/** Lazily-created provider client; OpenRouter wins when its key is set. Injectable for tests. */
function getClient() {
  if (client) return client;
  if (config.openrouterKey) {
    if (!config.openrouterModel) throw new HttpError(503, 'ميزات الذكاء الاصطناعي غير مفعّلة: OPENROUTER_MODEL غير مضبوط');
    client = openRouterClient({ apiKey: config.openrouterKey, model: config.openrouterModel });
  } else if (config.anthropicKey) {
    client = anthropicClient({ apiKey: config.anthropicKey, model: config.claudeModel });
  } else {
    throw new HttpError(503, 'ميزات الذكاء الاصطناعي غير مفعّلة: اضبط OPENROUTER_API_KEY أو ANTHROPIC_API_KEY');
  }
  return client;
}
const setClient = (c) => { client = c; };
/** "provider:model" label of the active client, for audit/extracted_by. */
const label = () => { const c = getClient(); return `${c.provider || 'custom'}:${c.model || 'unknown'}`; };

module.exports = { getClient, setClient, label, openRouterClient, toOpenAIRequest, fromOpenAIResponse, OPENROUTER_URL };
