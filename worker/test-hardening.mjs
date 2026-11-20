import worker from "./worker.js";

const env = {
  API_KEY: "1234567890abcdef",
  DOUBAO_SESSION_ID: "sessionid=fake; sid_tt=fake; uid_tt=fake",
  DOUBAO_DEFAULT_TARGET_LANG: "zh",
  DOUBAO_MAX_CONCURRENCY: "4",
};

const originalFetch = globalThis.fetch;
let calls = 0;
let pass = 0;
let fail = 0;
const unhandled = [];
process.on("unhandledRejection", (error) => {
  unhandled.push(String(error));
});

function sse(items, { done = true } = {}) {
  const chunks = items.map(
    (item) =>
      `event: json\ndata: ${JSON.stringify({
        code: 0,
        data: { items: [item] },
      })}\n\n`,
  );
  if (done) chunks.push("data: [DONE]\n\n");
  return chunks.join("");
}

function upstream(items, options) {
  return new Response(sse(items, options), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function call(content, options = {}) {
  const request = new Request(
    options.url ?? "https://worker.example/v1/chat/completions",
    {
      method: options.method ?? "POST",
      headers: {
        authorization: `Bearer ${env.API_KEY}`,
        "content-type": "application/json",
        ...(options.headers ?? {}),
      },
      body:
        (options.method ?? "POST") === "GET"
          ? undefined
          : (options.body ??
            JSON.stringify({
              model: "doubao-ai",
              messages: [{ role: "user", content }],
            })),
    },
  );
  const response = await worker.fetch(request, options.env ?? env);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return {
    status: response.status,
    headers: response.headers,
    json,
    text,
  };
}

function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}  ${detail}`);
  }
}

function echoCalls() {
  calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    return upstream(
      body.raw_text.map((_, index) => ({
        index,
        res: `T${index}`,
      })),
    );
  };
}

echoCalls();
let result = await call("Translate into Chinese\nhello world");
check(
  "directive without colon is removed",
  result.status === 200 &&
    result.json.choices?.[0]?.message?.content === "T0",
  JSON.stringify({ status: result.status, body: result.json }),
);

globalThis.fetch = async (_url, init) => {
  calls += 1;
  const body = JSON.parse(init.body);
  check(
    "directive without colon does not enter upstream raw_text",
    body.raw_text[0] === "hello world",
    JSON.stringify(body.raw_text),
  );
  return upstream([{ index: 0, res: "你好世界" }]);
};
result = await call("Translate into Chinese\nhello world");
check(
  "directive without colon resolves target language",
  result.status === 200 &&
    result.json.choices?.[0]?.message?.content === "你好世界",
  JSON.stringify(result.json),
);

globalThis.fetch = async (_url, init) => {
  calls += 1;
  const body = JSON.parse(init.body);
  return upstream([{ index: 0, res: `译文:${body.raw_text[0]}` }]);
};
result = await call("翻译成日语\n你好");
check(
  "Chinese directive without colon is parsed",
  result.status === 200 &&
    result.json.choices?.[0]?.message?.content === "译文:你好",
  JSON.stringify(result.json),
);

calls = 0;
globalThis.fetch = async (_url, init) => {
  calls += 1;
  if (calls === 1) {
    return new Response("limited", {
      status: 429,
      headers: { "retry-after": "7" },
    });
  }
  throw new Error("429 must not be retried");
};
result = await call("Translate into Chinese:\nhello");
check(
  "429 uses rate_limit_error and propagates Retry-After",
  result.status === 429 &&
    result.json?.error?.type === "rate_limit_error" &&
    result.headers.get("retry-after") === "7" &&
    calls === 1,
  JSON.stringify({
    status: result.status,
    type: result.json?.error?.type,
    retryAfter: result.headers.get("retry-after"),
    calls,
  }),
);
check(
  "CORS exposes retry-after and x-request-id",
  result.headers
    .get("access-control-expose-headers")
    ?.includes("retry-after") &&
    result.headers.get("x-request-id")?.length > 0,
  JSON.stringify(Object.fromEntries(result.headers)),
);

for (const status of [500, 502, 503]) {
  calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    if (calls === 1) return new Response("temporary", { status });
    const body = JSON.parse(init.body);
    return upstream(
      body.raw_text.map((_, index) => ({ index, res: `ok${index}` })),
    );
  };
  result = await call("Translate into Chinese:\nhello");
  check(
    `${status} is retried once and recovers`,
    result.status === 200 && calls === 2,
    JSON.stringify({ status: result.status, calls }),
  );
}

calls = 0;
globalThis.fetch = async () => {
  calls += 1;
  throw new TypeError("network down");
};
result = await call("Translate into Chinese:\nhello");
check(
  "network error is retried once",
  result.status === 502 &&
    result.json?.error?.code === "upstream_network_error" &&
    calls === 2,
  JSON.stringify({ status: result.status, calls, body: result.json }),
);

for (const status of [500, 503]) {
  calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("still failing", { status });
  };
  result = await call("Translate into Chinese:\nhello");
  check(
    `${status} retries only once before returning 502`,
    result.status === 502 &&
      result.json?.error?.code === "upstream_http_error" &&
      calls === 2,
    JSON.stringify({ status: result.status, calls, body: result.json }),
  );
}

calls = 0;
globalThis.fetch = async (_url, init) => {
  calls += 1;
  if (calls === 1) throw new TypeError("temporary network failure");
  const body = JSON.parse(init.body);
  return upstream(
    body.raw_text.map((_, index) => ({ index, res: `recovered${index}` })),
  );
};
result = await call("Translate into Chinese:\nhello");
check(
  "network error can recover on the retry",
  result.status === 200 &&
    result.json.choices?.[0]?.message?.content === "recovered0" &&
    calls === 2,
  JSON.stringify({ status: result.status, calls, body: result.json }),
);

calls = 0;
globalThis.fetch = async () => {
  calls += 1;
  return new Response("bad request", { status: 400 });
};
result = await call("Translate into Chinese:\nhello");
check(
  "non-retryable upstream 4xx is not retried",
  result.status === 502 && calls === 1,
  JSON.stringify({ status: result.status, calls, body: result.json }),
);

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  return upstream(
    body.raw_text.map((_, index) => ({ index, res: `ok${index}` })),
    { done: false },
  );
};
result = await call("Translate into Chinese:\nhello");
check(
  "complete indexes are accepted without [DONE]",
  result.status === 200 &&
    result.json.choices?.[0]?.message?.content === "ok0",
  JSON.stringify({ status: result.status, body: result.json }),
);

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  return upstream([{ index: 0, res: "only first" }], { done: false });
};
result = await call("Translate into Chinese:\nfirst\nsecond");
check(
  "missing indexes still fail without [DONE]",
  result.status === 502 &&
    result.json?.error?.code === "upstream_incomplete_result",
  JSON.stringify({ status: result.status, body: result.json }),
);

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  return upstream(
    body.raw_text.map((_, index) => ({ index, res: `ok${index}` })),
  );
};
result = await call("Translate into Chinese:\nhello");
check(
  "request id is returned",
  result.status === 200 && /^[0-9a-f-]{36}$/.test(result.headers.get("x-request-id")),
  result.headers.get("x-request-id"),
);

result = await call("", {
  url: "https://worker.example/health",
  method: "GET",
});
check(
  "health endpoint remains available",
  result.status === 200 && result.json?.status === "ok",
  JSON.stringify(result.json),
);

let attemptsByText = new Map();
calls = 0;
globalThis.fetch = async (_url, init) => {
  calls += 1;
  const body = JSON.parse(init.body);
  const key = body.raw_text[0];
  const attempts = (attemptsByText.get(key) ?? 0) + 1;
  attemptsByText.set(key, attempts);
  if (key === "Line 1" && attempts === 1) {
    return new Response("temporary", { status: 500 });
  }
  return upstream(
    body.raw_text.map((text, index) => ({
      index,
      res: `T[${text}]`,
    })),
  );
};
result = await call(
  `Translate into Chinese:\n${Array.from(
    { length: 51 },
    (_, index) => `Line ${index + 1}`,
  ).join("\n")}`,
);
const concurrentContent = result.json.choices?.[0]?.message?.content ?? "";
check(
  "concurrent batch retry preserves order",
  result.status === 200 &&
    calls === 3 &&
    concurrentContent.indexOf("T[Line 1]") <
      concurrentContent.indexOf("T[Line 51]"),
  JSON.stringify({ status: result.status, calls }),
);

let capturedRawText;
let preservedRawText;
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  capturedRawText = body.raw_text;
  return upstream(
    body.raw_text.map((text, index) => ({
      index,
      res: `T[${text}]`,
    })),
  );
};
result = await call("Translate into Chinese:\nfirst line\nsecond line", {
  headers: { "x-doubao-context-mode": "default" },
});
check(
  "default mode still splits internal line breaks",
  result.status === 200 &&
    JSON.stringify(capturedRawText) ===
      JSON.stringify(["first line", "second line"]),
  JSON.stringify({ status: result.status, rawText: capturedRawText }),
);

capturedRawText = undefined;
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  capturedRawText = body.raw_text;
  return upstream(
    body.raw_text.map((rawText, index) => ({
      index,
      res: `T[${rawText}]`,
    })),
  );
};
result = await call("Translate into Chinese:\nfirst line\nsecond line", {
  headers: { "x-doubao-context-mode": "subtitle" },
});
check(
  "subtitle mode keeps one cue's internal line breaks together",
  result.status === 200 &&
    JSON.stringify(capturedRawText) ===
      JSON.stringify(["first line\nsecond line"]),
  JSON.stringify({ status: result.status, rawText: capturedRawText }),
);

capturedRawText = undefined;
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  capturedRawText = body.raw_text;
  return upstream(
    body.raw_text.map((text, index) => ({
      index,
      res: text,
    })),
  );
};
result = await call(
  "Translate into Chinese:\nfirst cue\n\n%%\n\nsecond cue",
  { headers: { "x-doubao-context-mode": "subtitle" } },
);
check(
  "subtitle mode keeps %% as cue boundaries",
  result.status === 200 &&
    JSON.stringify(capturedRawText) ===
      JSON.stringify(["first cue", "second cue"]) &&
    result.json.choices?.[0]?.message?.content.includes("%%"),
  JSON.stringify({
    status: result.status,
    rawText: capturedRawText,
    content: result.json?.choices?.[0]?.message?.content,
  }),
);

capturedRawText = undefined;
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  capturedRawText = body.raw_text;
  return upstream(
    body.raw_text.map((text, index) => ({
      index,
      res: text,
    })),
  );
};
result = await call(
  "Translate into Chinese:\nfirst cue\nline two\n\n%%\n\nsecond cue",
  { headers: { "x-doubao-context-mode": "subtitle-context" } },
);
check(
  "subtitle-context stitches cues into one whole sentence upstream",
  result.status === 200 &&
    JSON.stringify(capturedRawText) ===
      JSON.stringify(["first cue\nline two second cue"]) &&
    result.json.choices?.[0]?.message?.content ===
      "first cue\n\n%%\n\nline two second cue",
  JSON.stringify({ status: result.status, rawText: capturedRawText }),
);

calls = 0;
globalThis.fetch = async () => {
  calls += 1;
  return upstream([{ index: 0, res: "unused" }]);
};
result = await call(
  `Translate into Chinese:\n${"a".repeat(10001)}`,
  { headers: { "x-doubao-context-mode": "subtitle" } },
);
check(
  "subtitle mode rejects a cue over 10,000 characters before upstream",
  result.status === 413 &&
    result.json?.error?.code === "request_too_large" &&
    calls === 0,
  JSON.stringify({ status: result.status, calls, body: result.json }),
);

result = await call(
  `Translate into Chinese:\n${"a".repeat(10001)}`,
  { headers: { "x-doubao-context-mode": "subtitle-context" } },
);
check(
  "subtitle-context mode rejects a cue over 10,000 characters before upstream",
  result.status === 413 &&
    result.json?.error?.code === "request_too_large" &&
    calls === 0,
  JSON.stringify({ status: result.status, calls, body: result.json }),
);

calls = 0;
globalThis.fetch = async () => {
  calls += 1;
  return upstream([{ index: 0, res: "unused" }]);
};
result = await call("Translate into Chinese:\nhello", {
  headers: { "x-doubao-context-mode": "unknown" },
});
check(
  "invalid context mode is rejected before upstream",
  result.status === 400 &&
    result.json?.error?.code === "invalid_request" &&
    calls === 0,
  JSON.stringify({ status: result.status, calls, body: result.json }),
);

const contextEchoFetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  preservedRawText = body.raw_text;
  return upstream(body.raw_text.map((text, index) => ({ index, res: text })));
};

globalThis.fetch = contextEchoFetch;
const crlfCue = "Translate to Chinese:\r\nfirst\r\nsecond\r\n\r\n%%\r\n\r\nthird";
result = await call(crlfCue, {
  headers: { "x-doubao-context-mode": "subtitle" },
});
check(
  "subtitle mode preserves CRLF and cue separators verbatim",
  result.status === 200 &&
    JSON.stringify(preservedRawText) ===
      JSON.stringify(["first\r\nsecond", "third"]) &&
    result.json.choices?.[0]?.message?.content ===
      "first\r\nsecond\r\n\r\n%%\r\n\r\nthird",
  JSON.stringify({ status: result.status, rawText: preservedRawText, body: result.json, expected: ["first\r\nsecond", "third"] }),
);

const spacedCue = "Translate to Chinese:\nfirst\n\n\n\nsecond";
result = await call(spacedCue, {
  headers: { "x-doubao-context-mode": "subtitle" },
});
check(
  "subtitle mode preserves consecutive blank lines",
  result.status === 200 &&
    result.json.choices?.[0]?.message?.content === "first\n\n\n\nsecond",
  JSON.stringify({ status: result.status, body: result.json }),
);

const paddedContext = "Translate to Chinese:\n\nI told him that\n\n%%\n\nwe should leave before\n\n%%\n\nthe storm hits.";
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  capturedRawText = body.raw_text;
  return upstream(
    body.raw_text.map((text, index) => ({
      index,
      res:
        index === 0
          ? "我告诉他\n我们应该在\n暴风雨来临前离开。"
          : text,
    })),
  );
};
result = await call(paddedContext, {
  headers: { "x-doubao-context-mode": "subtitle-context" },
});
check(
  "subtitle-context stitches a split sentence and rebuilds every cue",
  result.status === 200 &&
    JSON.stringify(capturedRawText) ===
      JSON.stringify([
        "I told him that we should leave before the storm hits.",
      ]) &&
    result.json.choices?.[0]?.message?.content ===
      "我告诉他\n\n%%\n\n我们应该在\n\n%%\n\n暴风雨来临前离开。",
  JSON.stringify({ status: result.status, body: result.json }),
);

// Translations that do NOT echo %%; alignment must come from the index, not the text.
globalThis.fetch = async () =>
  upstream([{ index: 0, res: "第一第二" }]);
result = await call("Translate to Chinese:\nfirst\n\n%%\n\nsecond", {
  headers: { "x-doubao-context-mode": "subtitle-context" },
});
check(
  "subtitle-context aligns by index instead of requiring %% in the translation",
  result.status === 200 &&
    result.json?.choices?.[0]?.message?.content === "第一\n\n%%\n\n第二",
  JSON.stringify({ status: result.status, body: result.json }),
);

// A very short translation must still reach every cue without losing characters.
globalThis.fetch = async () =>
  upstream([{ index: 0, res: "译" }]);
result = await call("Translate to Chinese:\na\n\n%%\n\nb\n\n%%\n\nc", {
  headers: { "x-doubao-context-mode": "subtitle-context" },
});
check(
  "subtitle-context keeps a one-character translation when spread over three cues",
  result.status === 200 &&
    (result.json?.choices?.[0]?.message?.content ?? "").replace(/\n\n%%\n\n/g, "") === "译",
  JSON.stringify({ status: result.status, body: result.json }),
);

// --- subtitle-context parity with subtitle (regression for the 5-cue 502) ---

const fiveCues = [
  "Good morning, everyone.",
  "Today we are going to talk about\nthe ocean.",
  "It covers most of our planet.",
  "But we have explored\nvery little of it.",
  "That is what makes it fascinating.",
];
const fiveCueBody = `Translate to Chinese:\n\n\n${fiveCues.join("\n\n%%\n\n")}`;

for (const mode of ["subtitle", "subtitle-context"]) {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    capturedRawText = body.raw_text;
    // Upstream returns translations with no %% at all, like the real endpoint.
    return upstream(
      body.raw_text.map((text, index) => ({ index, res: `译${index}：${text}` })),
    );
  };
  result = await call(fiveCueBody, {
    headers: { "x-doubao-context-mode": mode },
  });
  const out = result.json?.choices?.[0]?.message?.content ?? "";
  const parts = out.split("\n\n%%\n\n");
  check(
    `${mode} keeps a 5-cue batch index-aligned when upstream omits %%`,
    result.status === 200 &&
      capturedRawText.length === 5 &&
      parts.length === 5 &&
      // Directive separator newlines are stripped, so cue 0 starts clean.
      parts[0] === "译0：Good morning, everyone." &&
      parts[1] === "译1：Today we are going to talk about\nthe ocean." &&
      parts[4] === "译4：That is what makes it fascinating.",
    JSON.stringify({ status: result.status, rawText: capturedRawText, parts }),
  );
}

// Cues that repeat identical text must not collapse into one another.
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  return upstream(
    body.raw_text.map((_text, index) => ({ index, res: `第${index + 1}条` })),
  );
};
result = await call("Translate to Chinese:\nSame.\n\n%%\n\nSame.\n\n%%\n\nSame.", {
  headers: { "x-doubao-context-mode": "subtitle-context" },
});
check(
  "duplicate cues stay separate units",
  result.status === 200 &&
    result.json?.choices?.[0]?.message?.content === "第1条\n\n%%\n\n第2条\n\n%%\n\n第3条",
  JSON.stringify({ status: result.status, body: result.json }),
);

// A cue made only of whitespace must not become an empty upstream slot.
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  capturedRawText = body.raw_text;
  return upstream(body.raw_text.map((_text, index) => ({ index, res: `译${index}` })));
};
result = await call("Translate to Chinese:\nfirst\n\n%%\n\n   \n\n%%\n\nthird", {
  headers: { "x-doubao-context-mode": "subtitle-context" },
});
check(
  "blank-only cue is folded into the separator, not sent upstream",
  // Stitching joins the two cue fragments into one sentence ("first" has no
  // sentence-ending punctuation), but the blank cue itself never travels up.
  result.status === 200 &&
    JSON.stringify(capturedRawText) === JSON.stringify(["first third"]),
  JSON.stringify({ status: result.status, rawText: capturedRawText }),
);

// --- %% boundaries: first-line %% and adjacent %% never leak upstream ---
{
  let leaked = null;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    leaked = body.raw_text;
    return upstream(body.raw_text.map((_t, index) => ({ index, res: `译${index}` })));
  };
  result = await call("%%\n\nfirst cue");
  check(
    "a leading %% line is a boundary, not part of the cue",
    result.status === 200 && JSON.stringify(leaked) === JSON.stringify(["first cue"]),
    JSON.stringify({ status: result.status, rawText: leaked }),
  );
  result = await call("a\n\n%%\n%%\n\nb");
  check(
    "adjacent %% lines never leak a %% into the text",
    result.status === 200 && JSON.stringify(leaked) === JSON.stringify(["a", "b"]),
    JSON.stringify({ status: result.status, rawText: leaked }),
  );
}

// --- webpage translation regression: default mode must stay line-based ---

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  capturedRawText = body.raw_text;
  return upstream(body.raw_text.map((text, index) => ({ index, res: `中${index}` })));
};
result = await call(
  "Translate to Chinese:\nFirst paragraph.\nSecond line.\n\nThird paragraph.",
);
check(
  "webpage default mode still splits every non-empty line",
  result.status === 200 &&
    JSON.stringify(capturedRawText) ===
      JSON.stringify(["First paragraph.", "Second line.", "Third paragraph."]) &&
    result.json?.choices?.[0]?.message?.content ===
      "中0\n中1\n\n中2",
  JSON.stringify({ status: result.status, rawText: capturedRawText, body: result.json }),
);

globalThis.fetch = async () =>
  new Response("limited", {
    status: 429,
    headers: { "retry-after": "not-a-valid-retry-after" },
  });
result = await call("Translate to Chinese:\nhello");
check(
  "invalid Retry-After is not propagated",
  result.status === 429 && result.headers.get("retry-after") === null,
  JSON.stringify({ status: result.status, headers: Object.fromEntries(result.headers) }),
);

globalThis.fetch = async () =>
  new Response("limited", {
    status: 429,
    headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
  });
result = await call("Translate to Chinese:\nhello");
check(
  "HTTP-date Retry-After is propagated",
  result.status === 429 &&
    result.headers.get("retry-after") === "Wed, 21 Oct 2026 07:28:00 GMT",
  JSON.stringify({ status: result.status, headers: Object.fromEntries(result.headers) }),
);

calls = 0;
globalThis.fetch = async (_url, init) => {
  calls += 1;
  const error = new Error("aborted");
  error.name = "AbortError";
  throw error;
};
const controller = new AbortController();
controller.abort();
const cancelledRequest = new Request("https://worker.example/v1/chat/completions", {
  method: "POST",
  signal: controller.signal,
  headers: {
    authorization: `Bearer ${env.API_KEY}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    messages: [{ role: "user", content: "Translate to Chinese:\nhello" }],
  }),
});
const cancelledResponse = await worker.fetch(cancelledRequest, env);
const cancelledBody = await cancelledResponse.json();
check(
  "client cancellation is not reported as an upstream timeout",
  cancelledResponse.status === 499 &&
    cancelledBody.error?.code === "request_cancelled",
  JSON.stringify({ status: cancelledResponse.status, body: cancelledBody, calls }),
);

