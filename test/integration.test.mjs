// End-to-end integration tests for the magpie plugin entry point.
//
// Everything here goes through the *public* surface only:
//
//   DoubaoTranslatePlugin() -> auth.loader() -> loader.fetch(url, init)
//
// so the tests exercise exactly the path magpie drives: request routing, request
// adaptation, the language resolver, unit splitting / batching / rebuilding, the
// upstream transport and the response renderers. No network is ever touched: the
// plugin reads `globalThis.fetch` at request time, so a stub installed for the
// duration of one test is the only upstream there is.
//
// The upstream stub must answer with SSE. Anything else is rejected as
// `upstream_stream_error` by src/doubao.mjs, so `sse()` below is the canonical
// answer shape:
//
//   event: message
//   data: {"code":0,"data":{"items":[{"index":0,"res":"..."}]}}
//
//   event: done
//   data: {"code":0}
//
// Zero dependencies, offline, node:test + node:assert/strict.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DoubaoTranslatePlugin } from "../src/index.mjs";
import { KNOWN_LANGS, normalizeLanguage } from "../src/lang.mjs";

/* ------------------------------------------------------------------ setup */

const ORIGIN = "https://doubao-translation.invalid";
const BASE_URL = `${ORIGIN}/v1`;
const COOKIE = "sessionid=FAKE; sid_tt=FAKE; uid_tt=FAKE";

/** The upstream SSE frame the plugin parses (see src/doubao.mjs). */
const sse = (items) =>
  `event: message\ndata: ${JSON.stringify({ code: 0, data: { items } })}\n\n` +
  `event: done\ndata: {"code":0}\n\n`;

/** Default "model": every unit comes back as `译[<unit>]`. */
const echoItems = (rawText) => rawText.map((text, index) => ({ index, res: `译[${text}]` }));

/**
 * Install a stub as `globalThis.fetch` for the duration of `fn`, then restore
 * whatever was there before (even on throw). The plugin reads `globalThis.fetch`
 * per request, so the stub must be in place before `loader.fetch` is called.
 */
async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * A recording stub. `respond(body, index)` returns the upstream Response; every
 * upstream request body is kept in `calls` for assertions.
 */
function recordingStub(respond = (body) => new Response(sse(echoItems(body.raw_text)), { status: 200 })) {
  const calls = [];
  const stub = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    return respond(body, calls.length - 1);
  };
  return { stub, calls };
}

/** A fresh plugin instance plus a loader that resolves the fake Cookie. */
async function makePlugin(rawOptions = {}) {
  const inst = await DoubaoTranslatePlugin({ magpie: { options: () => ({}) } }, rawOptions);
  const auth = await inst.auth.loader(async () => ({ type: "api", key: COOKIE }), { models: {} });
  return { inst, auth };
}

/** POST a JSON body through the loader and decode whatever comes back. */
async function call(auth, path, body, headers = {}) {
  const response = await auth.fetch(ORIGIN + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // A stream body is not JSON; callers that need it read `text`.
  }
  return { status: response.status, headers: response.headers, text, json };
}

/** The chat-completions body Read Frog actually sends. */
const chat = (content, extra = {}) => ({
  model: "doubao-ai-translation",
  messages: [{ role: "user", content }],
  ...extra,
});

/* ------------------------------------------------- 1. 180-language sweep */

// The fixture is the 180-row `[tag, englishName]` table copied verbatim from
// `@read-frog/definitions` 0.18.0 (`dist/types/language-tags.js`), the exact
// table Read Frog sends as its target-language prompts. It lives in the repo so
// this sweep always runs, offline, with no /tmp prerequisite.
const RF_LANGS = new URL("./fixtures/rf_langs.json", import.meta.url);

