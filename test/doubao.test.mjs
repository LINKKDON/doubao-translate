// Tests for src/doubao.mjs. Every network call goes through an injected
// `fetchImpl` and every wait through an injected `sleep`, so the suite is fast
// and never touches the wire.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCOUNT_INFO_URL,
  UPSTREAM_URL,
  DESKTOP_PARAMS,
  BROWSER_HEADERS,
  ENGINES,
  DEFAULT_MODEL,
  fetchAccountInfo,
  resolveEngine,
  resolveScene,
  validateCookie,
  buildUpstreamBody,
  parseUpstreamStream,
  translateBatch,
} from "../src/doubao.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COOKIE = "sessionid=abc123; sid_tt=def456; uid_tt=ghi789";

/** A batch result the upstream really sends: one SSE block per item. */
function sseFor(values) {
  return (
    values
      .map(
        (res, index) =>
          `event: json\ndata: ${JSON.stringify({
            code: 0,
            data: { items: [{ index, res }] },
          })}\n\n`,
      )
      .join("") + "event: done\ndata: {\"code\":0}\n\n"
  );
}

function okResponse(body, { headers = {}, chunks } = {}) {
  if (chunks) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers });
  }
  return new Response(body, { status: 200, headers });
}

function statusResponse(status, { body = "", headers = {} } = {}) {
  return new Response(body, { status, headers });
}

/** A fetch that answers with a fixed list of responses, in order. */
function fetchSequence(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(url, init);
    return next;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** Fast, deterministic call options for translateBatch. */
function baseOptions(overrides = {}) {
  return {
    texts: ["hello", "world"],
    target: "zh",
    engine: ENGINES["doubao-ai-translation"],
    scene: 2,
    cookie: COOKIE,
    sleep: async () => {},
    backoffMs: 0,
    ...overrides,
  };
}

async function rejectsWith(promise, code, status) {
  const error = await promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (reason) => reason,
  );
  assert.equal(error.name, "ServiceError", `expected ServiceError, got ${error.name}`);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  return error;
}

// ---------------------------------------------------------------------------
// Constants and engine resolution
// ---------------------------------------------------------------------------

test("constants: upstream URL, engine table and default model", () => {
  // The real web client always appends the desktop parameter block; a bare
  // path is a giveaway. Assert both the path and the required query keys.
  const url = new URL(UPSTREAM_URL);
  assert.equal(url.origin, "https://www.doubao.com");
  assert.equal(url.pathname, "/samantha/plugin/stream_article_translate");
  for (const [key, value] of Object.entries(DESKTOP_PARAMS)) {
    assert.equal(url.searchParams.get(key), value, `missing query param ${key}`);
  }
  assert.equal(DESKTOP_PARAMS.aid, "586864");
  assert.equal(DESKTOP_PARAMS.device_platform, "web");
  assert.equal(DESKTOP_PARAMS.version, "1.38.0");
  assert.equal(DESKTOP_PARAMS.version_code, "20800");
  assert.deepEqual({ ...ENGINES }, {
    "doubao-ai-translation": "1",
    "volcengine-translate": "0",
    "microsoft-translator": "3",
  });
  assert.equal(DEFAULT_MODEL, "doubao-ai-translation");
});

test("resolveEngine maps each known model to its translate_service", () => {
  assert.equal(resolveEngine("doubao-ai-translation"), "1");
  assert.equal(resolveEngine("volcengine-translate"), "0");
  assert.equal(resolveEngine("microsoft-translator"), "3");
  assert.equal(resolveEngine(), "1");
  assert.equal(resolveEngine(""), "1");
  assert.equal(resolveEngine("  doubao-ai-translation  "), "1");
  // model ids are matched case-insensitively
  assert.equal(resolveEngine("doubao-ai-translation"), "1");
  assert.equal(resolveEngine("DOUBAO-AI-TRANSLATION"), "1");
});

test("resolveEngine still accepts the pre-rename doubao-ai alias", () => {
  assert.equal(resolveEngine("doubao-ai"), "1");
  assert.equal(resolveEngine("DOUBAO-AI"), "1");
});