calls = 0;
globalThis.fetch = async (_url, init) => {
  calls += 1;
  throw init.signal.reason;
};
const originalTimeout = AbortSignal.timeout;
AbortSignal.timeout = () => AbortSignal.abort();
try {
  result = await call("Translate to Chinese:\nhello");
  check(
    "timeout abort is not retried or reported as a network error",
    result.status === 504 &&
      result.json?.error?.code === "upstream_timeout" &&
      calls === 1,
    JSON.stringify({ status: result.status, body: result.json, calls }),
  );
} finally {
  AbortSignal.timeout = originalTimeout;
}

globalThis.fetch = async (_url, init) => {
  calls += 1;
  const body = JSON.parse(init.body);
  return upstream(
    body.raw_text.map((_, index) => ({ index, res: `stream${index}` })),
  );
};
result = await call("Translate to Chinese:\nhello", {
  body: JSON.stringify({
    model: "doubao-ai",
    stream: true,
    messages: [{ role: "user", content: "Translate to Chinese:\nhello" }],
  }),
});
const streamEvents = result.text
  .split("\n\n")
  .filter((event) => event.startsWith("data: ") && event !== "data: [DONE]")
  .map((event) => JSON.parse(event.slice(6)));
check(
  "stream true returns an OpenAI-compatible SSE completion",
  result.status === 200 &&
    result.headers.get("content-type")?.startsWith("text/event-stream") &&
    streamEvents[0]?.object === "chat.completion.chunk" &&
    streamEvents[0]?.choices?.[0]?.delta?.content === "stream0" &&
    streamEvents[1]?.choices?.[0]?.finish_reason === "stop" &&
    result.text.endsWith("data: [DONE]\n\n"),
  JSON.stringify({
    status: result.status,
    contentType: result.headers.get("content-type"),
    text: result.text,
  }),
);

