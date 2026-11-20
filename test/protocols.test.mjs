// Tests for src/protocols.mjs: path routing, request adaptation, capability
// rejection and the response / SSE shapes of all three protocols.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROTOCOLS,
  protocolOf,
  adaptRequest,
  checkCapabilities,
  renderResponse,
  renderStream,
} from "../src/protocols.mjs";
import { ServiceError } from "../src/errors.mjs";

/* ---------------------------------------------------------------- helpers */

/** Split a complete SSE body into `{ event, data }` frames. */
function frames(sse) {
  return sse
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const lines = block.split("\n");
      let event = null;
      let data = null;
      for (const line of lines) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data = line.slice(6);
      }
      return { event, data: data === "[DONE]" ? "[DONE]" : JSON.parse(data), raw: block };
    });
}

function assertServiceError(fn, { status, code, param }) {
  let caught;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ServiceError, `expected a ServiceError, got ${caught}`);
  if (status !== undefined) assert.equal(caught.status, status);
  if (code !== undefined) assert.equal(caught.code, code);
  if (param !== undefined) assert.equal(caught.param, param);
  return caught;
}

const headers = (entries = {}) => new Headers(entries);

/* ------------------------------------------------------------- protocolOf */

test("protocolOf maps the three canonical paths", () => {
  assert.equal(protocolOf("/v1/chat/completions"), "openai-chat");
  assert.equal(protocolOf("/v1/responses"), "openai-responses");
  assert.equal(protocolOf("/v1/messages"), "anthropic");
  assert.deepEqual(Object.keys(PROTOCOLS), ["/v1/chat/completions", "/v1/responses", "/v1/messages"]);
});

test("protocolOf tolerates trailing slashes, query strings and fragments", () => {
  assert.equal(protocolOf("/v1/chat/completions/"), "openai-chat");
  assert.equal(protocolOf("/v1/messages///"), "anthropic");
  assert.equal(protocolOf("/v1/responses/?foo=bar"), "openai-responses");
  assert.equal(protocolOf("/v1/messages#frag"), "anthropic");
  assert.equal(protocolOf("/v1/chat/completions?stream=true"), "openai-chat");
});

test("protocolOf returns null for anything else", () => {
  for (const path of ["/v1/models", "/", "", "/v1/chat", "/v2/messages", null, undefined, 42]) {
    assert.equal(protocolOf(path), null, `expected null for ${String(path)}`);
  }
});

/* ------------------------------------------------------- openai-chat (chat) */

test("openai-chat: adapts a string content request", () => {
  const request = adaptRequest(
    "openai-chat",
    {
      model: "doubao-ai-translation",
      stream: true,
      target_lang: "ja",
      doubao_scene: 3,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: "You are a translator." },
        { role: "developer", content: "Translate to Japanese." },
        { role: "user", content: "Hello world" },
      ],
    },
    { headers: headers() },
  );
  assert.equal(request.protocol, "openai-chat");
  assert.equal(request.model, "doubao-ai-translation");
  assert.equal(request.stream, true);
  assert.equal(request.includeUsage, true);
  assert.equal(request.target, "ja");
  assert.equal(request.text, "Hello world");
  assert.equal(request.contextMode, "default");
  assert.equal(request.scene, 3);
  assert.deepEqual(request.contexts, ["You are a translator.", "Translate to Japanese."]);
});

test("openai-chat: adapts an array content request and joins text parts", () => {
  const request = adaptRequest(
    "openai-chat",
    {
      model: "volcengine-translate",
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }] },
      ],
    },
    { headers: headers() },
  );
  assert.equal(request.text, "Hello world", "the last user message wins");
  assert.equal(request.stream, false);
  assert.equal(request.includeUsage, false);
  assert.equal(request.target, null);
  assert.equal(request.scene, null);
});

test("openai-chat: missing user message is unsupported_input", () => {
  assertServiceError(
    () =>
      adaptRequest(
        "openai-chat",
        { model: "m", messages: [{ role: "system", content: "translate this" }] },
        { headers: headers() },
      ),
    { status: 400, code: "unsupported_input" },
  );
});

