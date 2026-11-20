// Cloudflare Worker entry for the shared translation core.
//
// Everything that is genuinely portable — language detection, cue/unit
// splitting, Cookie normalisation, the Doubao request itself — comes from the
// plugin's `src/` modules and is bundled in from there, so there is one source
// of truth. Only the Worker-specific HTTP shell lives here: routing, CORS,
// API-key auth, body-size limits, and the streaming/JSON response shapes.

import {
  ENGINES,
  MODEL_ALIASES,
  DEFAULT_MODEL,
  resolveScene as resolveSceneValue,
  translateBatch as translateBatchCore,
  validateCookie as pluginValidateCookie,
} from "../../src/doubao.mjs";
import { stripInstruction, resolveTargetLanguage } from "../../src/lang.mjs";
import {
  splitUnits,
  collectTexts,
  rebuild,
  mergeCues,
  collectCues,
  rebuildCues,
  planBatches,
} from "../../src/units.mjs";
import { ServiceError, errorPayload } from "../../src/errors.mjs";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, x-api-key, x-doubao-target-lang, x-doubao-scene, x-doubao-context-mode",
  "access-control-expose-headers": "retry-after, x-request-id",
};

const ENCODER = new TextEncoder();
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const SSE_HEADERS = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" };

// Limits mirror the plugin so both shapes of the project refuse oversized input
// with the same code.
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TOTAL_CHARS = 20_000;
const MAX_UNIT_CHARS = 10_000;
const MAX_UNITS = 200;
const MAX_MERGED_CHARS = 800;
const MAX_BATCHES = 4;
const MAX_BATCH_ITEMS = 50;
const MAX_BATCH_CHARS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const OVERALL_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 45_000;
const DEFAULT_CONCURRENCY = 4;

const MODEL_LOOKUP = new Map();
for (const [id, service] of Object.entries(ENGINES)) MODEL_LOOKUP.set(id.toLowerCase(), { id, service });
for (const [alias, canonical] of Object.entries(MODEL_ALIASES)) {
  MODEL_LOOKUP.set(alias.toLowerCase(), { id: canonical, service: ENGINES[canonical] });
}

/** Throw a ServiceError the top-level handler will turn into an OpenAI error body. */
function fail(message, code, status = 400, headers = null) {
  throw new ServiceError(code, status, message, { headers });
}

/** A JSON response with the Worker's cache headers. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** True for a plain `{...}` object (not an array, not null). */
function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Parse a JSON request body, requiring a plain object. */
function parseJsonObject(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    fail("Invalid JSON object.", "invalid_request", 400);
  }
  if (!isPlainObject(data)) fail("Invalid JSON object.", "invalid_request", 400);
  return data;
}

/** Read a request body as text, refusing anything over `limit` bytes. */
async function readBody(request, limit) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try {
        await reader.cancel();
      } catch {
        /* the body is already gone */
      }
      fail("Body is too large.", "request_too_large", 413);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** `x-doubao-context-mode`, defaulting to `default`. */
function resolveContextMode(request) {
  const raw = request.headers.get("x-doubao-context-mode");
  const mode = raw == null || raw.trim() === "" ? "default" : raw.trim().toLowerCase();
  if (mode !== "default" && mode !== "subtitle" && mode !== "subtitle-context") {
    fail("x-doubao-context-mode must be default, subtitle, or subtitle-context.", "invalid_request", 400);
  }
  return mode;
}

/** `x-doubao-scene` header, then `DOUBAO_DEFAULT_SCENE`, then 2. */
function resolveScene(request, env) {
  const header = request.headers.get("x-doubao-scene");
  if (header != null && header.trim() !== "") {
    const scene = Number(header);
    if (!Number.isInteger(scene) || scene < 1 || scene > 6) {
      fail("x-doubao-scene must be an integer from 1 to 6.", "invalid_request", 400);
    }
    return scene;
  }
  const fallback = env.DOUBAO_DEFAULT_SCENE;
  if (fallback == null || fallback === "") return 2;
  try {
    return resolveSceneValue(undefined, fallback);
  } catch {
    fail("DOUBAO_DEFAULT_SCENE must be an integer from 1 to 6.", "configuration_error", 503);
  }
}

