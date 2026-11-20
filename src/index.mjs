// magpie plugin entry: Doubao Translation
//
// The plugin is a thin host adapter around the same translation kernel the
// Cloudflare Worker uses: language normalisation never fails, the `%%` batch
// separator is owned by the server, and upstream errors keep their Worker
// semantics (429 + Retry-After, 499, 504, one retry on 5xx).

import { randomUUID } from "node:crypto";

import {
  abortError,
  errorPayload,
  invalid,
  ServiceError,
  tooLarge,
  upstreamError,
} from "./errors.mjs";
import {
  fetchAccountInfo,
  resolveEngine,
  translateBatch,
  validateCookie,
} from "./doubao.mjs";
import {
  normalizeLanguage,
  resolveTargetLanguage,
  stripInstruction,
} from "./lang.mjs";
import {
  adaptRequest,
  protocolOf,
  renderResponse,
  renderStream,
} from "./protocols.mjs";
import {
  collectCues,
  collectTexts,
  mergeCues,
  planBatches,
  rebuild,
  rebuildCues,
  splitUnits,
} from "./units.mjs";

export const PROVIDER = "doubao-translation";
export const BASE_URL = "https://doubao-translation.invalid/v1";

// A placeholder key: the gateway must never see the Doubao Cookie in the
// Authorization header, so the plugin hands back an opaque constant instead.
const PLACEHOLDER_KEY = "doubao-translate2api-local";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_CHARS = 20000;
const MAX_UNIT_CHARS = 10000;
const MAX_UNITS = 200;
// Longest sentence the `subtitle-context` stitcher will build before it starts
// a new one, so a cue without a sentence terminator cannot swallow the whole
// document and trip MAX_UNIT_CHARS.
const MAX_MERGED_CHARS = 800;

const MODELS = [
  { id: "doubao-ai-translation", name: "Doubao AI Translation", engine: "1" },
  { id: "volcengine-translate", name: "Volcengine Translate", engine: "0" },
  { id: "microsoft-translator", name: "Microsoft Translator", engine: "3" },
];

const DEFAULTS = {
  targetLang: "zh",
  scene: 2,
  maxConcurrency: 4,
  requestTimeoutMs: 45000,
  totalTimeoutMs: 180000,
  authTimeoutMs: 10000,
  // The Worker retries a 5xx or a network failure once; the plugin keeps that
  // default rather than the upstream plugin's 0, so both shapes behave alike.
  maxRetries: 1,
};

function pickInt(value, fallback, { min, max }) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number)) return fallback;
  if (number < min || number > max) return fallback;
  return number;
}

function parseOptions(rawOptions) {
  const raw = rawOptions && typeof rawOptions === "object" ? rawOptions : {};
  const targetLang = normalizeLanguage(
    typeof raw.targetLang === "string" ? raw.targetLang : DEFAULTS.targetLang,
  );
  if (!targetLang) {
    throw new Error(
      `Invalid Doubao plugin options: targetLang "${raw.targetLang}" is not a supported language.`,
    );
  }
  return {
    targetLang,
    scene: pickInt(raw.scene, DEFAULTS.scene, { min: 1, max: 6 }),
    maxConcurrency: pickInt(raw.maxConcurrency, DEFAULTS.maxConcurrency, { min: 1, max: 1000 }),
    requestTimeoutMs: pickInt(raw.requestTimeoutMs, DEFAULTS.requestTimeoutMs, {
      min: 1000,
      max: 600000,
    }),
    totalTimeoutMs: pickInt(raw.totalTimeoutMs, DEFAULTS.totalTimeoutMs, {
      min: 1000,
      max: 3600000,
    }),
    authTimeoutMs: pickInt(raw.authTimeoutMs, DEFAULTS.authTimeoutMs, { min: 1000, max: 120000 }),
    maxRetries: pickInt(raw.maxRetries, DEFAULTS.maxRetries, { min: 0, max: 10 }),
  };
}

function defaultModels() {
  const models = {};
  for (const model of MODELS) {
    models[model.id] = {
      name: model.name,
      // Conservative gateway budgets, not a claimed upstream token allowance.
      limit: { context: 32000, output: 32000 },
      tool_call: false,
      reasoning: false,
      modalities: { input: ["text"], output: ["text"] },
    };
  }
  return models;
}

function cookieFor(auth) {
  if (!auth || auth.type !== "api" || typeof auth.key !== "string" || !auth.key.trim()) {
    throw Object.assign(
      new ServiceError("cookie_missing", 401, "Sign in with your Doubao Cookie first."),
      { signIn: "expired" },
    );
  }
  try {
    return validateCookie(auth.key);
  } catch {
    throw Object.assign(
      new ServiceError("cookie_invalid", 401, "Doubao Cookie is invalid. Sign in again."),
      { signIn: "expired" },
    );
  }
}

