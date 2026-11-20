// Doubao upstream transport: one POST per batch of strings, an SSE stream in,
// an aligned array of strings out.
//
// This is the Worker's `translateBatch` transplanted into the plugin, so both
// shapes of this project fail with the same codes and statuses. Two rules make
// it testable and safe:
//   1. No network call is ever made directly: `fetchImpl` is injected (it
//      defaults to globalThis.fetch), so tests drive every branch without
//      touching the wire.
//   2. Every wait is injectable (`backoffMs` / `sleep`), so the 5xx and
//      network retries do not cost 200-399ms per test.
//
// Zero dependencies: only ./errors.mjs is imported.

import {
  ServiceError,
  invalid,
  configError,
  upstreamError,
  abortError,
} from "./errors.mjs";

export const BASE_ORIGIN = "https://www.doubao.com";

// The Doubao browser extension (id dbjibobgilijgolhjdcbdebjhejelffo, v1.38.0)
// is what actually calls this endpoint, and it always appends this fixed
// parameter block. A bare path with no query string is a strong tell that the
// caller is not the real client and is far more likely to be challenged by the
// risk engine. Kept in the order the extension emits them. `tea_uuid` and
// `web_tab_id` are per-session random values; `web_id`/`device_id` come from a
// homepage bootstrap and are omitted here (the endpoint does not require them
// when a live session Cookie is present).
function randomTeaUuid() {
  // Session-correlation id, not a credential: Math.random keeps module load
  // cheap (touching globalThis.crypto costs ~6ms to lazily initialise in Node).
  let out = String(1 + Math.floor(Math.random() * 9));
  for (let i = 1; i < 18; i += 1) out += Math.floor(Math.random() * 10);
  return out;
}