test("openai-chat: empty message list is invalid_request", () => {
  assertServiceError(
    () => adaptRequest("openai-chat", { model: "m", messages: [] }, { headers: headers() }),
    { status: 400, code: "invalid_request", param: "messages" },
  );
});

test("openai-chat: non-text content parts are unsupported_input", () => {
  assertServiceError(
    () =>
      adaptRequest(
        "openai-chat",
        {
          model: "m",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "describe" },
                { type: "image_url", image_url: { url: "https://x/y.png" } },
              ],
            },
          ],
        },
        { headers: headers() },
      ),
    { status: 400, code: "unsupported_input", param: "content" },
  );
});

test("openai-chat: tools are rejected as unsupported_feature", () => {
  assertServiceError(
    () =>
      adaptRequest(
        "openai-chat",
        {
          model: "m",
          messages: [{ role: "user", content: "hi" }],
          tools: [{ type: "function", function: { name: "x" } }],
        },
        { headers: headers() },
      ),
    { status: 400, code: "unsupported_feature", param: "tools" },
  );
});

/* ------------------------------------------------- openai-responses (resp) */

test("openai-responses: adapts an array input with instructions", () => {
  const request = adaptRequest(
    "openai-responses",
    {
      model: "doubao-ai-translation",
      stream: true,
      instructions: "Always translate faithfully.",
      input: [
        { role: "system", content: [{ type: "input_text", text: "System note" }] },
        { role: "user", content: [{ type: "input_text", text: "old" }] },
        { role: "user", content: [{ type: "input_text", text: "Good morning" }] },
      ],
    },
    { headers: headers() },
  );
  assert.equal(request.protocol, "openai-responses");
  assert.equal(request.text, "Good morning");
  assert.equal(request.instructions, "Always translate faithfully.");
  assert.deepEqual(request.contexts, ["Always translate faithfully.", "System note"]);
  assert.equal(request.stream, true);
});

test("openai-responses: adapts a plain string input", () => {
  const request = adaptRequest(
    "openai-responses",
    { model: "doubao-ai-translation", input: "Translate: hello" },
    { headers: headers() },
  );
  assert.equal(request.text, "Translate: hello");
  assert.equal(request.instructions, null);
  assert.deepEqual(request.contexts, []);
});

test("openai-responses: missing user input is unsupported_input", () => {
  assertServiceError(
    () =>
      adaptRequest(
        "openai-responses",
        { model: "m", input: [{ role: "system", content: [{ type: "input_text", text: "ctx" }] }] },
        { headers: headers() },
      ),
    { status: 400, code: "unsupported_input" },
  );
  assertServiceError(
    () => adaptRequest("openai-responses", { model: "m" }, { headers: headers() }),
    { status: 400, code: "unsupported_input" },
  );
});

test("openai-responses: previous_response_id / reasoning / background are rejected", () => {
  for (const field of ["previous_response_id", "conversation", "reasoning", "background", "prompt"]) {
    const body = { model: "m", input: "hi", [field]: field === "previous_response_id" ? "resp_1" : { x: 1 } };
    if (field === "conversation") body[field] = "conv_1";
    if (field === "reasoning") body[field] = { effort: "high" };
    assertServiceError(() => adaptRequest("openai-responses", body, { headers: headers() }), {
      status: 400,
      code: "unsupported_feature",
      param: field,
    });
  }
});

test("openai-responses: text.format json_schema is rejected", () => {
  assertServiceError(
    () =>
      adaptRequest(
        "openai-responses",
        { model: "m", input: "hi", text: { format: { type: "json_schema" } } },
        { headers: headers() },
      ),
    { status: 400, code: "unsupported_feature", param: "text.format" },
  );
});

/* --------------------------------------------------------- anthropic (msg) */

