// Protocol adaptation for the three HTTP shapes magpie clients speak:
// OpenAI Chat Completions, OpenAI Responses and Anthropic Messages.
//
// This module only *collects* what the caller needs: the plain-text user
// message, the system/developer context, the raw target language, stream
// flags and the scene. It never parses or normalizes a language — that is
// lang.mjs' job — and it never talks to the network.

import { invalid } from "./errors.mjs";

/** Canonical pathname -> protocol name. Unknown paths are the caller's 400. */
export const PROTOCOLS = Object.freeze({
  "/v1/chat/completions": "openai-chat",
  "/v1/responses": "openai-responses",
  "/v1/messages": "anthropic",
});

const CONTEXT_MODES = new Set(["default", "subtitle", "subtitle-context"]);

// Body fields that only make sense for a full chat/tool backend. A pure
// translation proxy cannot honour any of them, so they are rejected loudly
// instead of being silently dropped.
const UNSUPPORTED_FIELDS = [
  "tools",
  "functions",
  "function_call",
  "previous_response_id",
  "conversation",
  "reasoning",
  "reasoning_effort",
  "background",
  "audio",
  "prediction",
  "prompt",
];

const CHAT_ROLES = new Set(["system", "developer", "user", "assistant"]);
const ANTHROPIC_ROLES = new Set(["user", "assistant"]);

// Per-message fields that imply a tool/audio exchange.
const MESSAGE_UNSUPPORTED = ["tool_calls", "function_call", "audio", "tool_call_id", "image_url"];

const UNSUPPORTED_MESSAGE = "Requested capability is not supported by this translation service.";
const PLAIN_TEXT_REQUIRED = "A plain-text user message is required.";

/* ------------------------------------------------------------------ paths */

/**
 * Map a request pathname to one of the three protocol names, or null.
 * Tolerates a query string, a fragment and trailing slashes.
 */
export function protocolOf(pathname) {
  if (typeof pathname !== "string") return null;
  let path = pathname.trim();
  if (path === "") return null;
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  path = path.replace(/\/+$/, "");
  if (!path.startsWith("/")) path = `/${path}`;
  return Object.hasOwn(PROTOCOLS, path) ? PROTOCOLS[path] : null;
}

/* ---------------------------------------------------------------- helpers */

/** False for null/undefined/false/""/[]/{} — the same rule the original plugin used. */
function hasValue(value) {
  if (value == null || value === false || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function unsupported(param) {
  throw invalid(UNSUPPORTED_MESSAGE, "unsupported_feature", param);
}

/** Read one header from a `Headers` instance or a plain object, case-insensitively. */
function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return value == null ? undefined : String(value);
  }
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = headers[key];
    if (Array.isArray(value)) return value.length > 0 && value[0] != null ? String(value[0]) : undefined;
    return value == null ? undefined : String(value);
  }
  return undefined;
}

function requireBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("Invalid request parameters.", "invalid_request", "body");
  }
  return body;
}

/**
 * Flatten a `content` value to text. Strings pass through; arrays must contain
 * only accepted text parts (everything else is unsupported input).
 */
function textContent(value, accepted, { nullable = false, field = "content" } = {}) {
  if (value == null) {
    if (nullable) return "";
    throw invalid(PLAIN_TEXT_REQUIRED, "unsupported_input", field);
  }
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    throw invalid("Only plain-text message content is supported.", "unsupported_input", field);
  }
  let text = "";
  for (const part of value) {
    if (!part || typeof part !== "object" || Array.isArray(part) || !accepted.includes(part.type)) {
      throw invalid("Only plain-text message content is supported.", "unsupported_input", field);
    }
    if (typeof part.text !== "string") {
      throw invalid("Text content must be a string.", "invalid_request", field);
    }
    text += part.text;
  }
  return text;
}

/**
 * Walk a message list, collecting system/developer context and the text of the
 * *last* user message. Anything that is not plain text is rejected.
 */