result = await call("Translate to Chinese:\nhello", {
  body: JSON.stringify({
    model: "doubao-ai",
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: "Translate to Chinese:\nhello" }],
  }),
});
const usageEvents = result.text
  .split("\n\n")
  .filter((event) => event.startsWith("data: ") && event !== "data: [DONE]")
  .map((event) => JSON.parse(event.slice(6)));
check(
  "stream include_usage appends a zero-token usage chunk",
  result.status === 200 &&
    usageEvents.length === 3 &&
    usageEvents[2]?.choices?.length === 0 &&
    usageEvents[2]?.usage?.total_tokens === 0,
  JSON.stringify({ status: result.status, text: result.text }),
);

result = await call("Translate to Chinese:\nhello", {
  body: JSON.stringify({
    model: "doubao-ai",
    stream: "false",
    messages: [{ role: "user", content: "Translate to Chinese:\nhello" }],
  }),
});
check(
  "non-boolean stream is rejected",
  result.status === 400 &&
    result.json?.error?.code === "invalid_request",
  JSON.stringify({ status: result.status, body: result.json }),
);

// --- Cookie normalization: only `sessionid` is required, a bare value works ---

function captureUpstream() {
  let seen = null;
  globalThis.fetch = async (url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    seen = { url, headers: init.headers, body };
    return upstream(
      body.raw_text.map((_, index) => ({ index, res: `T${index}` })),
    );
  };
  return () => seen;
}