test("180 Read Frog language names never 400 and always reach a known tag", async () => {
  const pairs = JSON.parse(readFileSync(RF_LANGS, "utf8"));
  assert.equal(pairs.length, 180, "the fixture is the 180-name Read Frog table");

  const known = new Set(KNOWN_LANGS);
  const failures = [];
  const { stub, calls } = recordingStub();

  await withFetch(stub, async () => {
    const { auth } = await makePlugin();
    for (const [code, name] of pairs) {
      const before = calls.length;
      const response = await call(auth, "/v1/chat/completions", {
        model: "doubao-ai-translation",
        messages: [
          {
            role: "system",
            content: `You are a professional ${name} native translator who needs to fluently translate text into ${name}.`,
          },
          { role: "user", content: `Translate to ${name}:\n\n\nHi` },
        ],
      });
      const sent = calls[before]?.body;

      if (response.status === 400) {
        failures.push(`${code} ${name}: 400 ${response.json?.error?.code} ${response.json?.error?.message}`);
        continue;
      }
      if (response.status !== 200) {
        failures.push(`${code} ${name}: status ${response.status}`);
        continue;
      }
      if (!sent) {
        failures.push(`${code} ${name}: no upstream request was made`);
        continue;
      }
      if (!known.has(sent.target_lang)) {
        failures.push(`${code} ${name}: target_lang ${JSON.stringify(sent.target_lang)} not in KNOWN_LANGS`);
        continue;
      }
      // "In KNOWN_LANGS" alone would also pass when the resolver silently fell
      // back to the `zh` default, so pin the tag the name actually means.
      const expected = normalizeLanguage(name);
      if (expected === null || sent.target_lang !== expected) {
        failures.push(
          `${code} ${name}: target_lang ${JSON.stringify(sent.target_lang)} != ${JSON.stringify(expected)}`,
        );
        continue;
      }
      // The directive must be stripped, so the upstream sees only "Hi".
      if (!Array.isArray(sent.raw_text) || sent.raw_text.join("") !== "Hi") {
        failures.push(`${code} ${name}: raw_text ${JSON.stringify(sent.raw_text)}`);
      }
    }
  });

  assert.deepEqual(failures, [], `languages that failed:\n${failures.join("\n")}`);
});

/* ------------------------------------------ 2. the `%%` separator is ours */

test("%% never travels upstream and is rebuilt verbatim", async () => {
  const source = "A\n\n%%\n\nB";
  const baseline = "译[A]\n\n%%\n\n译[B]";

  const { stub, calls } = recordingStub((body) => {
    assert.ok(
      body.raw_text.every((text) => !text.includes("%%")),
      `the separator leaked upstream: ${JSON.stringify(body.raw_text)}`,
    );
    return new Response(sse(echoItems(body.raw_text)), { status: 200 });
  });

  const bodies = [];
  await withFetch(stub, async () => {
    const { auth } = await makePlugin();
    const response = await call(auth, "/v1/chat/completions", chat(source));
    assert.equal(response.status, 200);
    assert.equal(response.json.choices[0].message.content, baseline);
    bodies.push(JSON.stringify(calls.at(-1).body));
  });

  assert.deepEqual(calls[0].body.raw_text, ["A", "B"], "only the two real units travel upstream");

  // The model is never asked about the separator, so it cannot misrender it.
  // Each of the contract's four separator renderings is emulated below as a
  // stub that *would* answer with that rendering if it were ever handed a
  // separator unit. Because no unit ever is, the content must stay byte-exact:
  // if `%%` leaked upstream, the marker would land inside a translation and the
  // content would drift from the baseline, which is exactly what fails here.
  const variants = [
    ["verbatim", "%%"],
    ["fullwidth", "％％"],
    ["empty", ""],
    ["word", "百分号"],
  ];
  for (const [label, marker] of variants) {
    const variantStub = recordingStub((body) => {
      assert.ok(
        body.raw_text.every((text) => !text.includes("%%")),
        `${label}: the separator leaked upstream`,
      );
      return new Response(
        sse(
          body.raw_text.map((text, index) => ({
            index,
            // A separator unit would be rendered as this variant's marker; a
            // real unit is just translated.
            res: /^[ \t]*%%[ \t]*$/.test(text) ? marker : `译[${text}]`,
          })),
        ),
        { status: 200 },
      );
    });

    await withFetch(variantStub.stub, async () => {
      const { auth } = await makePlugin();
      const response = await call(auth, "/v1/chat/completions", chat(source));
      assert.equal(response.status, 200, label);

      const content = response.json.choices[0].message.content;
      // Unchanged across all four renderings: the server owns the boundary.
      assert.equal(content, baseline, label);
      // ...and exactly one boundary survives, byte-exactly.
      assert.equal(content.split("\n\n%%\n\n").length, 2, label);
    });

    // Every variant sends an identical upstream body: the marker rendering is
    // unobservable before the response, which is why alignment cannot shift.
    bodies.push(JSON.stringify(variantStub.calls[0].body));
    assert.deepEqual(variantStub.calls[0].body.raw_text, ["A", "B"], label);
  }
  assert.equal(new Set(bodies).size, 1, "every variant sends an identical upstream body");

  // A mangled marker in a *middle* unit is the alignment-critical case: if the
  // boundary were rebuilt from the model's text instead of from the segments,
  // the marker would swallow or shift the neighbouring units.
  const chain = "A\n%%\nB\n%%\nC";
  const chainStub = recordingStub((body) => {
    assert.deepEqual(body.raw_text, ["A", "B", "C"], "the separators stay out of the chain too");
    return new Response(
      sse(
        body.raw_text.map((text, index) => ({
          index,
          res: text === "B" ? "百分号" : `译[${text}]`,
        })),
      ),
      { status: 200 },
    );
  });
  await withFetch(chainStub.stub, async () => {
    const { auth } = await makePlugin();
    const response = await call(auth, "/v1/chat/completions", chat(chain));
    assert.equal(response.status, 200);
    assert.equal(response.json.choices[0].message.content, "译[A]\n%%\n百分号\n%%\n译[C]");
  });
});