test("anthropic: adapts messages with a string system prompt", () => {
  const request = adaptRequest(
    "anthropic",
    {
      model: "doubao-ai-translation",
      max_tokens: 1024,
      system: "You translate subtitles.",
      stream: true,
      messages: [
        { role: "user", content: "Bonjour" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: [{ type: "text", text: "Comment allez-vous ?" }] },
      ],
    },
    { headers: headers() },
  );
  assert.equal(request.protocol, "anthropic");
  assert.equal(request.text, "Comment allez-vous ?");
  assert.deepEqual(request.contexts, ["You translate subtitles."]);
  assert.equal(request.stream, true);
});

test("anthropic: adapts an array system prompt", () => {
  const request = adaptRequest(
    "anthropic",
    {
      model: "doubao-ai-translation",
      system: [{ type: "text", text: "Part one. " }, { type: "text", text: "Part two." }],
      messages: [{ role: "user", content: "Hola" }],
    },
    { headers: headers() },
  );
  assert.deepEqual(request.contexts, ["Part one. Part two."]);
  assert.equal(request.text, "Hola");
});

test("anthropic: missing user message is unsupported_input", () => {
  assertServiceError(
    () => adaptRequest("anthropic", { model: "m", messages: [{ role: "assistant", content: "hi" }] }, { headers: headers() }),
    { status: 400, code: "unsupported_input" },
  );
});

test("anthropic: thinking enabled is rejected, disabled is allowed", () => {
  assertServiceError(
    () =>
      adaptRequest(
        "anthropic",
        { model: "m", thinking: { type: "enabled", budget_tokens: 1024 }, messages: [{ role: "user", content: "hi" }] },
        { headers: headers() },
      ),
    { status: 400, code: "unsupported_feature", param: "thinking" },
  );
  const ok = adaptRequest(
    "anthropic",
    { model: "m", thinking: { type: "disabled" }, messages: [{ role: "user", content: "hi" }] },
    { headers: headers() },
  );
  assert.equal(ok.text, "hi");
});

/* ------------------------------------------------------ shared header bits */

test("target is returned raw from body.target_lang, never normalized", () => {
  const body = {
    model: "m",
    target_lang: "Simplified Mandarin Chinese",
    messages: [{ role: "user", content: "hi" }],
  };
  const request = adaptRequest("openai-chat", body, { headers: headers() });
  assert.equal(request.target, "Simplified Mandarin Chinese");
});

test("target falls back to the x-doubao-target-lang header", () => {
  const request = adaptRequest(
    "openai-chat",
    { model: "m", messages: [{ role: "user", content: "hi" }] },
    { headers: headers({ "x-doubao-target-lang": "pt-BR" }) },
  );
  assert.equal(request.target, "pt-BR");
});

test("body.target_lang wins over the header", () => {
  const request = adaptRequest(
    "openai-chat",
    { model: "m", target_lang: "ja", messages: [{ role: "user", content: "hi" }] },
    { headers: headers({ "x-doubao-target-lang": "pt-BR" }) },
  );
  assert.equal(request.target, "ja");
});

test("headers work as a plain object too (case-insensitive)", () => {
  const request = adaptRequest(
    "openai-chat",
    { model: "m", messages: [{ role: "user", content: "hi" }] },
    { headers: { "X-Doubao-Target-Lang": "ko", "X-Doubao-Context-Mode": "subtitle" } },
  );
  assert.equal(request.target, "ko");
  assert.equal(request.contextMode, "subtitle");
});

test("contextMode accepts the three modes and rejects anything else", () => {
  for (const mode of ["default", "subtitle", "subtitle-context"]) {
    const request = adaptRequest(
      "openai-chat",
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      { headers: headers({ "x-doubao-context-mode": mode }) },
    );
    assert.equal(request.contextMode, mode);
  }
  const error = assertServiceError(
    () =>
      adaptRequest(
        "openai-chat",
        { model: "m", messages: [{ role: "user", content: "hi" }] },
        { headers: headers({ "x-doubao-context-mode": "bogus" }) },
      ),
    { status: 400, code: "invalid_request" },
  );
  assert.match(error.message, /x-doubao-context-mode/);
});