function readMessages(value, { protocol, contexts, field = "messages" }) {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid("A nonempty message list is required.", "invalid_request", field);
  }
  const roles = protocol === "anthropic" ? ANTHROPIC_ROLES : CHAT_ROLES;
  const textTypes = protocol === "openai-responses" ? ["input_text", "text"] : ["text"];
  let user;
  for (const message of value) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw invalid("Only plain-text messages are supported.", "unsupported_input", field);
    }
    if (typeof message.role !== "string" || !roles.has(message.role)) {
      throw invalid("Only plain-text messages are supported.", "unsupported_input", field);
    }
    if (message.type != null && message.type !== "message") {
      throw invalid("Only plain-text messages are supported.", "unsupported_input", field);
    }
    for (const key of MESSAGE_UNSUPPORTED) {
      if (hasValue(message[key])) unsupported(key);
    }
    const accepted =
      protocol === "openai-responses" && message.role === "assistant"
        ? [...textTypes, "output_text"]
        : textTypes;
    const text = textContent(message.content, accepted, {
      nullable: message.role === "assistant",
      field: "content",
    });
    if (message.role === "system" || message.role === "developer") contexts.push(text);
    else if (message.role === "user") user = text;
  }
  if (typeof user !== "string" || user.trim() === "") {
    throw invalid(PLAIN_TEXT_REQUIRED, "unsupported_input");
  }
  return user;
}

function sceneOf(raw, param) {
  if (raw == null || raw === "") return null;
  const numeric =
    typeof raw === "number" ? raw : typeof raw === "string" && /^[1-6]$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 6) {
    throw invalid("doubao_scene must be an integer between 1 and 6.", "invalid_request", param);
  }
  return numeric;
}

/* ------------------------------------------------------- capability check */

/**
 * Reject everything a translation service cannot honour. Throws a 400
 * `unsupported_feature` naming the offending field.
 */
export function checkCapabilities(body, protocol) {
  const value = requireBody(body);
  for (const key of UNSUPPORTED_FIELDS) {
    if (hasValue(value[key])) unsupported(key);
  }
  if (hasValue(value.tool_choice) && value.tool_choice !== "none") unsupported("tool_choice");
  if (hasValue(value.thinking) && value.thinking.type !== "disabled") unsupported("thinking");
  if (value.n != null && value.n !== 1) unsupported("n");
  if (
    hasValue(value.modalities) &&
    (!Array.isArray(value.modalities) || value.modalities.some((entry) => entry !== "text"))
  ) {
    unsupported("modalities");
  }
  // `response_format: { type: "text" }` is a no-op for us and stays allowed;
  // anything structured (json_object / json_schema) is not.
  if (hasValue(value.response_format) && value.response_format.type !== "text") unsupported("response_format");
  if (protocol === "openai-responses" && hasValue(value.text)) {
    const format = value.text?.format;
    if (hasValue(format) && format.type !== "text") unsupported("text.format");
  }
  // Tool/audio payloads can also ride on individual messages (assistant
  // `tool_calls`, a `tool` role turn, an inline image part). Reject them here
  // too so the check is complete without walking the request.
  for (const list of [value.messages, value.input]) {
    if (!Array.isArray(list)) continue;
    for (const message of list) {
      if (!message || typeof message !== "object") continue;
      for (const key of MESSAGE_UNSUPPORTED) {
        if (hasValue(message[key])) unsupported(key);
      }
    }
  }
}

/* ------------------------------------------------------- request adaptation */

function collectChat(body) {
  const contexts = [];
  const text = readMessages(body.messages, { protocol: "openai-chat", contexts });
  return { text, contexts, instructions: null };
}

function collectResponses(body) {
  const contexts = [];
  let instructions = null;
  if (body.instructions != null && body.instructions !== "") {
    instructions = textContent(body.instructions, ["text", "input_text"], { field: "instructions" });
    contexts.push(instructions);
  }
  let text;
  if (typeof body.input === "string") text = body.input;
  else if (body.input == null) throw invalid(PLAIN_TEXT_REQUIRED, "unsupported_input", "input");
  else text = readMessages(body.input, { protocol: "openai-responses", contexts, field: "input" });
  if (typeof text !== "string" || text.trim() === "") {
    throw invalid(PLAIN_TEXT_REQUIRED, "unsupported_input", "input");
  }
  return { text, contexts, instructions };
}