/* ----------------------------------------------------- 3. three protocols */

test("all three protocol endpoints answer 200 with the right shape", async () => {
  const { stub, calls } = recordingStub();
  await withFetch(stub, async () => {
    const { auth } = await makePlugin();

    const chatResponse = await call(auth, "/v1/chat/completions", chat("Hi"));
    assert.equal(chatResponse.status, 200);
    assert.equal(chatResponse.json.object, "chat.completion");
    assert.equal(chatResponse.json.choices[0].message.content, "译[Hi]");

    const responsesResponse = await call(auth, "/v1/responses", {
      model: "doubao-ai-translation",
      input: "Hi",
    });
    assert.equal(responsesResponse.status, 200);
    assert.equal(responsesResponse.json.object, "response");
    assert.equal(responsesResponse.json.output_text, "译[Hi]");
    assert.equal(responsesResponse.json.output[0].content[0].text, "译[Hi]");

    const anthropicResponse = await call(auth, "/v1/messages", {
      model: "doubao-ai-translation",
      messages: [{ role: "user", content: "Hi" }],
    });
    assert.equal(anthropicResponse.status, 200);
    assert.equal(anthropicResponse.json.type, "message");
    assert.equal(anthropicResponse.json.content[0].type, "text");
    assert.equal(anthropicResponse.json.content[0].text, "译[Hi]");
  });

  assert.equal(calls.length, 3, "one upstream request per protocol call");
});

/* -------------------------------------------------------- 4. three engines */

test("model ids map to translate_service, unknown models are 404", async () => {
  const engines = [
    ["doubao-ai-translation", "1"],
    ["volcengine-translate", "0"],
    ["microsoft-translator", "3"],
  ];
  const { stub, calls } = recordingStub();

  await withFetch(stub, async () => {
    const { auth } = await makePlugin();

    for (const [model, service] of engines) {
      const response = await call(auth, "/v1/chat/completions", chat("Hi", { model }));
      assert.equal(response.status, 200, model);
      assert.equal(response.json.choices[0].message.content, "译[Hi]", model);
      assert.equal(calls.at(-1).body.translate_service, service, model);
    }

    const missing = await call(auth, "/v1/chat/completions", chat("Hi", { model: "nope" }));
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, "model_not_found");
  });
});

/* ------------------------------------------------------- 5. unknown paths */

test("an unknown path is a 400 invalid_request", async () => {
  const { stub, calls } = recordingStub();
  await withFetch(stub, async () => {
    const { auth } = await makePlugin();
    const response = await call(auth, "/v1/unknown", chat("Hi"));
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "invalid_request");
  });
  assert.equal(calls.length, 0, "a rejected path never reaches upstream");
});

/* ------------------------------------------------ 6. unsupported features */

test("a tools request is a 400 unsupported_feature", async () => {
  const { stub, calls } = recordingStub();
  await withFetch(stub, async () => {
    const { auth } = await makePlugin();
    const response = await call(
      auth,
      "/v1/chat/completions",
      chat("Hi", { tools: [{ type: "function", function: { name: "f" } }] }),
    );
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "unsupported_feature");
  });
  assert.equal(calls.length, 0, "an unsupported capability never reaches upstream");
});

/* ------------------------------------------------------ 7. missing Cookie */