const EXPIRED_CODES = new Set(["cookie_missing", "cookie_invalid", "upstream_auth_error"]);

function failure(error, protocol) {
  const value = error instanceof ServiceError ? error : null;
  const payload = errorPayload(error);
  const isExpired = value ? EXPIRED_CODES.has(value.code) : false;
  const status = isExpired ? 401 : payload.status;
  const body =
    protocol === "anthropic"
      ? { type: "error", error: { type: payload.body.error.type, message: payload.body.error.message } }
      : payload.body;
  const headers = { ...payload.headers };
  if (isExpired) headers["X-Magpie-Sign-In"] = "expired";
  return Response.json(body, { status, headers });
}

function withinLimits(text, units) {
  if (text.length > MAX_TOTAL_CHARS) {
    throw tooLarge(`Translation input exceeds ${MAX_TOTAL_CHARS} characters.`);
  }
  if (units.length > MAX_UNITS) {
    throw tooLarge(`Translation input exceeds ${MAX_UNITS} units.`);
  }
  for (const unit of units) {
    if (unit.length > MAX_UNIT_CHARS) {
      throw tooLarge(`A translation unit exceeds ${MAX_UNIT_CHARS} characters.`);
    }
  }
}

function timeoutSignal(ms) {
  return typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

function combineSignals(...signals) {
  const usable = signals.filter(Boolean);
  if (usable.length === 0) return undefined;
  if (usable.length === 1) return usable[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(usable);
  return usable[0];
}

/**
 * Translate one adapted request end to end.
 */
async function translate(adapted, { instruction, cookie, options, requestSignal, fetchImpl }) {
  const target = resolveTargetLanguage({
    explicit: adapted.target,
    instruction,
    contexts: adapted.contexts,
    fallback: options.targetLang,
  });
  const engine = resolveEngine(adapted.model);

  // `subtitle-context` stitches the cues of one sentence back together before
  // translating, so the upstream sees a whole sentence instead of fragments.
  // Every other mode keeps the one-unit-per-line contract untouched.
  const stitched = adapted.contextMode === "subtitle-context";
  const segments = stitched ? null : splitUnits(adapted.text, adapted.contextMode);
  const nodes = stitched
    ? mergeCues(splitUnits(adapted.text, "subtitle"), { maxChars: MAX_MERGED_CHARS })
    : null;
  const texts = stitched ? collectCues(nodes) : collectTexts(segments);
  if (texts.length === 0) {
    throw invalid("Translation input is empty.", "empty_translation_input");
  }
  withinLimits(adapted.text, texts);

  const batches = planBatches(texts);
  const totalSignal = combineSignals(timeoutSignal(options.totalTimeoutMs), requestSignal);
  // Batches run concurrently up to `maxConcurrency`; results keep the batch
  // order so `rebuild` still aligns one result per unit. A single batch still
  // runs alone, so short inputs behave exactly as before.
  const results = new Array(batches.length);
  let next = 0;
  const workers = Math.max(1, Math.min(options.maxConcurrency, batches.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < batches.length) {
        const index = next;
        next += 1;
        const batch = batches[index];
        const batchSignal = combineSignals(
          timeoutSignal(options.requestTimeoutMs),
          totalSignal,
          requestSignal,
        );
        results[index] = await translateBatch({
          texts: batch,
          target,
          engine,
          scene: adapted.scene,
          cookie,
          fetchImpl,
          signal: batchSignal,
          requestSignal,
          retries: options.maxRetries,
        });
      }
    }),
  );
  const flat = results.flat();
  if (flat.length !== texts.length) {
    throw upstreamError(
      "Doubao returned an incomplete translation.",
      "upstream_incomplete_result",
    );
  }
  return stitched ? rebuildCues(nodes, flat) : rebuild(segments, flat);
}