const bare = "a1b2c3d4e5f6g7h8i9j0k1l2";
let seen = captureUpstream();
result = await call("hello", {
  env: { ...env, DOUBAO_SESSION_ID: bare },
});
check(
  "a bare sessionid value is accepted",
  result.status === 200 && seen()?.headers.cookie === `sessionid=${bare}`,
  JSON.stringify({ status: result.status, cookie: seen()?.headers.cookie }),
);

seen = captureUpstream();
result = await call("hello", {
  env: { ...env, DOUBAO_SESSION_ID: `Cookie: ${bare}` },
});
check(
  "a bare sessionid with a Cookie: prefix is accepted",
  result.status === 200 && seen()?.headers.cookie === `sessionid=${bare}`,
  JSON.stringify({ status: result.status, cookie: seen()?.headers.cookie }),
);

seen = captureUpstream();
result = await call("hello", {
  env: { ...env, DOUBAO_SESSION_ID: `sessionid_ss=${bare}` },
});
check(
  "sessionid_ss alone is accepted",
  result.status === 200 && seen()?.headers.cookie === `sessionid_ss=${bare}`,
  JSON.stringify({ status: result.status, cookie: seen()?.headers.cookie }),
);

seen = captureUpstream();
result = await call("hello", {
  env: { ...env, DOUBAO_SESSION_ID: "sessionid=abc; sid_tt=def; ttwid=ghi" },
});
check(
  "a full Cookie header still passes through verbatim",
  result.status === 200 &&
    seen()?.headers.cookie === "sessionid=abc; sid_tt=def; ttwid=ghi",
  JSON.stringify({ status: result.status, cookie: seen()?.headers.cookie }),
);