test("resolveEngine accepts the gateway's provider/model spelling", () => {
  assert.equal(resolveEngine("doubao-translation/doubao-ai-translation"), "1");
  assert.equal(
    resolveEngine("doubao-translation/volcengine-translate"),
    "0",
  );
  assert.equal(
    resolveEngine("  doubao-translation/microsoft-translator  "),
    "3",
  );
  // a prefix that is not a provider still resolves by its last segment
  assert.equal(resolveEngine("other/doubao-ai-translation"), "1");
  // an unknown last segment is still a 404
  assert.throws(() => resolveEngine("doubao-translation/gpt-4o"), /Unsupported model/);
});

test("resolveEngine: unknown model is 404 model_not_found", async () => {
  for (const model of ["gpt-4o", "doubao", "doubao-ai2", "toString"]) {
    await rejectsWith(
      Promise.resolve().then(() => resolveEngine(model)),
      "model_not_found",
      404,
    );
  }
});

test("resolveScene: 1-6 accepted, out of range is a 400, blank falls back", () => {
  assert.equal(resolveScene(1), 1);
  assert.equal(resolveScene("6"), 6);
  assert.equal(resolveScene(undefined), 2);
  assert.equal(resolveScene("", 3), 3);
  assert.throws(() => resolveScene(7), { code: "invalid_request", status: 400 });
  assert.throws(() => resolveScene(0), { code: "invalid_request", status: 400 });
  assert.throws(() => resolveScene(2.5), { code: "invalid_request", status: 400 });
  assert.throws(() => resolveScene(undefined, 9), {
    code: "configuration_error",
    status: 503,
  });
});

// ---------------------------------------------------------------------------
// Cookie validation
// ---------------------------------------------------------------------------

test("validateCookie strips the Cookie: prefix and trims", () => {
  assert.equal(validateCookie(COOKIE), COOKIE);
  assert.equal(validateCookie(`Cookie: ${COOKIE}`), COOKIE);
  assert.equal(validateCookie(`  cookie:   ${COOKIE}  `), COOKIE);
});

test("validateCookie rejects CR/LF header injection", async () => {
  await rejectsWith(
    Promise.resolve().then(() => validateCookie(`${COOKIE}\r\nX-Evil: 1`)),
    "configuration_error",
    503,
  );
  await rejectsWith(
    Promise.resolve().then(() => validateCookie(`${COOKIE}\nX-Evil: 1`)),
    "configuration_error",
    503,
  );
});

test("validateCookie requires only sessionid (or sessionid_ss)", async () => {
  const invalid = [
    "",
    "   ",
    "sid_tt=def456; uid_tt=ghi789",
    "not-a-cookie",
    "sessionid=; sid_tt=def456",
    "sessionid=   ",
  ];
  for (const raw of invalid) {
    const error = await rejectsWith(
      Promise.resolve().then(() => validateCookie(raw)),
      "configuration_error",
      503,
    );
    assert.equal(error.name, "ServiceError");
  }

  // sessionid alone is enough; the extra cookies are optional.
  assert.equal(validateCookie("sessionid=abc123"), "sessionid=abc123");
  assert.equal(
    validateCookie(`${COOKIE}`),
    COOKIE,
  );
  assert.equal(validateCookie("sessionid_ss=xyz"), "sessionid_ss=xyz");
  assert.equal(
    validateCookie("sessionid_ss=xyz; other=1"),
    "sessionid_ss=xyz; other=1",
  );
});

test("validateCookie accepts a bare sessionid value", () => {
  // Pasting just the value from the browser's cookie row is the common path.
  const id = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
  assert.equal(validateCookie(id), `sessionid=${id}`);
  assert.equal(validateCookie(`  ${id}  `), `sessionid=${id}`);
  assert.equal(validateCookie(`Cookie: ${id}`), `sessionid=${id}`);
  assert.equal(validateCookie("abc-DEF_123.xyz%41abcdef"), "sessionid=abc-DEF_123.xyz%41abcdef");

  // Short noise is still rejected instead of silently becoming a cookie name.
  assert.throws(() => validateCookie("not-a-cookie"), { name: "ServiceError" });
  assert.throws(() => validateCookie("sessionid="), { name: "ServiceError" });
});