export const DoubaoTranslatePlugin = async (input, rawOptions) => {
  // Per-provider options (Settings → Plugins) win over package-level options.
  let providerOptions = rawOptions;
  try {
    const scoped = input?.magpie?.options?.(PROVIDER);
    if (scoped && typeof scoped === "object") providerOptions = { ...rawOptions, ...scoped };
  } catch {
    // The host may not expose scoped options; package-level options still apply.
  }
  const options = parseOptions(providerOptions);

  // Verify a Cookie by asking Doubao who it is. This both proves the session is
  // live and yields the account name for the login UI, with no translation
  // round-trip and no field for the user to type. Any non-auth failure (a
  // network hiccup, an odd payload) must not block a login the user cannot fix
  // right now, so only a real "session expired" answer is fatal.
  const inspect = async (getAuth) => {
    const cookie = cookieFor(await getAuth());
    try {
      return await fetchAccountInfo({
        cookie,
        signal: timeoutSignal(options.authTimeoutMs),
      });
    } catch (error) {
      if (error instanceof ServiceError && EXPIRED_CODES.has(error.code)) {
        throw Object.assign(
          new ServiceError(
            "upstream_auth_error",
            401,
            "Doubao login has expired. Sign in again with a new Cookie.",
          ),
          { signIn: "expired" },
        );
      }
      return { uid: "", name: "" };
    }
  };

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "Doubao Translation",
        npm: "@ai-sdk/openai-compatible",
        api: BASE_URL,
        models: defaultModels(),
      };
    },

    auth: {
      provider: PROVIDER,
      maxConcurrency: options.maxConcurrency,
      methods: [
        {
          type: "oauth",
          label: "Import Doubao Cookie",
          prompts: [
            {
              type: "text",
              key: "cookie",
              message: "Doubao sessionid (paste just the value)",
              validate: (value) => {
                try {
                  validateCookie(value);
                } catch {
                  return "Paste the sessionid value (or a Cookie header).";
                }
                return undefined;
              },
            },
          ],
          async authorize(inputs) {
            return {
              url: "",
              instructions: "Checking your Doubao Cookie.",
              method: "auto",
              async callback() {
                try {
                  const cookie = validateCookie(inputs?.cookie ?? "");
                  // Doubao tells us the account name; nothing is asked of the user.
                  const { uid, name } = await inspect(async () => ({ type: "api", key: cookie }));
                  const metadata = { email: name || "Doubao" };
                  if (uid) metadata.uid = uid;
                  return { type: "success", key: cookie, metadata };
                } catch (error) {
                  const message =
                    error instanceof ServiceError
                      ? error.message
                      : "Could not verify the Doubao Cookie.";
                  return { type: "failed", error: message };
                }
              },
            };
          },
        },
      ],

      async loader(getAuth) {
        return {
          baseURL: BASE_URL,
          apiKey: PLACEHOLDER_KEY,
          async fetch(url, init) {
            const request = new Request(url, init);
            const requestUrl = new URL(request.url);
            const protocol = protocolOf(requestUrl.pathname);
            try {
              request.signal.throwIfAborted();
              if (
                requestUrl.origin !== new URL(BASE_URL).origin ||
                request.method !== "POST" ||
                !protocol
              ) {
                throw invalid("Unsupported translation endpoint.");
              }
              const raw = await request.text();
              if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
                throw tooLarge("Translation request is too large.");
              }
              let body;
              try {
                body = JSON.parse(raw);
              } catch {
                throw invalid("Invalid request JSON.");
              }
              if (!body || typeof body !== "object" || Array.isArray(body)) {
                throw invalid("Invalid request body.");
              }
              const adapted = adaptRequest(protocol, body, {
                headers: request.headers,
                options,
              });
              adapted.scene ??= options.scene;

              // A Doubao translation request is a single user turn: strip the
              // "Translate to X:" prefix from the body so the upstream service
              // never sees the instruction as text to translate.
              const stripped = stripInstruction(adapted.text);
              adapted.text = stripped.body;

              const cookie = cookieFor(await getAuth());
              const fetchImpl = globalThis.fetch;
              const content = await translate(adapted, {
                instruction: stripped.instruction,
                cookie,
                options,
                requestSignal: request.signal,
                fetchImpl,
              });

              const id = randomUUID();
              if (adapted.stream) {
                return new Response(
                  renderStream(protocol, {
                    id,
                    model: adapted.model,
                    content,
                    includeUsage: adapted.includeUsage,
                  }),
                  {
                    headers: {
                      "Content-Type": "text/event-stream; charset=utf-8",
                      "Cache-Control": "no-cache",
                    },
                  },
                );
              }
              return Response.json(
                renderResponse(protocol, {
                  id,
                  model: adapted.model,
                  content,
                  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                }),
              );
            } catch (error) {
              if (request.signal.aborted) throw request.signal.reason;
              const aborted = abortError(error, { requestSignal: request.signal });
              return failure(aborted ?? error, protocol);
            }
          },
        };
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        // Listing models must never depend on the credential: an empty or
        // expired Cookie used to make the whole list fail. Probe only when a
        // key is actually present, and swallow failures so the list still
        // loads (the sign-in state is surfaced on the first real request).
        if (auth && auth.type === "api" && auth.key) {
          try {
            await inspect(async () => auth);
          } catch {
            // ignore: the model list is static
          }
        }
        return provider.models;
      },
    },
  };
};

export default DoubaoTranslatePlugin;