test("scene comes from body, then header, then options, and validates 1-6", () => {
  const base = { model: "m", messages: [{ role: "user", content: "hi" }] };
  assert.equal(adaptRequest("openai-chat", { ...base, doubao_scene: 2 }, { headers: headers() }).scene, 2);
  assert.equal(
    adaptRequest("openai-chat", base, { headers: headers({ "x-doubao-scene": "5" }) }).scene,
    5,
  );
  assert.equal(
    adaptRequest("openai-chat", base, { headers: headers({ "x-doubao-scene": "4" }), options: { scene: 6 } }).scene,
    4,
  );
  assert.equal(adaptRequest("openai-chat", base, { headers: headers(), options: { scene: 1 } }).scene, 1);
  assert.equal(adaptRequest("openai-chat", base, { headers: headers() }).scene, null);

  for (const bad of [0, 7, 1.5, "x"]) {
    assertServiceError(
      () => adaptRequest("openai-chat", { ...base, doubao_scene: bad }, { headers: headers() }),
      { status: 400, code: "invalid_request", param: "doubao_scene" },
    );
  }
});

test("stream and includeUsage are read from the body", () => {
  const body = {
    model: "m",
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: "hi" }],
  };
  const request = adaptRequest("openai-chat", body, { headers: headers() });
  assert.equal(request.stream, true);
  assert.equal(request.includeUsage, true);
});

test("an unknown protocol is rejected", () => {
  assertServiceError(() => adaptRequest("openai-chat-typo", {}, { headers: headers() }), {
    status: 400,
    code: "invalid_request",
  });
});

/* -------------------------------------------------------- checkCapabilities */

test("checkCapabilities rejects every unsupported field with the field name", () => {
  const cases = [
    ["tools", [{ type: "function" }]],
    ["functions", [{ name: "f" }]],
    ["function_call", { name: "f" }],
    ["previous_response_id", "resp_1"],
    ["conversation", "conv_1"],
    ["reasoning", { effort: "high" }],
    ["reasoning_effort", "high"],
    ["background", true],
    ["audio", { format: "wav" }],
    ["prediction", { type: "content" }],
    ["prompt", { id: "pmpt_1" }],
    ["tool_choice", "auto"],
    ["tool_choice", { type: "function", function: { name: "f" } }],
    ["thinking", { type: "enabled" }],
    ["n", 2],
    ["modalities", ["text", "audio"]],
    ["response_format", { type: "json_object" }],
  ];
  for (const [field, value] of cases) {
    const error = assertServiceError(() => checkCapabilities({ [field]: value }, "openai-chat"), {
      status: 400,
      code: "unsupported_feature",
      param: field,
    });
    assert.equal(error.message, "Requested capability is not supported by this translation service.");
  }
});

test("checkCapabilities allows the no-op values", () => {
  for (const body of [
    {},
    { tool_choice: "none" },
    { tools: [] },
    { thinking: { type: "disabled" } },
    { n: 1 },
    { modalities: ["text"] },
    { response_format: { type: "text" } },
    { response_format: null },
    { stream: true, messages: [] },
  ]) {
    assert.doesNotThrow(() => checkCapabilities(body, "openai-chat"), JSON.stringify(body));
  }
});

test("checkCapabilities rejects tool fields carried on a message", () => {
  assertServiceError(
    () =>
      checkCapabilities(
        {
          model: "m",
          messages: [{ role: "assistant", content: "hi", tool_calls: [{ id: "call_1" }] }],
        },
        "openai-chat",
      ),
    { status: 400, code: "unsupported_feature", param: "tool_calls" },
  );
});

/* --------------------------------------------------------- renderResponse */