test("a missing Cookie is a 401 cookie_missing with the sign-in header", async () => {
  const { stub, calls } = recordingStub();
  await withFetch(stub, async () => {
    const inst = await DoubaoTranslatePlugin({ magpie: { options: () => ({}) } }, {});
    const auth = await inst.auth.loader(async () => null, { models: {} });
    const response = await call(auth, "/v1/chat/completions", chat("Hi"));

    assert.equal(response.status, 401);
    assert.equal(response.json.error.code, "cookie_missing");
    assert.equal(response.headers.get("x-magpie-sign-in"), "expired");
  });
  assert.equal(calls.length, 0, "no Cookie means no upstream call");
});

/* ------------------------------------------------- 8. header beats system */

test("x-doubao-target-lang wins over the system context", async () => {
  const { stub, calls } = recordingStub();
  await withFetch(stub, async () => {
    const { auth } = await makePlugin();
    const response = await call(
      auth,
      "/v1/chat/completions",
      {
        model: "doubao-ai-translation",
        messages: [
          {
            role: "system",
            content:
              "You are a professional Japanese native translator who needs to fluently translate text into Japanese.",
          },
          { role: "user", content: "Hi" },
        ],
      },
      { "x-doubao-target-lang": "zh-Hant" },
    );

    assert.equal(response.status, 200);
    assert.equal(calls.at(-1).body.target_lang, "zh-Hant");
  });
});

/* --------------------------------------------------- 9. context-mode switch */

test("subtitle context mode keeps a cue's internal newlines in one unit", async () => {
  const source = "A1\nA2\n%%\nB";
  const { stub, calls } = recordingStub();

  await withFetch(stub, async () => {
    const { auth } = await makePlugin();

    const subtitle = await call(auth, "/v1/chat/completions", chat(source), {
      "x-doubao-context-mode": "subtitle",
    });
    assert.equal(subtitle.status, 200);
    const subtitleUnits = calls.at(-1).body.raw_text;
    assert.equal(subtitleUnits.length, 2, "subtitle mode: two cues");
    assert.ok(subtitleUnits[0].includes("\n"), "the first cue keeps its internal break");
    assert.equal(subtitleUnits[0], "A1\nA2");

    const plain = await call(auth, "/v1/chat/completions", chat(source));
    assert.equal(plain.status, 200);
    const plainUnits = calls.at(-1).body.raw_text;
    assert.equal(plainUnits.length, 3, "default mode: one unit per line");
    assert.deepEqual(plainUnits, ["A1", "A2", "B"]);
  });
});

test("subtitle-context stitches split sentences into whole sentences upstream", async () => {
  // Two sentences, each split across cues: the first over three, the second over two.
  const source = [
    "I told him that",
    "%%",
    "we should leave before",
    "%%",
    "the storm hits.",
    "%%",
    "She said she would",
    "%%",
    "call me back.",
  ].join("\n");

  // Answer each merged sentence with one translated line per source cue, so the
  // exact-line path of splitMerged spreads them back onto the original cues.
  const respond = (body) =>
    new Response(
      sse(
        body.raw_text.map((_, index) => ({
          index,
          res:
            index === 0
              ? "我告诉他\n我们应该在\n暴风雨来临前离开。"
              : "她说她会\n给我回电话。",
        })),
      ),
      { status: 200 },
    );
  const { stub, calls } = recordingStub(respond);

  await withFetch(stub, async () => {
    const { auth } = await makePlugin();

    const stitched = await call(auth, "/v1/chat/completions", chat(source), {
      "x-doubao-context-mode": "subtitle-context",
    });
    assert.equal(stitched.status, 200);
    assert.deepEqual(
      calls.at(-1).body.raw_text,
      [
        "I told him that we should leave before the storm hits.",
        "She said she would call me back.",
      ],
      "each split sentence travels upstream as one string",
    );
    // The display keeps one cue per line: the three-line translation lands on
    // the three cues, and every original `%%` separator is still in place.
    assert.equal(
      stitched.json.choices[0].message.content,
      "我告诉他\n%%\n我们应该在\n%%\n暴风雨来临前离开。\n%%\n她说她会\n%%\n给我回电话。",
    );

    // `subtitle` still sends the raw cues untouched, so nothing else changes.
    const subtitle = await call(auth, "/v1/chat/completions", chat(source), {
      "x-doubao-context-mode": "subtitle",
    });
    assert.equal(subtitle.status, 200);
    assert.equal(calls.at(-1).body.raw_text.length, 5, "subtitle mode: five cues");
  });
});

/* --------------------------------------------------------------- 10. hooks */