seen = captureUpstream();
result = await call("hello", {
  env: { ...env, DOUBAO_SESSION_ID: "sessionid=abc==; stray" },
});
check(
  "a base64 value survives a rebuild triggered by another malformed part",
  result.status === 200 && seen()?.headers.cookie === "sessionid=abc==",
  JSON.stringify({ status: result.status, cookie: seen()?.headers.cookie }),
);

seen = captureUpstream();
result = await call("hello", {
  env: { ...env, DOUBAO_SESSION_ID: "sessionid=a; sessionid=b; bad" },
});
check(
  "a rebuild keeps the last of duplicate cookie names",
  result.status === 200 && seen()?.headers.cookie === "sessionid=b",
  JSON.stringify({ status: result.status, cookie: seen()?.headers.cookie }),
);

seen = captureUpstream();
result = await call("hello", {
  env: {
    ...env,
    DOUBAO_SESSION_ID: JSON.stringify([
      { name: "sessionid", value: "abc" },
      { name: "ttwid", value: "def" },
    ]),
  },
});
check(
  "a browser-exported Cookie JSON is converted to a header",
  result.status === 200 &&
    seen()?.headers.cookie === "sessionid=abc; ttwid=def",
  JSON.stringify({ status: result.status, cookie: seen()?.headers.cookie }),
);