test("validateCookie accepts a browser-exported Cookie JSON", () => {
  const exported = JSON.stringify([
    { name: "sessionid", value: "abc123", domain: ".doubao.com" },
    { name: "sid_tt", value: "def456", domain: ".doubao.com" },
  ]);
  const cookie = validateCookie(exported);
  assert.match(cookie, /sessionid=abc123/);
  assert.match(cookie, /sid_tt=def456/);

  const wrapped = JSON.stringify({ cookies: [{ name: "sessionid", value: "abc123" }] });
  assert.equal(validateCookie(wrapped), "sessionid=abc123");
});

// ---------------------------------------------------------------------------
// Account lookup (login verification + automatic account name)
// ---------------------------------------------------------------------------

test("fetchAccountInfo returns the uid and screen name", async () => {
  const fetchImpl = fetchSequence([
    okResponse(
      JSON.stringify({
        data: { user_id: 123456, user_id_str: "123456", screen_name: "Lin" },
        message: "success",
      }),
    ),
  ]);
  const account = await fetchAccountInfo({ cookie: COOKIE, fetchImpl });
  assert.deepEqual(account, { uid: "123456", name: "Lin" });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, ACCOUNT_INFO_URL);
  assert.equal(fetchImpl.calls[0].init.headers.cookie, COOKIE);
  assert.equal(fetchImpl.calls[0].init.method, "GET");
  assert.equal(fetchImpl.calls[0].init.headers["user-agent"], BROWSER_HEADERS["user-agent"]);
});

test("fetchAccountInfo falls back to name when screen_name is absent", async () => {
  const fetchImpl = fetchSequence([
    okResponse(JSON.stringify({ data: { user_id: 7, name: "Nick" } })),
  ]);
  assert.deepEqual(await fetchAccountInfo({ cookie: COOKIE, fetchImpl }), {
    uid: "7",
    name: "Nick",
  });
});

test("fetchAccountInfo reports an expired session as upstream_auth_error", async () => {
  const expired = JSON.stringify({
    data: { user_id: 0, error_code: 13, name: "account_info_error" },
    message: "error",
  });
  for (const body of [
    expired,
    JSON.stringify({ data: { user_id: 0, screen_name: "x" } }),
    JSON.stringify({ data: { user_id: 5, is_visitor_account: true } }),
    "<html>nope</html>",
  ]) {
    const fetchImpl = fetchSequence([okResponse(body)]);
    const error = await rejectsWith(
      fetchAccountInfo({ cookie: COOKIE, fetchImpl }),
      "upstream_auth_error",
      401,
    );
    assert.equal(error.name, "ServiceError");
  }
});

test("fetchAccountInfo treats a non-2xx status as an auth failure", async () => {
  const fetchImpl = fetchSequence([statusResponse(500, { body: "boom" })]);
  await rejectsWith(
    fetchAccountInfo({ cookie: COOKIE, fetchImpl }),
    "upstream_auth_error",
    401,
  );
});