test("renderResponse: openai-chat shape", () => {
  const body = renderResponse("openai-chat", { id: "chatcmpl_test", model: "doubao-ai-translation", content: "你好" });
  assert.equal(body.id, "chatcmpl_test");
  assert.equal(body.object, "chat.completion");
  assert.equal(typeof body.created, "number");
  assert.equal(body.model, "doubao-ai-translation");
  assert.deepEqual(body.choices, [
    { index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" },
  ]);
  assert.deepEqual(body.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test("renderResponse: openai-responses shape", () => {
  const body = renderResponse("openai-responses", { id: "resp_test", model: "doubao-ai-translation", content: "hello" });
  assert.equal(body.id, "resp_test");
  assert.equal(body.object, "response");
  assert.equal(typeof body.created_at, "number");
  assert.equal(body.status, "completed");
  assert.equal(body.model, "doubao-ai-translation");
  assert.equal(body.output_text, "hello");
  assert.equal(body.output.length, 1);
  const item = body.output[0];
  assert.equal(item.type, "message");
  assert.equal(item.role, "assistant");
  assert.equal(item.status, "completed");
  assert.equal(typeof item.id, "string");
  assert.deepEqual(item.content, [{ type: "output_text", text: "hello", annotations: [] }]);
  assert.deepEqual(body.usage, { input_tokens: 0, output_tokens: 0, total_tokens: 0 });
});

test("renderResponse: anthropic shape", () => {
  const body = renderResponse("anthropic", { id: "msg_test", model: "doubao-ai-translation", content: "bonjour" });
  assert.equal(body.id, "msg_test");
  assert.equal(body.type, "message");
  assert.equal(body.role, "assistant");
  assert.equal(body.model, "doubao-ai-translation");
  assert.deepEqual(body.content, [{ type: "text", text: "bonjour" }]);
  assert.equal(body.stop_reason, "end_turn");
  assert.equal(body.stop_sequence, null);
  assert.deepEqual(body.usage, { input_tokens: 0, output_tokens: 0 });
});

test("renderResponse: ids are generated when omitted and are protocol-prefixed", () => {
  assert.match(renderResponse("openai-chat", { content: "x" }).id, /^chatcmpl_/);
  assert.match(renderResponse("openai-responses", { content: "x" }).id, /^resp_/);
  assert.match(renderResponse("anthropic", { content: "x" }).id, /^msg_/);
});

test("renderResponse: usage overrides win", () => {
  const body = renderResponse("anthropic", { content: "x", usage: { input_tokens: 12, output_tokens: 34 } });
  assert.deepEqual(body.usage, { input_tokens: 12, output_tokens: 34 });
});

test("renderResponse: OpenAI chat usage names are mapped onto Anthropic/Responses keys", () => {
  // index.mjs hands every protocol the same OpenAI-chat usage object.
  const shared = { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 };
  assert.deepEqual(renderResponse("anthropic", { content: "x", usage: shared }).usage, {
    input_tokens: 7,
    output_tokens: 9,
  });
  assert.deepEqual(renderResponse("openai-responses", { content: "x", usage: shared }).usage, {
    input_tokens: 7,
    output_tokens: 9,
    total_tokens: 16,
  });
  assert.deepEqual(renderResponse("openai-chat", { content: "x", usage: shared }).usage, shared);
  // And the reverse direction, for an Anthropic-shaped caller.
  assert.deepEqual(renderResponse("openai-chat", { content: "x", usage: { input_tokens: 1, output_tokens: 2 } }).usage, {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 0,
  });
});

test("renderResponse: content is coerced to a string and rejects unknown protocols", () => {
  assert.equal(renderResponse("anthropic", { content: null }).content[0].text, "");
  assertServiceError(() => renderResponse("nope", { content: "x" }), { status: 400, code: "invalid_request" });
});

/* ----------------------------------------------------------- renderStream */

test("renderStream: openai-chat emits 2 chunks plus [DONE]", () => {
  const sse = renderStream("openai-chat", { id: "chatcmpl_s", model: "doubao-ai-translation", content: "hi" });
  const parsed = frames(sse);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].data.object, "chat.completion.chunk");
  assert.deepEqual(parsed[0].data.choices[0].delta, { role: "assistant", content: "hi" });
  assert.equal(parsed[0].data.choices[0].finish_reason, null);
  assert.deepEqual(parsed[1].data.choices[0].delta, {});
  assert.equal(parsed[1].data.choices[0].finish_reason, "stop");
  assert.equal(parsed[2].data, "[DONE]");
  assert.ok(sse.endsWith("data: [DONE]\n\n"));
  assert.equal(parsed[0].data.id, "chatcmpl_s");
  assert.equal(parsed[0].data.model, "doubao-ai-translation");
});

test("renderStream: openai-chat adds a usage chunk when includeUsage is set", () => {
  const sse = renderStream("openai-chat", { id: "c", model: "m", content: "hi", includeUsage: true });
  const parsed = frames(sse);
  assert.equal(parsed.length, 4);
  const usageChunk = parsed[2].data;
  assert.deepEqual(usageChunk.choices, []);
  assert.deepEqual(usageChunk.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  assert.equal(parsed[3].data, "[DONE]");
});

test("renderStream: openai-responses emits the full lifecycle", () => {
  const sse = renderStream("openai-responses", { id: "resp_s", model: "doubao-ai-translation", content: "hi" });
  const parsed = frames(sse);
  const events = parsed.map((frame) => frame.event);
  assert.deepEqual(events, [
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
  ]);
  assert.equal(parsed.length, 9);
  for (const [index, frame] of parsed.entries()) assert.equal(frame.data.sequence_number, index);
  assert.equal(parsed[0].data.response.status, "in_progress");
  assert.deepEqual(parsed[0].data.response.output, []);
  assert.equal(parsed[4].data.delta, "hi");
  assert.equal(parsed[5].data.text, "hi");
  assert.equal(parsed[8].data.response.status, "completed");
  assert.equal(parsed[8].data.response.output_text, "hi");
  assert.equal(parsed[4].data.item_id, parsed[8].data.response.output[0].id);
});

test("renderStream: anthropic emits the six documented events", () => {
  const sse = renderStream("anthropic", { id: "msg_s", model: "doubao-ai-translation", content: "salut" });
  const parsed = frames(sse);
  assert.deepEqual(
    parsed.map((frame) => frame.event),
    ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"],
  );
  assert.equal(parsed.length, 6);
  assert.equal(parsed[0].data.type, "message_start");
  assert.equal(parsed[0].data.message.id, "msg_s");
  assert.deepEqual(parsed[0].data.message.content, []);
  assert.equal(parsed[0].data.message.stop_reason, null);
  assert.deepEqual(parsed[1].data.content_block, { type: "text", text: "" });
  assert.deepEqual(parsed[2].data.delta, { type: "text_delta", text: "salut" });
  assert.equal(parsed[2].data.index, 0);
  assert.deepEqual(parsed[4].data.delta, { stop_reason: "end_turn", stop_sequence: null });
  assert.equal(parsed[5].data.type, "message_stop");
});

test("renderStream: every frame is a well-formed SSE block with a trailing blank line", () => {
  for (const protocol of ["openai-chat", "openai-responses", "anthropic"]) {
    const sse = renderStream(protocol, { id: "x", model: "m", content: "hi" });
    assert.ok(sse.endsWith("\n\n"), `${protocol} must end with a blank line`);
    for (const block of sse.split("\n\n").filter(Boolean)) {
      assert.ok(block.includes("\ndata: ") || block.startsWith("data: "), `${protocol} block missing data line`);
      for (const line of block.split("\n")) {
        assert.match(line, /^(event|data): /, `${protocol} unexpected line: ${line}`);
      }
    }
  }
});

test("renderStream: unknown protocol is rejected", () => {
  assertServiceError(() => renderStream("nope", { content: "x" }), { status: 400, code: "invalid_request" });
});

/* ------------------------------------------------------------- round trips */

test("each protocol can adapt, then render both shapes consistently", () => {
  const bodies = {
    "openai-chat": { model: "doubao-ai-translation", messages: [{ role: "user", content: "source" }] },
    "openai-responses": { model: "doubao-ai-translation", input: "source" },
    anthropic: { model: "doubao-ai-translation", messages: [{ role: "user", content: "source" }] },
  };
  for (const [protocol, body] of Object.entries(bodies)) {
    const request = adaptRequest(protocol, body, { headers: headers() });
    assert.equal(request.text, "source");
    const json = renderResponse(protocol, { model: request.model, content: "translated" });
    const sse = renderStream(protocol, { model: request.model, content: "translated" });
    assert.ok(JSON.stringify(json).includes("translated"));
    assert.ok(sse.includes("translated"));
  }
});