for (const [label, value] of [
  ["empty", ""],
  ["a short noise string", "not-a-cookie"],
  ["a missing sessionid", "sid_tt=def456; uid_tt=ghi789"],
  ["a multi-line value", "sessionid=abc\ndevil: 1"],
]) {
  globalThis.fetch = async () => {
    calls += 1;
    return upstream([{ index: 0, res: "x" }]);
  };
  result = await call("hello", { env: { ...env, DOUBAO_SESSION_ID: value } });
  check(
    `an invalid cookie (${label}) is rejected before upstream`,
    result.status === 503 &&
      result.json?.error?.code === "configuration_error",
    JSON.stringify({ status: result.status, body: result.json }),
  );
}

// --- The pre-rename env var keeps working so old deployments do not break ---

seen = captureUpstream();
const legacyEnv = { ...env, DOUBAO_COOKIE: env.DOUBAO_SESSION_ID };
delete legacyEnv.DOUBAO_SESSION_ID;
result = await call("hello", { env: legacyEnv });
check(
  "a legacy DOUBAO_COOKIE still authenticates",
  result.status === 200 && seen()?.headers.cookie === env.DOUBAO_SESSION_ID,
  JSON.stringify({ status: result.status, cookie: seen()?.headers.cookie }),
);

// --- Upstream camouflage: extension params and browser headers ---