function randomWebTabId() {
  // Same reasoning as randomTeaUuid — mimic the extension's UUID shape without
  // paying the crypto lazy-init cost at import time.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export const EXTENSION_VERSION = "1.38.0";

export const DESKTOP_PARAMS = Object.freeze({
  aid: "586864",
  device_platform: "web",
  tea_uuid: randomTeaUuid(),
  version: EXTENSION_VERSION,
  "use-olympus-account": "1",
  language: "zh",
  browser_language: "zh-CN",
  real_aid: "586864",
  pkg_type: "release_version",
  is_new_user: "0",
  region: "CN",
  sys_region: "CN",
  samantha_web: "1",
  version_code: "20800",
  pc_version: EXTENSION_VERSION,
  web_tab_id: randomWebTabId(),
});

function withParams(path, extra = {}) {
  const query = new URLSearchParams({ ...DESKTOP_PARAMS, ...extra }).toString();
  return `${BASE_ORIGIN}${path}?${query}`;
}

export const UPSTREAM_URL = withParams(
  "/samantha/plugin/stream_article_translate",
);

// Browser-shaped headers. Node's default `User-Agent: node` is the single most
// obvious giveaway that this is not the web client, so every upstream call
// carries a real Chrome UA plus the same origin/referer/fetch-metadata the page
// sends. `agw-js-conv: str` asks the gateway for a string (not binary) body.
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

export const BROWSER_HEADERS = Object.freeze({
  "user-agent": USER_AGENT,
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  origin: BASE_ORIGIN,
  referer: `${BASE_ORIGIN}/`,
  "sec-ch-ua": '"Chromium";v="147", "Google Chrome";v="147", "Not?A_Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "agw-js-conv": "str",
});

/** Model id accepted by `/v1/models` -> upstream `translate_service` value. */
export const ENGINES = Object.freeze({
  "doubao-ai-translation": "1",
  "volcengine-translate": "0",
  "microsoft-translator": "3",
});

/**
 * Old model ids that keep working, so a client configured before a rename does
 * not break. Keys are case-insensitive aliases of a canonical ENGINES id.
 */
export const MODEL_ALIASES = Object.freeze({
  "doubao-ai": "doubao-ai-translation",
});

export const DEFAULT_MODEL = "doubao-ai-translation";

/** Case-insensitive lookup: canonical ids plus the legacy aliases above. */
const MODEL_LOOKUP = new Map();
for (const [id, engine] of Object.entries(ENGINES)) MODEL_LOOKUP.set(id.toLowerCase(), engine);
for (const [alias, canonical] of Object.entries(MODEL_ALIASES)) {
  MODEL_LOOKUP.set(alias.toLowerCase(), ENGINES[canonical]);
}

const DEFAULT_SCENE = 2;
const MAX_BODY_BYTES = 512 * 1024;
// Only a session cookie is strictly needed to call the web endpoints; the
// signed `sid_tt` / `uid_tt` tokens are forwarded when present but never
// required (a Cookie with just `sessionid` or `sessionid_ss` logs in fine).
const SESSION_COOKIES = ["sessionid", "sessionid_ss"];
// A bare session id pasted straight from the browser's cookie row has no
// `name=value` pair. Real ids are long opaque tokens, so a short non-header
// string is treated as a typo rather than silently becoming a cookie name.
const BARE_SESSION_ID = /^[A-Za-z0-9._%-]{16,}$/u;
const STREAM_EVENTS = ["json", "message", "err", "done"];

export const ACCOUNT_INFO_URL = withParams("/passport/account/info/v2/", {
  account_sdk_source: "web",
  sdk_version: "2.2.5",
});

// ---------------------------------------------------------------------------
// Models, engines, scene and concurrency
// ---------------------------------------------------------------------------

/**
 * Map a requested model id to the upstream `translate_service` value.
 * A missing/blank model means DEFAULT_MODEL; an unknown one is a 404 so the
 * client can fall back to its own model list.
 */
export function resolveEngine(model) {
  const raw = typeof model === "string" ? model.trim() : "";
  if (!raw) return ENGINES[DEFAULT_MODEL];
  // The magpie gateway spells a model `provider/model`; its plugin path hands
  // the plugin the bare id, but a client talking to the plugin's own fetch
  // directly may not. Accept both.
  const name = Object.hasOwn(ENGINES, raw) ? raw : raw.slice(raw.lastIndexOf("/") + 1);
  // Ids are matched case-insensitively and the pre-rename aliases still work.
  const engine = MODEL_LOOKUP.get(name.toLowerCase());
  if (engine === undefined) {
    throw new ServiceError(
      "model_not_found",
      404,
      `Unsupported model. Use one of: ${Object.keys(ENGINES).join(", ")}.`,
      { param: "model" },
    );
  }
  return engine;
}

/**
 * Accept a per-request scene (1-6), else the configured default, else 2.
 * Helpers below are not part of the frozen export list in CONTRACT.md; they
 * exist so src/index.mjs can normalize options without duplicating Worker code.
 */
export function resolveScene(value, fallback = DEFAULT_SCENE) {
  if (value !== undefined && value !== null && String(value).trim() !== "") {
    const scene = Number(String(value).trim());
    if (Number.isInteger(scene) && scene >= 1 && scene <= 6) return scene;
    throw invalid("scene must be an integer from 1 to 6.", "invalid_request", "scene");
  }
  const configured = Number(String(fallback ?? "").trim());
  if (Number.isInteger(configured) && configured >= 1 && configured <= 6) {
    return configured;
  }
  throw configError("DOUBAO_DEFAULT_SCENE must be an integer from 1 to 6.");
}

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

/**
 * Parse a Cookie header (or a browser-exported Cookie JSON array) into a
 * name -> value map. `Cookie: ` prefixes, surrounding whitespace and the JSON
 * `[{ "name": ..., "value": ... }]` shape are all accepted.
 */
function parseCookieEntries(raw) {
  const text = String(raw).replace(/^\s*cookie\s*:\s*/i, "").trim();
  if (text.startsWith("[") || text.startsWith("{")) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    const list = Array.isArray(data) ? data : Array.isArray(data?.cookies) ? data.cookies : null;
    if (list) {
      const map = new Map();
      for (const entry of list) {
        const name = String(entry?.name ?? "").trim();
        const value = String(entry?.value ?? "").trim();
        if (name && value) map.set(name, value);
      }
      return map;
    }
    // Not a recognizable JSON export: fall through and treat it as a header.
  }
  const map = new Map();
  for (const part of text.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name && value) map.set(name, value);
  }
  return map;
}