function collectAnthropic(body) {
  const contexts = [];
  if (body.system != null && body.system !== "") {
    contexts.push(textContent(body.system, ["text"], { field: "system" }));
  }
  const text = readMessages(body.messages, { protocol: "anthropic", contexts });
  return { text, contexts, instructions: null };
}

/**
 * Adapt one request body into the translation kernel's canonical view.
 *
 * Returns `{ protocol, model, stream, includeUsage, target, text, contextMode,
 * scene }` plus the additive `contexts` / `instructions` fields the language
 * resolver needs. `target` is the *raw* value: parsing it is lang.mjs' job.
 */
export function adaptRequest(protocol, body, { headers, options } = {}) {
  if (typeof protocol !== "string" || !Object.values(PROTOCOLS).includes(protocol)) {
    throw invalid("Unsupported protocol.", "invalid_request", "protocol");
  }
  const value = requireBody(body);
  checkCapabilities(value, protocol);

  const collected =
    protocol === "openai-chat"
      ? collectChat(value)
      : protocol === "openai-responses"
        ? collectResponses(value)
        : collectAnthropic(value);

  let target = value.target_lang;
  if (target == null || target === "") target = headerValue(headers, "x-doubao-target-lang");
  if (target != null && target !== "" && typeof target !== "string") {
    throw invalid("target_lang must be a string.", "invalid_request", "target_lang");
  }
  const rawTarget = target == null || target === "" ? null : target;

  const headerMode = headerValue(headers, "x-doubao-context-mode");
  const contextMode = headerMode == null || headerMode === "" ? "default" : headerMode.trim().toLowerCase();
  if (!CONTEXT_MODES.has(contextMode)) {
    throw invalid("x-doubao-context-mode must be default, subtitle, or subtitle-context.", "invalid_request");
  }

  const optionScene =
    Number.isInteger(options?.scene) && options.scene >= 1 && options.scene <= 6 ? options.scene : null;
  const scene =
    sceneOf(value.doubao_scene, "doubao_scene") ??
    sceneOf(headerValue(headers, "x-doubao-scene"), "x-doubao-scene") ??
    optionScene;

  let model = null;
  if (value.model != null && value.model !== "") {
    if (typeof value.model !== "string") throw invalid("model must be a string.", "invalid_request", "model");
    model = value.model;
  }

  return {
    protocol,
    model,
    stream: value.stream === true,
    includeUsage: value.stream_options?.include_usage === true,
    target: rawTarget,
    text: collected.text,
    contextMode,
    scene,
    // Additive, not part of the frozen eight-key shape: the language resolver
    // reads system/developer/instructions context from here.
    contexts: collected.contexts,
    instructions: collected.instructions,
  };
}

/* ---------------------------------------------------------------- output */