seen = captureUpstream();
result = await call("hello");
const upstreamUrl = new URL(seen().url);
const upstreamHeaders = seen().headers;
check(
  "upstream requests carry the extension query parameters",
  upstreamUrl.origin === "https://www.doubao.com" &&
    upstreamUrl.pathname === "/samantha/plugin/stream_article_translate" &&
    upstreamUrl.searchParams.get("aid") === "586864" &&
    upstreamUrl.searchParams.get("real_aid") === "586864" &&
    upstreamUrl.searchParams.get("device_platform") === "web" &&
    upstreamUrl.searchParams.get("version") === "1.38.0" &&
    upstreamUrl.searchParams.get("version_code") === "20800" &&
    upstreamUrl.searchParams.get("pc_version") === "1.38.0" &&
    upstreamUrl.searchParams.get("pkg_type") === "release_version" &&
    upstreamUrl.searchParams.get("is_new_user") === "0" &&
    upstreamUrl.searchParams.get("samantha_web") === "1" &&
    /^[1-9]\d{17}$/.test(upstreamUrl.searchParams.get("tea_uuid") ?? "") &&
    /^[0-9a-f-]{36}$/.test(upstreamUrl.searchParams.get("web_tab_id") ?? ""),
  seen().url,
);
check(
  "upstream requests carry browser headers",
  upstreamHeaders.accept === "text/event-stream" &&
    upstreamHeaders.origin === "https://www.doubao.com" &&
    upstreamHeaders.referer === "https://www.doubao.com/" &&
    upstreamHeaders["agw-js-conv"] === "str" &&
    upstreamHeaders["content-type"] === "application/json" &&
    /Mozilla\/5\.0 .*Chrome\//.test(upstreamHeaders["user-agent"] ?? ""),
  JSON.stringify(upstreamHeaders),
);

// --- Models: the three engines, plus the pre-rename alias ---