test("config() registers the provider and provider.id is the provider name", async () => {
  const { inst } = await makePlugin();
  const cfg = {};
  await inst.config(cfg);

  const provider = cfg.provider["doubao-translation"];
  assert.ok(provider, "config() registers the provider entry");
  assert.equal(provider.api, BASE_URL);
  assert.deepEqual(
    Object.keys(provider.models).sort(),
    ["doubao-ai-translation", "microsoft-translator", "volcengine-translate"],
  );
  assert.equal(Object.keys(provider.models).length, 3);
  assert.equal(inst.provider.id, "doubao-translation");
});

test("provider.models lists models even when the stored Cookie is empty or expired", async () => {
  // Regression: `if (auth.type === "api") await inspect(...)` made the whole
  // model list fail whenever the host held an empty/expired credential.
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("models() must not touch the network");
  };
  try {
    const inst = await DoubaoTranslatePlugin({ magpie: { options: () => ({}) } }, {});
    const provider = { id: "doubao-translation", models: { a: {}, b: {}, c: {} } };

    // No credential at all.
    assert.deepEqual(await inst.provider.models(provider, {}), provider.models);
    assert.deepEqual(await inst.provider.models(provider), provider.models);

    // Empty key.
    const emptyKey = await inst.provider.models(provider, { auth: { type: "api", key: "" } });
    assert.deepEqual(emptyKey, provider.models);
  } finally {
    globalThis.fetch = original;
  }
});

test("provider.models still lists models when the credential probe fails", async () => {
  const original = globalThis.fetch;
  // An expired session answers 200 with a JSON error body; fetchAccountInfo
  // throws upstream_auth_error, which models() must swallow.
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ data: { user_id: 0, description: "会话过期" }, message: "error" }),
      { status: 200 },
    );
  try {
    const inst = await DoubaoTranslatePlugin({ magpie: { options: () => ({}) } }, {});
    const provider = { id: "doubao-translation", models: { a: {} } };
    const listed = await inst.provider.models(provider, {
      auth: { type: "api", key: "sessionid=EXPIRED" },
    });
    assert.deepEqual(listed, provider.models);
  } finally {
    globalThis.fetch = original;
  }
});

/* --------------------------------------------------- 11. upstream disguise */

test("every upstream request carries browser headers and the desktop params", async () => {
  const seen = [];
  const stub = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, headers: init.headers, body });
    return new Response(sse(echoItems(body.raw_text)), { status: 200 });
  };

  await withFetch(stub, async () => {
    const { auth } = await makePlugin();
    const response = await call(auth, "/v1/chat/completions", chat("Hi"));
    assert.equal(response.status, 200);
  });

  assert.equal(seen.length, 1);
  const { url, headers } = seen[0];

  // The query string must carry the desktop parameter block, never a bare path.
  const parsed = new URL(url);
  assert.equal(parsed.pathname, "/samantha/plugin/stream_article_translate");
  assert.equal(parsed.searchParams.get("aid"), "586864");
  assert.equal(parsed.searchParams.get("device_platform"), "web");
  assert.equal(parsed.searchParams.get("version"), "1.38.0");
  assert.equal(parsed.searchParams.get("version_code"), "20800");

  // And the headers must look like the web client, not Node's default.
  assert.match(headers["user-agent"], /Mozilla\/5\.0 .*Chrome\//);
  assert.notEqual(headers["user-agent"], "node");
  assert.equal(headers.origin, "https://www.doubao.com");
  assert.equal(headers.referer, "https://www.doubao.com/");
  assert.equal(headers["agw-js-conv"], "str");
  assert.equal(headers.cookie, COOKIE);
});

test("concurrent translated turns are allowed to overlap", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const stub = async (url, init) => {
    const body = JSON.parse(init.body);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // Hold each request long enough that, without serialisation, the two
    // requests visibly overlap.
    await new Promise((resolve) => setTimeout(resolve, 15));
    inFlight -= 1;
    return new Response(sse(echoItems(body.raw_text)), { status: 200 });
  };

  await withFetch(stub, async () => {
    const { auth } = await makePlugin();
    const [a, b] = await Promise.all([
      call(auth, "/v1/chat/completions", chat("one")),
      call(auth, "/v1/chat/completions", chat("two")),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
  });

  // This is a translation API: throughput matters, so calls must NOT be
  // serialised through a queue (the old default of 1 was rolled back to 4).
  assert.equal(maxInFlight, 2, "two independent turns must reach upstream together");
});