function newId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  const raw = uuid
    ? uuid.replaceAll("-", "")
    : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${raw}`;
}

function stringOf(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

// Usage keys are protocol-specific, so an override coming from the kernel (which
// speaks OpenAI chat names) is translated rather than blindly merged: an
// Anthropic body must never carry `prompt_tokens`.
const USAGE_ALIASES = {
  anthropic: { prompt_tokens: "input_tokens", completion_tokens: "output_tokens", total_tokens: null },
  "openai-responses": { prompt_tokens: "input_tokens", completion_tokens: "output_tokens" },
  "openai-chat": { input_tokens: "prompt_tokens", output_tokens: "completion_tokens" },
};

function usageOf(protocol, usage) {
  const base =
    protocol === "anthropic"
      ? { input_tokens: 0, output_tokens: 0 }
      : protocol === "openai-responses"
        ? { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
        : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return base;
  const aliases = USAGE_ALIASES[protocol] ?? {};
  const merged = { ...base };
  for (const [key, entry] of Object.entries(usage)) {
    if (entry === undefined || entry === null) continue;
    if (Object.hasOwn(merged, key)) {
      merged[key] = entry;
      continue;
    }
    const alias = aliases[key];
    if (alias && Object.hasOwn(merged, alias)) merged[alias] = entry;
  }
  return merged;
}

/**
 * The complete (non-streaming) JSON body for one protocol.
 * `{ id, model, content, usage }` — `id` and `usage` are optional.
 */
export function renderResponse(protocol, { id, model, content, usage, created } = {}) {
  if (typeof protocol !== "string" || !Object.values(PROTOCOLS).includes(protocol)) {
    throw invalid("Unsupported protocol.", "invalid_request", "protocol");
  }
  const text = stringOf(content);
  const name = model == null ? null : stringOf(model);
  const created_at = Number.isFinite(created) ? Math.floor(created) : Math.floor(Date.now() / 1000);

  if (protocol === "openai-chat") {
    return {
      id: id ?? newId("chatcmpl"),
      object: "chat.completion",
      created: created_at,
      model: name,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: usageOf(protocol, usage),
    };
  }

  if (protocol === "anthropic") {
    return {
      id: id ?? newId("msg"),
      type: "message",
      role: "assistant",
      model: name,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: usageOf(protocol, usage),
    };
  }

  const responseId = id ?? newId("resp");
  return {
    id: responseId,
    object: "response",
    created_at,
    status: "completed",
    model: name,
    output: [
      {
        type: "message",
        id: newId("msg"),
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    output_text: text,
    usage: usageOf(protocol, usage),
  };
}

/**
 * The complete SSE body for one protocol (a string, not a ReadableStream).
 * The caller wraps it in `new Response(...)` with `text/event-stream`.
 */
export function renderStream(protocol, { id, model, content, includeUsage, usage, created } = {}) {
  if (typeof protocol !== "string" || !Object.values(PROTOCOLS).includes(protocol)) {
    throw invalid("Unsupported protocol.", "invalid_request", "protocol");
  }
  const text = stringOf(content);
  const complete = renderResponse(protocol, { id, model, content: text, usage, created });
  const frames = [];
  const emit = (value, event) => {
    frames.push(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(value)}\n\n`);
  };

  if (protocol === "openai-chat") {
    const chunk = (delta, finish) => ({
      id: complete.id,
      object: "chat.completion.chunk",
      created: complete.created,
      model: complete.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    emit(chunk({ role: "assistant", content: text }, null));
    emit(chunk({}, "stop"));
    if (includeUsage === true) {
      emit({
        id: complete.id,
        object: "chat.completion.chunk",
        created: complete.created,
        model: complete.model,
        choices: [],
        usage: complete.usage,
      });
    }
    frames.push("data: [DONE]\n\n");
    return frames.join("");
  }

  if (protocol === "anthropic") {
    emit({ type: "message_start", message: { ...complete, content: [], stop_reason: null } }, "message_start");
    emit(
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      "content_block_start",
    );
    emit(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      "content_block_delta",
    );
    emit({ type: "content_block_stop", index: 0 }, "content_block_stop");
    emit(
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: complete.usage.output_tokens ?? 0 },
      },
      "message_delta",
    );
    emit({ type: "message_stop" }, "message_stop");
    return frames.join("");
  }

  // OpenAI Responses: a small but complete lifecycle, so SDKs that track the
  // response object see every transition.
  let sequence = 0;
  const event = (type, fields) => emit({ type, ...fields, sequence_number: sequence++ }, type);
  const item = complete.output[0];
  const part = item.content[0];
  const indexes = { item_id: item.id, output_index: 0, content_index: 0 };
  const inProgress = { ...complete, status: "in_progress", output: [], usage: null };
  event("response.created", { response: inProgress });
  event("response.in_progress", { response: inProgress });
  event("response.output_item.added", {
    output_index: 0,
    item: { ...item, status: "in_progress", content: [] },
  });
  event("response.content_part.added", { ...indexes, part: { type: "output_text", text: "", annotations: [] } });
  event("response.output_text.delta", { ...indexes, delta: text, logprobs: [] });
  event("response.output_text.done", { ...indexes, text, logprobs: [] });
  event("response.content_part.done", { ...indexes, part });
  event("response.output_item.done", { output_index: 0, item });
  event("response.completed", { response: complete });
  return frames.join("");
}