/** `DOUBAO_MAX_CONCURRENCY`, clamped to 1-4. */
function resolveConcurrency(env) {
  const raw = env.DOUBAO_MAX_CONCURRENCY;
  if (raw == null || raw === "") return DEFAULT_CONCURRENCY;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 4) {
    fail("DOUBAO_MAX_CONCURRENCY must be an integer from 1 to 4.", "configuration_error", 503);
  }
  return value;
}

/**
 * Normalise the pasted credential into a `Cookie` header. The plugin's
 * `validateCookie` throws to drive the sign-in UI; a Worker answers an
 * unusable credential with a single 503, so this returns `""` on failure.
 */
function normaliseCookie(raw) {
  if (typeof raw !== "string") return "";
  try {
    return pluginValidateCookie(raw);
  } catch {
    return "";
  }
}

/** OpenAI-shaped SSE for a completed translation. */
function streamCompletion(requestId, content, includeUsage, model) {
  const id = `chatcmpl_${requestId.replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  const chunks = [
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    },
    { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  if (includeUsage) {
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }
  const payload = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(payload, { status: 200, headers: SSE_HEADERS });
}

/** The last `user` message and every `system`/`developer` message. */
function pickMessages(body) {
  if (!Array.isArray(body.messages) || !body.messages.every(isPlainObject)) {
    fail("A messages array is required.", "invalid_request", 400);
  }
  let user = null;
  const contexts = [];
  for (const message of body.messages) {
    if (message.role === "user") user = message;
    else if ((message.role === "system" || message.role === "developer") && typeof message.content === "string") {
      contexts.push(message.content);
    }
  }
  if (!user || typeof user.content !== "string") {
    fail("A plain-text user message is required.", "unsupported_input", 400);
  }
  return { user, contexts };
}

/** Reject HTML/YAML wrappers, which the upstream cannot parse as plain text. */
function assertPlainText(text) {
  const wrapper =
    /^\s*<(?:yaml|text)\b/i.test(text) ||
    /<\/(?:html|a|p|div|span|code|pre|h[1-6]|strong|em|br|ul|li|table)\b|<(?:html|a|p|div|span|code|pre|h[1-6]|strong|em|br|ul|li|table)\b[^>]*(?:=|\/)[^>]*>/i.test(
      text,
    );
  if (wrapper) {
    fail("Use a plain-text template; HTML and YAML wrappers are unsupported.", "unsupported_input", 400);
  }
}

/** Split the source into units, honouring the context mode. */
function splitRequestUnits(text, mode) {
  const segments = splitUnits(text, mode);
  const subtitle = mode === "subtitle" || mode === "subtitle-context";
  for (const segment of segments) {
    if (segment.text.length > MAX_UNIT_CHARS) {
      fail(
        subtitle ? "One subtitle cue exceeds 10,000 characters." : "One line exceeds 10,000 characters.",
        "request_too_large",
        413,
      );
    }
  }
  return segments;
}

/** The full translation plan for one request. */
function planRequest(body, request, env) {
  const { user, contexts } = pickMessages(body);
  const mode = resolveContextMode(request);
  const { instruction, body: text } = stripInstruction(user.content);
  const explicit = body.target_lang ?? request.headers.get("x-doubao-target-lang") ?? null;
  const target = resolveTargetLanguage({
    explicit,
    instruction,
    contexts,
    fallback: env.DOUBAO_DEFAULT_TARGET_LANG ?? "zh",
  });

  if (!text.trim()) fail("Translation input is empty.", "empty_translation_input", 400);
  if (text.length > MAX_TOTAL_CHARS) fail("Text exceeds 20,000 characters.", "request_too_large", 413);
  assertPlainText(text);

  const segments = splitRequestUnits(text, mode);
  const stitched = mode === "subtitle-context";
  const nodes = stitched ? mergeCues(segments, { maxChars: MAX_MERGED_CHARS }) : null;
  const lines = stitched ? collectCues(nodes) : collectTexts(segments);
  if (lines.length === 0) fail("Translation input is empty.", "empty_translation_input", 400);
  if (lines.length > MAX_UNITS) fail(`Translation input exceeds ${MAX_UNITS} units.`, "request_too_large", 413);
  for (const line of lines) {
    if (line.length > MAX_UNIT_CHARS) fail("A translation unit exceeds 10,000 characters.", "request_too_large", 413);
  }
  const batches = planBatches(lines, { size: MAX_BATCH_ITEMS, chars: MAX_BATCH_CHARS, maxBatches: MAX_BATCHES });
  return { target, segments, nodes, stitched, batches };
}

/** Handle one request; throws ServiceError on failure. */
async function handleRequest(request, env, requestId) {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ status: "ok", runtime: "cloudflare-workers" });
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const isModels = url.pathname === "/v1/models";
  if (!isModels && url.pathname !== "/v1/chat/completions") fail("Route not found.", "not_found", 404);
  if (!isModels && request.method !== "POST") fail("POST is required.", "method_not_allowed", 405);

  const cookie = isModels ? "" : normaliseCookie(env.DOUBAO_SESSION_ID ?? env.DOUBAO_COOKIE);
  if (!env.API_KEY || env.API_KEY.length < 16 || /\s/.test(env.API_KEY) || (!isModels && !cookie)) {
    fail("Worker secrets are missing or invalid.", "configuration_error", 503);
  }

  const provided =
    request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? request.headers.get("x-api-key");
  if (provided !== env.API_KEY) fail("Invalid or missing API Key.", "unauthorized", 401);

  if (isModels) {
    return json({
      object: "list",
      data: Object.keys(ENGINES).map((id) => ({ id, object: "model", created: 0, owned_by: "doubao" })),
    });
  }

  const body = parseJsonObject(await readBody(request, MAX_BODY_BYTES));
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    fail("stream must be a boolean.", "invalid_request", 400);
  }
  if (["tools", "functions", "reasoning"].some((key) => body[key] !== undefined)) {
    fail("Only plain-text translation is supported.", "unsupported_feature", 400);
  }

  const model = MODEL_LOOKUP.get(String(body.model ?? DEFAULT_MODEL).toLowerCase());
  if (!model) fail(`Unknown model. Use one of: ${Object.keys(ENGINES).join(", ")}.`, "model_not_found", 404);

  const scene = resolveScene(request, env);
  const { target, segments, nodes, stitched, batches } = planRequest(body, request, env);

  const overallTimeout = AbortSignal.timeout(OVERALL_TIMEOUT_MS);
  const concurrency = resolveConcurrency(env);
  const results = [];
  let outputBytes = 0;
  for (let offset = 0; offset < batches.length; offset += concurrency) {
    const group = await Promise.all(
      batches.slice(offset, offset + concurrency).map((batch) =>
        translateBatchCore({
          texts: batch,
          target,
          engine: model.service,
          scene,
          cookie,
          requestSignal: request.signal,
          signal: AbortSignal.any([overallTimeout, request.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        }),
      ),
    );
    for (const batchResults of group) {
      for (const translation of batchResults) {
        outputBytes += ENCODER.encode(translation).byteLength;
        if (outputBytes > MAX_RESPONSE_BYTES) fail("Translation output is too large.", "upstream_stream_error", 502);
        results.push(translation);
      }
    }
  }

  const content = stitched ? rebuildCues(nodes, results) : rebuild(segments, results);

  if (body.stream === true) {
    return streamCompletion(requestId, content, body.stream_options?.include_usage === true, model.id);
  }
  return json({
    id: `chatcmpl_${requestId.replaceAll("-", "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model.id,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

const worker = {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    let response;
    try {
      response = await handleRequest(request, env, requestId);
    } catch (error) {
      const { status, headers, body } = errorPayload(error);
      response = json(body, status);
      if (headers) {
        for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
      }
    }
    response.headers.set("x-request-id", requestId);
    for (const [name, value] of Object.entries(CORS)) response.headers.set(name, value);
    return response;
  },
};

export default worker;