for (const [model, expected] of [
  ["doubao-ai-translation", "1"],
  ["doubao-ai", "1"],
  ["DOUBAO-AI-TRANSLATION", "1"],
  ["volcengine-translate", "0"],
  ["microsoft-translator", "3"],
]) {
  let service = null;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    service = JSON.parse(init.body).translate_service;
    return upstream([{ index: 0, res: "T0" }]);
  };
  result = await call("hello", {
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  check(
    `model ${model} maps to translate_service ${expected}`,
    result.status === 200 && service === expected,
    JSON.stringify({ status: result.status, service }),
  );
  check(
    `model ${model} is echoed in the response`,
    result.json?.model === (model === "volcengine-translate" ||
    model === "microsoft-translator"
      ? model
      : "doubao-ai-translation"),
    JSON.stringify({ model: result.json?.model }),
  );
}

globalThis.fetch = async () => {
  calls += 1;
  return upstream([{ index: 0, res: "T0" }]);
};
result = await call("hello", {
  body: JSON.stringify({
    model: "gpt-4o",
    messages: [{ role: "user", content: "hello" }],
  }),
});
check(
  "an unknown model is rejected before upstream",
  result.status === 404 && result.json?.error?.code === "model_not_found",
  JSON.stringify({ status: result.status, body: result.json }),
);

seen = captureUpstream();
result = await call("hello", {
  body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
});
check(
  "an omitted model defaults to doubao-ai-translation",
  result.status === 200 && result.json?.model === "doubao-ai-translation",
  JSON.stringify({ status: result.status, model: result.json?.model }),
);

// --- GET /v1/models: OpenAI clients populate their model picker from this ---

result = await call("", {
  url: "https://worker.example/v1/models",
  method: "GET",
});
check(
  "GET /v1/models lists the three supported models",
  result.status === 200 &&
    result.json?.object === "list" &&
    Array.isArray(result.json.data) &&
    result.json.data.length === 3 &&
    result.json.data.every((entry) => entry.object === "model") &&
    result.json.data.map((entry) => entry.id).join(",") ===
      "doubao-ai-translation,volcengine-translate,microsoft-translator",
  JSON.stringify({ status: result.status, body: result.json }),
);

result = await call("", {
  url: "https://worker.example/v1/models",
  method: "GET",
  headers: { authorization: "Bearer wrong-key-wrong-key" },
});
check(
  "GET /v1/models still requires the API key",
  result.status === 401 && result.json?.error?.code === "unauthorized",
  JSON.stringify({ status: result.status, body: result.json }),
);

result = await call("", {
  url: "https://worker.example/v1/models",
  method: "GET",
  env: { ...env, DOUBAO_SESSION_ID: "" },
});
check(
  "GET /v1/models works without a Doubao Cookie",
  result.status === 200 && result.json?.data?.length === 3,
  JSON.stringify({ status: result.status, body: result.json }),
);

// --- Risk-control quota codes surface as 429, not a generic 502 ---

for (const quotaCode of [710022002, 710022013]) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: quotaCode, message: "error" }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  result = await call("hello");
  check(
    `upstream code ${quotaCode} maps to 429 upstream_quota_exceeded`,
    result.status === 429 &&
      result.json?.error?.code === "upstream_quota_exceeded" &&
      result.json?.error?.type === "rate_limit_error",
    JSON.stringify({ status: result.status, body: result.json }),
  );
}

// --- A one-line message that starts with "translate ... into ..." is text ---
seen = captureUpstream();
result = await call("Translate the docs into English");
check(
  "a single-line directive-looking message is translated, not swallowed",
  result.status === 200 && seen()?.body?.raw_text?.[0] === "Translate the docs into English",
  JSON.stringify({ status: result.status, body: seen()?.body }),
);

// --- Stitching must not bypass the 10,000-character unit limit ---
seen = captureUpstream();
result = await call(`${"x".repeat(799)}\n%%\n${"y".repeat(10000)}`, {
  headers: { "x-doubao-context-mode": "subtitle-context" },
});
check(
  "a stitched unit over 10,000 characters is rejected with 413, not sent upstream",
  result.status === 413 && seen() === null,
  JSON.stringify({ status: result.status, called: seen() !== null }),
);

seen = captureUpstream();
result = await call(`${"y".repeat(10001)}`, {
  headers: { "x-doubao-context-mode": "subtitle" },
});
check(
  "an over-long single subtitle cue is rejected with 413",
  result.status === 413 && seen() === null,
  JSON.stringify({ status: result.status, called: seen() !== null }),
);

// --- A browser Cookie JSON export is normalized like the plugin does ---
seen = captureUpstream();
result = await call("hello", {
  env: {
    ...env,
    DOUBAO_SESSION_ID: JSON.stringify([
      { name: " sessionid ", value: " abc " },
    ]),
  },
});
check(
  "a JSON export with a padded name is trimmed, not rejected",
  result.status === 200 && seen()?.headers.cookie === "sessionid=abc",
  JSON.stringify({ status: result.status, cookie: seen()?.headers.cookie }),
);

seen = captureUpstream();
result = await call("hello", {
  env: {
    ...env,
    DOUBAO_SESSION_ID: JSON.stringify([
      { name: "sessionid", value: "a" },
      { name: "sessionid", value: "b" },
    ]),
  },
});
check(
  "a JSON export keeps the last of duplicate cookie names",
  result.status === 200 && seen()?.headers.cookie === "sessionid=b",
  JSON.stringify({ status: result.status, cookie: seen()?.headers.cookie }),
);

seen = captureUpstream();
result = await call("hello", {
  env: {
    ...env,
    DOUBAO_SESSION_ID: JSON.stringify([
      { name: "sessionid", value: "abc\nX: 1" },
    ]),
  },
});
check(
  "a JSON export that hides a newline in a value is rejected",
  result.status === 503 && seen() === null,
  JSON.stringify({ status: result.status, called: seen() !== null }),
);

globalThis.fetch = originalFetch;
await new Promise((resolve) => setTimeout(resolve, 20));
check(
  "no unhandled promise rejections",
  unhandled.length === 0,
  unhandled.join("; "),
);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