/** Render a name -> value map back into a `Cookie` header value. */
function formatCookie(entries) {
  return [...entries].map(([name, value]) => `${name}=${value}`).join("; ");
}

/**
 * Normalize a pasted Cookie. Accepts the `Cookie: ` prefix, an exported Cookie
 * JSON (converted to header form), or a **bare `sessionid` value** (the string
 * copied straight from the browser's cookie row, with no `sessionid=` in
 * front). Refuses header injection (`\r`/`\n`) and requires a login session
 * cookie (`sessionid` or `sessionid_ss`). The `sid_tt` / `uid_tt` tokens are
 * optional extras, not requirements. Throws configuration_error (503).
 */
export function validateCookie(raw) {
  if (typeof raw !== "string") {
    throw configError("Doubao Cookie is missing.");
  }
  const cookie = raw.trim().replace(/^Cookie:\s*/i, "").trim();
  if (!cookie) throw configError("Doubao Cookie is missing.");
  if (/[\r\n]/.test(cookie) && !/^\s*[[{]/.test(cookie)) {
    throw configError("Doubao Cookie must be a single line.");
  }
  const entries = parseCookieEntries(cookie);
  if (SESSION_COOKIES.some((name) => entries.has(name))) {
    // A JSON export is turned into a header; a plain header keeps its exact
    // bytes (cookie values may be quoted, so never re-encode them) — unless the
    // header is malformed (empty values, stray spaces around `=`, or a part
    // with no `=`). Then we rebuild it from the parsed entries, because sending
    // `sessionid = spaced` upstream only produces a confusing 401.
    if (/^\s*[[{]/.test(cookie)) {
      const rebuilt = formatCookie(entries);
      // A JSON export can smuggle a newline inside a value; refuse it after rebuild.
      if (/[\r\n]/.test(rebuilt)) {
        throw configError("Doubao Cookie must be a single line.");
      }
      return rebuilt;
    }
    const wellFormed = cookie.split(";").every((part) => {
      const index = part.indexOf("=");
      if (index <= 0) return false;
      const name = part.slice(0, index);
      const value = part.slice(index + 1);
      return name === name.trim() && name !== "" && value !== "" && value === value.trim();
    });
    return wellFormed ? cookie : formatCookie(entries);
  }
  // Bare value: no `name=value` and no separators, just the session id itself.
  if (!/^\s*[[{]/.test(cookie) && !/[=;]/.test(cookie) && BARE_SESSION_ID.test(cookie)) {
    return `sessionid=${cookie}`;
  }
  throw configError(
    "Doubao Cookie is missing sessionid (or sessionid_ss). Paste the sessionid value or a Cookie header.",
  );
}

/**
 * Ask Doubao who the Cookie belongs to. Returns `{ uid, name }` on a live
 * session; throws `upstream_auth_error` (401) when Doubao reports the session
 * expired. A plain network failure propagates unchanged so a transient hiccup
 * does not look like a bad Cookie.
 *
 * The endpoint answers HTTP 200 even for an expired session, so the JSON body
 * (not the status) decides: an expired session has `user_id: 0` and a
 * `message: "error"`.
 */
export async function fetchAccountInfo({ cookie, fetchImpl = globalThis.fetch, signal } = {}) {
  const cookieHeader = validateCookie(cookie);
  if (typeof fetchImpl !== "function") {
    throw configError("No fetch implementation is available.");
  }
  const response = await fetchImpl(ACCOUNT_INFO_URL, {
    method: "GET",
    redirect: "manual",
    signal,
    headers: {
      ...BROWSER_HEADERS,
      accept: "application/json, text/plain, */*",
      cookie: cookieHeader,
    },
  });
  let body = "";
  try {
    body = typeof response.text === "function" ? await response.text() : "";
  } catch {
    body = "";
  }
  let payload = null;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = null;
  }
  const data = payload?.data;
  const uid = String(data?.user_id_str ?? data?.user_id ?? "").trim();
  if (
    !responseOk(response) ||
    !data ||
    !uid ||
    uid === "0" ||
    data.is_visitor_account === true ||
    payload?.message === "error"
  ) {
    throw new ServiceError(
      "upstream_auth_error",
      401,
      "Doubao login has expired. Sign in again with a new Cookie.",
    );
  }
  const name = String(data.screen_name ?? data.name ?? "").trim();
  return { uid, name };
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

/** The exact JSON body the upstream endpoint expects. */
export function buildUpstreamBody({ texts, target, engine, scene = DEFAULT_SCENE } = {}) {
  return {
    raw_text: texts,
    target_lang: target,
    translate_service: engine,
    scene,
    frontend_source: 1,
  };
}

// ---------------------------------------------------------------------------
// Upstream response parsing
// ---------------------------------------------------------------------------

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** `{"code":710012001}` means the Doubao login expired; anything else is fatal. */
function checkUpstreamCode(payload) {
  if (payload.code === undefined || payload.code === 0) return;
  if (payload.code === 710012001) {
    throw upstreamError("Doubao login has expired.", "upstream_auth_error", 502);
  }
  // 710022002 / 710022013: the account or the anonymous session hit Doubao's
  // risk-control quota. Report it as a distinct 429 so clients back off.
  if (payload.code === 710022002 || payload.code === 710022013) {
    throw upstreamError(
      "Doubao rate-limited this session. Retry later or use a fresh login.",
      "upstream_quota_exceeded",
      429,
    );
  }
  throw upstreamError("Doubao translation failed.", "upstream_stream_error", 502);
}

function parseUpstreamJson(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    // fall through to the uniform error below
  }
  if (!isRecord(payload)) {
    throw upstreamError("Invalid Doubao stream JSON.", "upstream_stream_error", 502);
  }
  return payload;
}

/**
 * Parse the upstream SSE body and return `expected` translations by index.
 *
 * Accepted shape (as the Worker sends/receives it):
 *   event: json | message   data: {"code":0,"data":{"items":[{"index":0,"res":"..."}]}}
 *   event: done             data: {"code":0}      (optional, `[DONE]` optional)
 *   event: err              data: {...}           (always fatal)
 *
 * A wrong item (index out of range, non-integer index, empty/missing res) is
 * `upstream_stream_error`; a complete-but-short index set is
 * `upstream_incomplete_result`.
 */
export function parseUpstreamStream(text, expected) {
  if (!Number.isInteger(expected) || expected < 0) {
    throw invalid(
      "Expected translation count must be a non-negative integer.",
      "invalid_request",
      "texts",
    );
  }
  if (typeof text !== "string") {
    throw upstreamError("Invalid Doubao stream.", "upstream_stream_error", 502);
  }
  if (expected === 0) return [];

  const streamText = text.replace(/\r\n|\r/g, "\n").trimStart();
  if (!streamText) {
    throw upstreamError(
      "Doubao returned an empty response.",
      "upstream_incomplete_result",
      502,
    );
  }

  // A bare JSON body carries an error code, never translations.
  if (streamText.startsWith("{")) {
    checkUpstreamCode(parseUpstreamJson(streamText));
    throw upstreamError(
      "Upstream returned no translations.",
      "upstream_incomplete_result",
      502,
    );
  }

  const translations = new Map();

  for (const block of streamText.split(/\n\n+/)) {
    let event = "message";
    const data = [];

    for (const line of block.split("\n")) {
      const trimmed = line.trimEnd();
      if (!trimmed || trimmed.startsWith(":")) continue;
      if (trimmed.startsWith("event:")) event = trimmed.slice(6).trim();
      if (trimmed.startsWith("data:")) data.push(trimmed.slice(5).replace(/^ /, ""));
    }

    if (data.length === 0) continue;

    const payloadText = data.join("\n").trim();
    if (payloadText === "[DONE]") continue;
    if (!STREAM_EVENTS.includes(event)) continue;

    if (event === "done") {
      if (payloadText) checkUpstreamCode(parseUpstreamJson(payloadText));
      continue;
    }

    const payload = parseUpstreamJson(payloadText);
    checkUpstreamCode(payload);
    if (event === "err") {
      throw upstreamError(
        "Upstream stream reported an error.",
        "upstream_stream_error",
        502,
      );
    }

    const items =
      isRecord(payload.data) && Array.isArray(payload.data.items)
        ? payload.data.items
        : [];

    for (const item of items) {
      if (
        !isRecord(item) ||
        typeof item.index !== "number" ||
        !Number.isInteger(item.index) ||
        item.index < 0 ||
        item.index >= expected ||
        typeof item.res !== "string" ||
        !item.res.trim()
      ) {
        throw upstreamError(
          "Invalid upstream translation item.",
          "upstream_stream_error",
          502,
        );
      }
      translations.set(item.index, item.res);
    }
  }

  // A complete index set is enough; `event: done` and `[DONE]` are optional.
  if (translations.size !== expected) {
    throw upstreamError(
      "Upstream translation is incomplete.",
      "upstream_incomplete_result",
      502,
    );
  }

  return Array.from({ length: expected }, (_, index) => translations.get(index));
}

// ---------------------------------------------------------------------------
// Transport helpers (Worker parity)
// ---------------------------------------------------------------------------

/** Only a plausible `retry-after` is forwarded; garbage is dropped. */
function retryAfterHeader(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.length > 128) return null;
  const valid =
    /^\d+$/.test(trimmed) ||
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/i.test(
      trimmed,
    );
  return valid ? { "retry-after": trimmed } : null;
}

function randomBackoff() {
  return 200 + Math.floor(Math.random() * 200);
}

function delayWithAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Read at most MAX_BODY_BYTES from the upstream, mirroring the Worker's cap. */
async function readUpstreamText(response) {
  const body = response?.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return text + decoder.decode();
        bytes += chunk.value?.byteLength ?? 0;
        if (bytes > MAX_BODY_BYTES) {
          throw upstreamError(
            "Doubao response is too large.",
            "upstream_stream_error",
            502,
          );
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      // Cleanup must never mask the outcome above.
      try {
        await reader.cancel?.();
      } catch {
        // ignore
      }
      try {
        reader.releaseLock?.();
      } catch {
        // ignore
      }
    }
  }
  if (typeof response?.text === "function") return await response.text();
  return "";
}

async function discardBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // A failed cancel must never mask the real upstream error.
  }
}

/** `Headers`, a plain object or a `Map` all work, so fakes stay simple. */
function headerValue(response, name) {
  const headers = response?.headers;
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const lower = name.toLowerCase();
  if (headers instanceof Map) {
    for (const [key, value] of headers) {
      if (String(key).toLowerCase() === lower) return value;
    }
    return undefined;
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

/** A fake response may omit `ok`; then the status decides. */
function responseOk(response) {
  if (typeof response?.ok === "boolean") return response.ok;
  const status = Number(response?.status);
  return Number.isInteger(status) && status >= 200 && status <= 299;
}

// ---------------------------------------------------------------------------
// translateBatch
// ---------------------------------------------------------------------------

/**
 * Translate one batch of strings upstream.
 *
 * @param {object} options
 * @param {string[]} options.texts      Strings to translate, index = position.
 * @param {string}   options.target     Target language tag (`zh`, `ja`, ...).
 * @param {string}   options.engine     `translate_service` value (see ENGINES).
 * @param {number}  [options.scene]     Upstream scene, 1-6 (default 2).
 * @param {string}   options.cookie     Cookie header (validated here).
 * @param {Function}[options.fetchImpl] Injected fetch (default globalThis.fetch).
 * @param {AbortSignal}[options.signal] Timeout + request signal combined.
 * @param {AbortSignal}[options.requestSignal] Client hang-up only (=> 499).
 * @param {number}  [options.retries]   Retries for 5xx / network errors (1).
 * @param {number|Function}[options.backoffMs] Fixed or computed backoff.
 * @param {Function}[options.sleep]     Injected wait, e.g. `async () => {}`.
 * @returns {Promise<string[]>} Translations aligned with `texts`.
 */
export async function translateBatch({
  texts,
  target,
  engine,
  scene = DEFAULT_SCENE,
  cookie,
  fetchImpl = globalThis.fetch,
  signal,
  requestSignal,
  retries = 1,
  backoffMs,
  sleep,
} = {}) {
  if (!Array.isArray(texts)) {
    throw invalid("texts must be an array of strings.", "invalid_request", "texts");
  }
  if (texts.length === 0) return [];
  if (typeof fetchImpl !== "function") {
    throw configError("No fetch implementation is available.");
  }

  const cookieHeader = validateCookie(cookie);
  const requestBody = JSON.stringify(
    buildUpstreamBody({ texts, target, engine, scene }),
  );

  // One retry budget shared by 5xx and network failures, as in the Worker:
  // a 500 followed by a TypeError must not get a third attempt.
  let budget = Number.isInteger(retries) && retries > 0 ? retries : 0;

  const cancelled = () =>
    new ServiceError("request_cancelled", 499, "Request was cancelled.");

  const wait = async () => {
    const ms =
      typeof backoffMs === "function"
        ? backoffMs()
        : Number.isFinite(backoffMs) && backoffMs >= 0
          ? backoffMs
          : randomBackoff();
    try {
      if (typeof sleep === "function") await sleep(ms);
      else await delayWithAbort(ms, signal);
    } catch (error) {
      throw abortError(error, { timeoutSignal: signal, requestSignal }) ?? error;
    }
  };

  for (;;) {
    if (requestSignal?.aborted) throw cancelled();

    try {
      const response = await fetchImpl(UPSTREAM_URL, {
        method: "POST",
        redirect: "manual",
        signal,
        headers: {
          ...BROWSER_HEADERS,
          "content-type": "application/json",
          accept: "text/event-stream",
          cookie: cookieHeader,
        },
        body: requestBody,
      });

      if (!responseOk(response)) {
        const status = Number(response?.status);
        const retryAfter = retryAfterHeader(headerValue(response, "retry-after"));
        await discardBody(response);

        if (status >= 500 && status <= 599 && budget > 0) {
          budget -= 1;
          await wait();
          continue;
        }
        if (status === 429) {
          throw upstreamError(
            "Doubao rate limit reached.",
            "upstream_rate_limit",
            429,
            retryAfter,
          );
        }
        throw upstreamError(
          "Doubao access refused or request failed.",
          "upstream_http_error",
          502,
        );
      }

      const streamText = (await readUpstreamText(response))
        .replace(/\r\n|\r/g, "\n")
        .trimStart();

      return parseUpstreamStream(streamText, texts.length);
    } catch (error) {
      // Anything we already classified (429, 502, 504, 499) is final.
      if (error instanceof ServiceError) throw error;

      const abort = abortError(error, { timeoutSignal: signal, requestSignal });
      if (abort) throw abort;

      if (budget > 0) {
        budget -= 1;
        await wait();
        continue;
      }
      throw upstreamError(
        "Doubao connection failed.",
        "upstream_network_error",
        502,
      );
    }
  }
}