test("fetchAccountInfo validates the cookie before touching the network", async () => {
  const fetchImpl = fetchSequence([okResponse("{}")]);
  await rejectsWith(
    fetchAccountInfo({ cookie: "not-a-cookie", fetchImpl }),
    "configuration_error",
    503,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("validateCookie rejects non-string input", async () => {
  await rejectsWith(
    Promise.resolve().then(() => validateCookie(undefined)),
    "configuration_error",
    503,
  );
});

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

test("buildUpstreamBody produces the upstream JSON shape", () => {
  assert.deepEqual(
    buildUpstreamBody({ texts: ["a", "b"], target: "ja", engine: "3", scene: 5 }),
    {
      raw_text: ["a", "b"],
      target_lang: "ja",
      translate_service: "3",
      scene: 5,
      frontend_source: 1,
    },
  );
  assert.equal(buildUpstreamBody({ texts: [], target: "zh", engine: "1" }).scene, 2);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("translateBatch posts the documented request and returns aligned strings", async () => {
  const fetchImpl = fetchSequence([okResponse(sseFor(["你好", "世界"]))]);

  const out = await translateBatch(
    baseOptions({ texts: ["hello", "world"], target: "zh", fetchImpl }),
  );

  assert.deepEqual(out, ["你好", "世界"]);
  assert.equal(fetchImpl.calls.length, 1);

  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, UPSTREAM_URL);
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "manual");
  assert.equal(init.headers["content-type"], "application/json");
  assert.equal(init.headers.accept, "text/event-stream");
  assert.equal(init.headers.cookie, COOKIE);
  // Every browser-shaped header must ride along, otherwise the upstream risk
  // engine sees a bare Node client.
  for (const key of ["user-agent", "origin", "referer", "accept-language", "agw-js-conv"]) {
    assert.equal(init.headers[key], BROWSER_HEADERS[key], `missing header ${key}`);
  }
  assert.match(init.headers["user-agent"], /Mozilla\/5\.0 .*Chrome\//);
  assert.equal(init.headers.origin, "https://www.doubao.com");
  assert.deepEqual(JSON.parse(init.body), {
    raw_text: ["hello", "world"],
    target_lang: "zh",
    translate_service: "1",
    scene: 2,
    frontend_source: 1,
  });
});

test("translateBatch returns [] for an empty batch without calling upstream", async () => {
  const fetchImpl = fetchSequence([okResponse("")]);
  const out = await translateBatch(baseOptions({ texts: [], fetchImpl }));
  assert.deepEqual(out, []);
  assert.equal(fetchImpl.calls.length, 0);
});

test("translateBatch streams a body in chunks and decodes them", async () => {
  const full = sseFor(["甲", "乙"]);
  const chunks = [full.slice(0, 25), full.slice(25, 70), full.slice(70)];
  const fetchImpl = fetchSequence([okResponse("", { chunks })]);
  const out = await translateBatch(baseOptions({ fetchImpl }));
  assert.deepEqual(out, ["甲", "乙"]);
});

test("translateBatch uses globalThis.fetch when fetchImpl is omitted", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return okResponse(sseFor(["x", "y"]));
  };
  try {
    const out = await translateBatch(
      baseOptions({ fetchImpl: undefined, sleep: async () => {} }),
    );
    assert.deepEqual(out, ["x", "y"]);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("translateBatch never reaches the global fetch when fetchImpl is injected", async () => {
  const original = globalThis.fetch;
  let globalCalls = 0;
  globalThis.fetch = () => {
    globalCalls += 1;
    throw new Error("the global fetch must not be used");
  };
  try {
    const fetchImpl = fetchSequence([okResponse(sseFor(["a", "b"]))]);
    const out = await translateBatch(baseOptions({ fetchImpl }));
    assert.deepEqual(out, ["a", "b"]);
    assert.equal(globalCalls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// 5xx retry
// ---------------------------------------------------------------------------

test("5xx is retried once and then succeeds", async () => {
  const fetchImpl = fetchSequence([
    statusResponse(503),
    okResponse(sseFor(["一", "二"])),
  ]);
  const out = await translateBatch(baseOptions({ fetchImpl }));
  assert.deepEqual(out, ["一", "二"]);
  assert.equal(fetchImpl.calls.length, 2);
});

test("5xx twice is 502 upstream_http_error", async () => {
  const fetchImpl = fetchSequence([statusResponse(500), statusResponse(502)]);
  await rejectsWith(
    translateBatch(baseOptions({ fetchImpl })),
    "upstream_http_error",
    502,
  );
  assert.equal(fetchImpl.calls.length, 2);
});

test("5xx retry waits a 200-399ms backoff by default", async () => {
  const waits = [];
  const fetchImpl = fetchSequence([
    statusResponse(500),
    okResponse(sseFor(["a", "b"])),
  ]);
  await translateBatch(
    baseOptions({
      fetchImpl,
      backoffMs: undefined,
      sleep: async (ms) => {
        waits.push(ms);
      },
    }),
  );
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 200 && waits[0] <= 399, `backoff was ${waits[0]}`);
});

test("retries: 0 disables the 5xx retry", async () => {
  const fetchImpl = fetchSequence([statusResponse(500)]);
  await rejectsWith(
    translateBatch(baseOptions({ fetchImpl, retries: 0 })),
    "upstream_http_error",
    502,
  );
  assert.equal(fetchImpl.calls.length, 1);
});

// ---------------------------------------------------------------------------
// 429
// ---------------------------------------------------------------------------

test("429 is upstream_rate_limit with a valid retry-after forwarded", async () => {
  const fetchImpl = fetchSequence([
    statusResponse(429, { headers: { "retry-after": " 7 " } }),
  ]);
  const error = await rejectsWith(
    translateBatch(baseOptions({ fetchImpl })),
    "upstream_rate_limit",
    429,
  );
  assert.deepEqual(error.headers, { "retry-after": "7" });
  assert.equal(fetchImpl.calls.length, 1, "429 must not be retried");
});

test("429 forwards an HTTP-date retry-after", async () => {
  const value = "Wed, 21 Oct 2026 07:28:00 GMT";
  const fetchImpl = fetchSequence([
    statusResponse(429, { headers: { "retry-after": value } }),
  ]);
  const error = await rejectsWith(
    translateBatch(baseOptions({ fetchImpl })),
    "upstream_rate_limit",
    429,
  );
  assert.deepEqual(error.headers, { "retry-after": value });
});

test("429 drops an invalid retry-after", async () => {
  for (const bad of ["soon", "-1", "1.5", "x".repeat(200)]) {
    const fetchImpl = fetchSequence([
      statusResponse(429, { headers: { "retry-after": bad } }),
    ]);
    const error = await rejectsWith(
      translateBatch(baseOptions({ fetchImpl })),
      "upstream_rate_limit",
      429,
    );
    assert.equal(error.headers, null, `retry-after ${JSON.stringify(bad)} leaked`);
  }
});

test("429 without retry-after has no headers", async () => {
  const fetchImpl = fetchSequence([statusResponse(429)]);
  const error = await rejectsWith(
    translateBatch(baseOptions({ fetchImpl })),
    "upstream_rate_limit",
    429,
  );
  assert.equal(error.headers, null);
});

test("a non-retryable 4xx is 502 upstream_http_error", async () => {
  const fetchImpl = fetchSequence([statusResponse(403)]);
  await rejectsWith(
    translateBatch(baseOptions({ fetchImpl })),
    "upstream_http_error",
    502,
  );
  assert.equal(fetchImpl.calls.length, 1);
});

// ---------------------------------------------------------------------------
// Empty / coded bodies
// ---------------------------------------------------------------------------

test("an empty body is 502 upstream_incomplete_result", async () => {
  const fetchImpl = fetchSequence([okResponse("   \n\n ")]);
  await rejectsWith(
    translateBatch(baseOptions({ fetchImpl })),
    "upstream_incomplete_result",
    502,
  );
});

test('{"code":710012001} is 502 upstream_auth_error', async () => {
  const fetchImpl = fetchSequence([
    okResponse(JSON.stringify({ code: 710012001, message: "login expired" })),
  ]);
  const error = await rejectsWith(
    translateBatch(baseOptions({ fetchImpl })),
    "upstream_auth_error",
    502,
  );
  assert.match(error.message, /expired/i);
});

test("the Doubao quota codes are 429 upstream_quota_exceeded", async () => {
  for (const code of [710022002, 710022013]) {
    const fetchImpl = fetchSequence([
      okResponse(JSON.stringify({ code, message: "tourist reach limited" })),
    ]);
    const error = await rejectsWith(
      translateBatch(baseOptions({ fetchImpl })),
      "upstream_quota_exceeded",
      429,
    );
    assert.match(error.message, /rate-limited/i);
  }
});

test("any other non-zero code is 502 upstream_stream_error", async () => {
  for (const code of [1, 400, 710012002, -1]) {
    const fetchImpl = fetchSequence([
      okResponse(JSON.stringify({ code, message: "nope" })),
    ]);
    await rejectsWith(
      translateBatch(baseOptions({ fetchImpl })),
      "upstream_stream_error",
      502,
    );
  }
});

test("an HTML body with no SSE items is 502 upstream_incomplete_result", async () => {
  // Worker parity: a body that is not `{...}` is parsed as SSE; no `data:` line
  // yields no items, which is "incomplete", not "malformed".
  const fetchImpl = fetchSequence([okResponse("<html>bad gateway</html>")]);
  await rejectsWith(
    translateBatch(baseOptions({ fetchImpl })),
    "upstream_incomplete_result",
    502,
  );
});

test("an SSE data payload that is not JSON is 502 upstream_stream_error", async () => {
  const fetchImpl = fetchSequence([okResponse("event: json\ndata: <html>\n\n")]);
  await rejectsWith(
    translateBatch(baseOptions({ fetchImpl })),
    "upstream_stream_error",
    502,
  );
});

// ---------------------------------------------------------------------------
// SSE item validation
// ---------------------------------------------------------------------------

test("SSE item index out of range is 502 upstream_stream_error", async () => {
  const body = `event: json\ndata: ${JSON.stringify({
    code: 0,
    data: { items: [{ index: 2, res: "x" }] },
  })}\n\n`;
  const fetchImpl = fetchSequence([okResponse(body)]);
  await rejectsWith(
    translateBatch(baseOptions({ fetchImpl })),
    "upstream_stream_error",
    502,
  );
});

test("SSE item with a non-integer index is 502 upstream_stream_error", async () => {
  for (const index of [0.5, "0", null, undefined]) {
    const body = `event: json\ndata: ${JSON.stringify({
      code: 0,
      data: { items: [{ index, res: "x" }] },
    })}\n\n`;
    const fetchImpl = fetchSequence([okResponse(body)]);
    await rejectsWith(
      translateBatch(baseOptions({ fetchImpl })),
      "upstream_stream_error",
      502,
    );
  }
});

test("SSE item without res is 502 upstream_stream_error", async () => {
  for (const res of [undefined, "", "   ", 42]) {
    const body = `event: json\ndata: ${JSON.stringify({
      code: 0,
      data: { items: [{ index: 0, res }] },
    })}\n\n`;
    const fetchImpl = fetchSequence([okResponse(body)]);
    await rejectsWith(
      translateBatch(baseOptions({ fetchImpl })),
      "upstream_stream_error",
      502,
    );
  }
});

test("event: err is 502 upstream_stream_error", async () => {
  const body = `event: err\ndata: ${JSON.stringify({ code: 0, message: "boom" })}\n\n`;
  const fetchImpl = fetchSequence([okResponse(body)]);
  await rejectsWith(
    translateBatch(baseOptions({ fetchImpl })),
    "upstream_stream_error",
    502,
  );
});

test("a short index set is 502 upstream_incomplete_result", async () => {
  const body = `event: json\ndata: ${JSON.stringify({
    code: 0,
    data: { items: [{ index: 0, res: "only one" }] },
  })}\n\n`;
  const fetchImpl = fetchSequence([okResponse(body)]);
  await rejectsWith(
    translateBatch(baseOptions({ fetchImpl })),
    "upstream_incomplete_result",
    502,
  );
});

// ---------------------------------------------------------------------------
// Timeout and cancellation
// ---------------------------------------------------------------------------

test("a timeout is 504 upstream_timeout", async () => {
  const controller = new AbortController();
  const fetchImpl = async (url, init) => {
    controller.abort();
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  await rejectsWith(
    translateBatch(
      baseOptions({ fetchImpl, signal: controller.signal, sleep: async () => {} }),
    ),
    "upstream_timeout",
    504,
  );
});

test("a real AbortSignal.timeout produces 504 upstream_timeout", async () => {
  const signal = AbortSignal.timeout(5);
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), {
        once: true,
      });
    });
  await rejectsWith(
    translateBatch(baseOptions({ fetchImpl, signal })),
    "upstream_timeout",
    504,
  );
});

test("an aborted requestSignal is 499 request_cancelled before any fetch", async () => {
  const fetchImpl = fetchSequence([okResponse(sseFor(["a", "b"]))]);
  await rejectsWith(
    translateBatch(
      baseOptions({ fetchImpl, requestSignal: AbortSignal.abort() }),
    ),
    "request_cancelled",
    499,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("an abort raised mid-flight is 499 request_cancelled", async () => {
  const controller = new AbortController();
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
      controller.abort();
    });
  const error = await rejectsWith(
    translateBatch(
      baseOptions({
        fetchImpl,
        signal: controller.signal,
        requestSignal: controller.signal,
        sleep: async () => {},
      }),
    ),
    "request_cancelled",
    499,
  );
  assert.equal(error.status, 499);
});

test("cancellation while waiting out a 5xx backoff is 499", async () => {
  const controller = new AbortController();
  const fetchImpl = fetchSequence([statusResponse(500)]);
  await rejectsWith(
    translateBatch(
      baseOptions({
        fetchImpl,
        signal: controller.signal,
        requestSignal: controller.signal,
        backoffMs: 5,
        sleep: async () => {
          controller.abort();
        },
      }),
    ),
    "request_cancelled",
    499,
  );
  assert.equal(fetchImpl.calls.length, 1);
});

// ---------------------------------------------------------------------------
// Network errors
// ---------------------------------------------------------------------------

test("a network TypeError is retried once and then succeeds", async () => {
  const fetchImpl = fetchSequence([
    new TypeError("fetch failed"),
    okResponse(sseFor(["a", "b"])),
  ]);
  const out = await translateBatch(baseOptions({ fetchImpl }));
  assert.deepEqual(out, ["a", "b"]);
  assert.equal(fetchImpl.calls.length, 2);
});

test("a network TypeError twice is 502 upstream_network_error", async () => {
  const fetchImpl = fetchSequence([
    new TypeError("fetch failed"),
    new TypeError("fetch failed"),
  ]);
  await rejectsWith(
    translateBatch(baseOptions({ fetchImpl })),
    "upstream_network_error",
    502,
  );
  assert.equal(fetchImpl.calls.length, 2);
});

test("the retry budget is shared between a 5xx and a network error", async () => {
  const fetchImpl = fetchSequence([statusResponse(500), new TypeError("down")]);
  await rejectsWith(
    translateBatch(baseOptions({ fetchImpl })),
    "upstream_network_error",
    502,
  );
  assert.equal(fetchImpl.calls.length, 2, "a third attempt must not happen");
});

// ---------------------------------------------------------------------------
// parseUpstreamStream in isolation
// ---------------------------------------------------------------------------

test("parseUpstreamStream aligns by index regardless of arrival order", () => {
  const body =
    `event: json\ndata: ${JSON.stringify({
      code: 0,
      data: { items: [{ index: 2, res: "c" }, { index: 0, res: "a" }] },
    })}\n\n` +
    `event: message\ndata: ${JSON.stringify({
      code: 0,
      data: { items: [{ index: 1, res: "b" }] },
    })}\n\n`;
  assert.deepEqual(parseUpstreamStream(body, 3), ["a", "b", "c"]);
});

test("parseUpstreamStream accepts a stream without [DONE] or event: done", () => {
  const body = `data: ${JSON.stringify({
    code: 0,
    data: { items: [{ index: 0, res: "solo" }] },
  })}\n\n`;
  assert.deepEqual(parseUpstreamStream(body, 1), ["solo"]);
});

test("parseUpstreamStream ignores [DONE] and unknown events", () => {
  const body =
    `event: ping\ndata: {"keepalive":true}\n\n` +
    `: comment line\n\n` +
    `data: [DONE]\n\n` +
    `event: json\ndata: ${JSON.stringify({
      code: 0,
      data: { items: [{ index: 0, res: "a" }, { index: 1, res: "b" }] },
    })}\n\n` +
    `event: done\ndata: [DONE]\n\n`;
  assert.deepEqual(parseUpstreamStream(body, 2), ["a", "b"]);
});

test("parseUpstreamStream validates the code inside event: done", async () => {
  const body = `event: done\ndata: ${JSON.stringify({ code: 710012001 })}\n\n`;
  await rejectsWith(
    Promise.resolve().then(() => parseUpstreamStream(body, 1)),
    "upstream_auth_error",
    502,
  );
  const other = `event: done\ndata: ${JSON.stringify({ code: 5 })}\n\n`;
  await rejectsWith(
    Promise.resolve().then(() => parseUpstreamStream(other, 1)),
    "upstream_stream_error",
    502,
  );
});

test("parseUpstreamStream tolerates CRLF line endings", () => {
  const body = `event: json\r\ndata: ${JSON.stringify({
    code: 0,
    data: { items: [{ index: 0, res: "crlf" }] },
  })}\r\n\r\n`;
  assert.deepEqual(parseUpstreamStream(body, 1), ["crlf"]);
});

test("parseUpstreamStream returns [] for zero expected", () => {
  assert.deepEqual(parseUpstreamStream("event: done\ndata: {}\n\n", 0), []);
});

test("parseUpstreamStream rejects a bad expected count", async () => {
  await rejectsWith(
    Promise.resolve().then(() => parseUpstreamStream("", -1)),
    "invalid_request",
    400,
  );
});

// ---------------------------------------------------------------------------
// Guard rails
// ---------------------------------------------------------------------------

test("translateBatch validates the cookie before touching the network", async () => {
  const fetchImpl = fetchSequence([okResponse(sseFor(["a", "b"]))]);
  await rejectsWith(
    translateBatch(baseOptions({ fetchImpl, cookie: "not-a-cookie" })),
    "configuration_error",
    503,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("translateBatch rejects a non-array texts argument", async () => {
  const fetchImpl = fetchSequence([okResponse("")]);
  await rejectsWith(
    translateBatch(baseOptions({ fetchImpl, texts: "hello" })),
    "invalid_request",
    400,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("validateCookie repairs a malformed header instead of passing it through", () => {
  // Spaces around `=` and empty values confuse the upstream into a 401, so they
  // are normalized; a well-formed header keeps its exact bytes.
  assert.equal(validateCookie(" sessionid = spaced "), "sessionid=spaced");
  assert.equal(validateCookie("sessionid=; sessionid_ss=x"), "sessionid_ss=x");
  assert.equal(validateCookie("sessionid=abc; foo=bar"), "sessionid=abc; foo=bar");
});

test("validateCookie never drops a base64 value while rebuilding", () => {
  // A rebuild (triggered by some other malformed part) must keep `=` padding.
  assert.equal(validateCookie("sessionid=abc==; stray"), "sessionid=abc==");
  assert.equal(
    validateCookie("sessionid = spaced; ttwid=def=="),
    "sessionid=spaced; ttwid=def==",
  );
});

test("validateCookie keeps the last of duplicate cookie names", () => {
  assert.equal(validateCookie("sessionid=a; sessionid=b; bad"), "sessionid=b");
});

test("validateCookie trims padded names in a JSON export", () => {
  assert.equal(
    validateCookie(JSON.stringify([{ name: " sessionid ", value: " abc " }])),
    "sessionid=abc",
  );
});

test("validateCookie rejects a JSON export that hides a newline in a value", () => {
  assert.throws(
    () => validateCookie(JSON.stringify([{ name: "sessionid", value: "abc\nX: 1" }])),
    (error) => error.code === "configuration_error",
  );
});
