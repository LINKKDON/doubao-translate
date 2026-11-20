// Tests for the translation-unit splitter/backfiller.
//
// The load-bearing property is idempotency: for ANY plain-text input and ANY
// mode, rebuilding from the untouched units must reproduce the input byte for
// byte. Everything else in the pipeline (batching, upstream calls, model
// quirks) is allowed to change the *texts*, never the separators.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BATCH_SEPARATOR,
  SEPARATOR_LINE,
  collectCues,
  collectTexts,
  mergeCues,
  planBatches,
  rebuild,
  rebuildCues,
  splitMerged,
  splitUnits,
} from "../src/units.mjs";
import { ServiceError } from "../src/errors.mjs";

const MODES = ["default", "subtitle", "subtitle-context"];

/** The invariant under test, for one mode. */
function roundTrip(text, mode) {
  const segments = splitUnits(text, mode);
  return rebuild(segments, collectTexts(segments));
}

const EDGE_CASES = [
  ["empty string", ""],
  ["only a separator", "%%"],
  ["separator with trailing newline", "%%\n"],
  ["leading separator", "%%\na"],
  ["trailing separator", "a\n%%"],
  ["trailing separator, no newline", "a\n%%"],
  ["separators on both ends", "%%\na\n%%"],
  ["only separators", "%%\n%%"],
  ["crlf line endings", "a\r\nb\r\n"],
  ["crlf with separator", "a\r\n%%\r\nb"],
  ["cr-only line endings", "a\rb\r"],
  ["separator with spaces around", "a\n  %%  \nb"],
  ["separator with tabs around", "a\n\t%%\t\nb"],
  ["consecutive separators", "a\n%%\n%%\nb"],
  ["three consecutive separators", "a\n%%\n%%\n%%\nb"],
  ["leading consecutive separators", "%%\n%%\nb"],
  ["paragraph with blank line", "a\n\nb"],
  ["paragraph with many blank lines", "a\n\n\n\nb"],
  ["whitespace-only line", "a\n   \nb"],
  ["whitespace-only line with tabs", "a\n\t\t\nb"],
  ["no trailing newline", "a\nb"],
  ["one trailing newline", "a\nb\n"],
  ["many trailing newlines", "a\nb\n\n\n"],
  ["leading newlines", "\n\na"],
  ["only whitespace", "   \n\t\n"],
  ["only newlines", "\n\n\n"],
  ["separator between paragraphs", "p1\n\n%%\n\np2"],
  ["text that merely contains %%", "a %% b"],
  ["half a separator", "%"],
  ["triple percent inline", "a %%% b"],
  ["separator-like with text", "%% not a boundary %%"],
  ["inline %% at line start", "%%a"],
  ["mixed crlf and lf", "a\r\nb\nc"],
  ["multi-line cue", "line one\nline two\nline three"],
  ["multi-line cue with blank inside", "line one\n\nline three"],
  ["cue with trailing spaces", "a   \nb"],
  ["cue with leading spaces", "   a\nb"],
  ["unicode text", "你好\n世界\n%%\nこんにちは"],
];

for (const mode of MODES) {
  test(`idempotent for every edge case (${mode})`, () => {
    for (const [label, input] of EDGE_CASES) {
      assert.equal(roundTrip(input, mode), input, `edge case: ${label}`);
    }
  });
}

test("idempotent for a deterministic fuzz corpus", () => {
  // A small xorshift PRNG: reproducible failures, no dependency.
  let state = 0x2f6e2b1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  const alphabet = [
    "a", "b", "Z", " ", "\t", "\n", "\r\n", "\r", "%", "%%", "%%%",
    "你", "好", "\u00a0", "-",
  ];

  for (let round = 0; round < 400; round += 1) {
    let input = "";
    const parts = next() % 14;
    for (let i = 0; i < parts; i += 1) input += alphabet[next() % alphabet.length];
    for (const mode of MODES) {
      assert.equal(
        roundTrip(input, mode),
        input,
        `fuzz round ${round} (${mode}) input=${JSON.stringify(input)}`,
      );
    }
  }
});

test("units always partition the input exactly", () => {
  for (const [label, input] of EDGE_CASES) {
    for (const mode of MODES) {
      const segments = splitUnits(input, mode);
      const joined = segments.map((s) => s.text + s.separator).join("");
      assert.equal(joined, input, `partition (${mode}): ${label}`);
      for (const segment of segments) {
        assert.equal(typeof segment.text, "string");
        assert.equal(typeof segment.separator, "string");
      }
    }
  }
});

test("a standalone %% line never lands in text", () => {
  for (const [label, input] of EDGE_CASES) {
    for (const mode of MODES) {
      for (const segment of splitUnits(input, mode)) {
        // Only a *standalone* `%%` line is a boundary. An inline `%%` (e.g.
        // "a %% b") is ordinary text and must stay in `text`, otherwise the
        // round trip could not reproduce the input.
        assert.ok(
          !SEPARATOR_LINE.test(segment.text),
          `%% leaked into text (${mode}): ${label} -> ${JSON.stringify(segment.text)}`,
        );
        // No line of a text may be a boundary line either.
        for (const line of segment.text.split(/\r\n|\r|\n/)) {
          assert.ok(
            !SEPARATOR_LINE.test(line),
            `%% line leaked into text (${mode}): ${label} -> ${JSON.stringify(segment.text)}`,
          );
        }
      }
    }
  }
});

test("separator-only units carry no text", () => {
  for (const mode of MODES) {
    for (const segment of splitUnits("%%\n%%\na", mode)) {
      if (segment.text === "") assert.ok(segment.separator.length > 0);
    }
  }
});

test("exports and constants match the contract", () => {
  assert.equal(BATCH_SEPARATOR, "%%");
  assert.ok(SEPARATOR_LINE.test("%%"));
  assert.ok(SEPARATOR_LINE.test("  %%  "));
  assert.ok(SEPARATOR_LINE.test("\t%%\t"));
  assert.ok(!SEPARATOR_LINE.test("%%a"));
  assert.ok(!SEPARATOR_LINE.test("a%%"));
  assert.ok(!SEPARATOR_LINE.test("%"));
  assert.equal(typeof splitUnits, "function");
  assert.equal(typeof collectTexts, "function");
  assert.equal(typeof rebuild, "function");
  assert.equal(typeof planBatches, "function");
});

test("splitUnits returns an empty list for empty input", () => {
  for (const mode of MODES) {
    assert.deepEqual(splitUnits("", mode), []);
  }
});

test("default mode: one unit per non-blank line", () => {
  const segments = splitUnits("one\ntwo\n\nthree\n", "default");
  assert.deepEqual(
    segments.map((s) => s.text),
    ["one", "two", "", "three"],
  );
  assert.deepEqual(
    segments.map((s) => s.separator),
    ["\n", "\n", "\n", "\n"],
  );
  assert.deepEqual(collectTexts(segments), ["one", "two", "three"]);
});

test("default mode: a %% line is a boundary, not a unit", () => {
  const segments = splitUnits("a\n%%\nb", "default");
  assert.deepEqual(collectTexts(segments), ["a", "b"]);
  assert.deepEqual(segments, [
    { text: "a", separator: "\n" },
    { text: "", separator: "%%\n" },
    { text: "b", separator: "" },
  ]);
});

test("subtitle mode keeps internal newlines inside one unit", () => {
  const segments = splitUnits("line one\nline two\n%%\nline three", "subtitle");
  assert.deepEqual(collectTexts(segments), ["line one\nline two", "line three"]);
});

test("subtitle mode keeps blank lines inside a cue", () => {
  const segments = splitUnits("a\n\nb\n%%\nc", "subtitle");
  assert.deepEqual(collectTexts(segments), ["a\n\nb", "c"]);
});

test("subtitle mode handles a leading separator", () => {
  const segments = splitUnits("%%\na", "subtitle");
  assert.deepEqual(collectTexts(segments), ["a"]);
  assert.equal(rebuild(segments, ["A"]), "%%\nA");
});

test("subtitle mode handles consecutive separators", () => {
  const segments = splitUnits("a\n%%\n%%\nb", "subtitle");
  assert.deepEqual(collectTexts(segments), ["a", "b"]);
  assert.equal(rebuild(segments, ["A", "B"]), "A\n%%\n%%\nB");
});

test("subtitle-context is an alias of subtitle", () => {
  for (const [label, input] of EDGE_CASES) {
    assert.deepEqual(
      splitUnits(input, "subtitle-context"),
      splitUnits(input, "subtitle"),
      label,
    );
  }
});

test("an unknown or missing mode falls back to default", () => {
  assert.deepEqual(splitUnits("a\nb", undefined), splitUnits("a\nb", "default"));
  assert.deepEqual(splitUnits("a\nb", "nonsense"), splitUnits("a\nb", "default"));
  assert.deepEqual(splitUnits("a\nb", ""), splitUnits("a\nb", "default"));
});

test("the Worker's { mode } shape is accepted", () => {
  assert.deepEqual(
    splitUnits("a\nb", { mode: "subtitle" }),
    splitUnits("a\nb", "subtitle"),
  );
});

test("mode names are case-insensitive and trimmed", () => {
  assert.deepEqual(splitUnits("a\nb", " Subtitle "), splitUnits("a\nb", "subtitle"));
});

test("collectTexts skips separator-only units and preserves order", () => {
  const segments = [
    { text: "", separator: "%%\n" },
    { text: "a", separator: "\n" },
    { text: "", separator: "\n" },
    { text: "b", separator: "" },
  ];
  assert.deepEqual(collectTexts(segments), ["a", "b"]);
  assert.deepEqual(collectTexts([]), []);
  assert.deepEqual(collectTexts(undefined), []);
});

test("rebuild re-inserts separators verbatim between translations", () => {
  const segments = splitUnits("hello\n%%\nworld", "default");
  assert.equal(rebuild(segments, ["你好", "世界"]), "你好\n%%\n世界");
});

test("rebuild ignores whatever the model did to %%, including dropping it", () => {
  const source = "first\n%%\nsecond\n%%\nthird";
  const segments = splitUnits(source, "default");
  const texts = collectTexts(segments);
  assert.equal(texts.length, 3);

  // Exactly one result per unit; the model is free to mangle the marker in any
  // of the four ways the contract calls out, or to ignore it entirely.
  const mutations = [
    ["verbatim", ["FIRST", "%%", "SECOND"], "SECOND"],
    ["fullwidth", ["FIRST", "％％", "SECOND"], "SECOND"],
    ["empty", ["FIRST", "", "SECOND"], "SECOND"],
    ["word", ["FIRST", "百分号", "SECOND"], "SECOND"],
    ["absorbed", ["FIRST %% SECOND", "", "THIRD"], "THIRD"],
  ];

  for (const [label, results, last] of mutations) {
    const output = rebuild(segments, results);
    // The separators are the original ones, in their original order, whatever
    // the model said: rebuild only ever interleaves results with separators.
    assert.equal(output, results.join("\n%%\n"), label);
    assert.ok(output.startsWith("FIRST"), label);
    assert.ok(output.endsWith(last), label);
  }
});

test("rebuild tolerates extra results but rejects a missing one", () => {
  const segments = splitUnits("a\nb", "default");
  assert.equal(rebuild(segments, ["A", "B", "EXTRA"]), "A\nB");
  assert.throws(
    () => rebuild(segments, ["A"]),
    (error) => error instanceof ServiceError && error.code === "upstream_incomplete_result",
  );
});

test("planBatches honours the size limit", () => {
  const texts = Array.from({ length: 120 }, (_, i) => `line ${i}`);
  const batches = planBatches(texts, { size: 50 });
  assert.equal(batches.length, 3);
  assert.equal(batches[0].length, 50);
  assert.equal(batches[1].length, 50);
  assert.equal(batches[2].length, 20);
  assert.deepEqual(batches.flat(), texts);
});

test("planBatches honours the character limit", () => {
  const texts = Array.from({ length: 10 }, () => "0123456789"); // 10 chars each
  // 5 batches, so the default 4-batch ceiling has to be raised for this probe.
  const batches = planBatches(texts, { chars: 25, maxBatches: 10 });
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [2, 2, 2, 2, 2],
  );
  assert.deepEqual(batches.flat(), texts);
});

test("planBatches defaults to 50 lines / 10,000 characters / 4 batches", () => {
  const ok = planBatches(Array.from({ length: 200 }, () => "x"));
  assert.equal(ok.length, 4);
  assert.equal(ok[0].length, 50);

  const exact = planBatches(Array.from({ length: 4 }, () => "a".repeat(10000)));
  assert.equal(exact.length, 4);
});

test("planBatches rejects more than four batches", () => {
  const texts = Array.from({ length: 201 }, () => "x");
  assert.throws(
    () => planBatches(texts),
    (error) => {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.code, "request_too_large");
      assert.equal(
        error.message,
        "Text exceeds four batches (50 lines / 10,000 characters each).",
      );
      return true;
    },
  );
});

test("planBatches never splits a unit and never emits an empty batch", () => {
  const long = "y".repeat(12000);
  const batches = planBatches(["a", long, "b"], { chars: 100 });
  assert.deepEqual(batches, [["a"], [long], ["b"]]);
  for (const batch of batches) assert.ok(batch.length > 0);
});

test("planBatches of no texts is no batches", () => {
  assert.deepEqual(planBatches([]), []);
  assert.deepEqual(planBatches([], { size: 1 }), []);
});

test("planBatches keeps order across a realistic mixed input", () => {
  const text = [
    "第一段第一行",
    "第一段第二行",
    "%%",
    "第二段",
    "%%",
    "第三段",
  ].join("\n");
  for (const mode of MODES) {
    const texts = collectTexts(splitUnits(text, mode));
    const batches = planBatches(texts);
    assert.deepEqual(batches.flat(), texts);
    const output = rebuild(splitUnits(text, mode), texts.map((t) => `<${t}>`));
    assert.equal(output.split("%%").length - 1, 2);
  }
});

/* --------------------------------------------- sentence stitching (subtitle-context) */

test("mergeCues joins fragments until a cue ends the sentence", () => {
  const text = [
    "I told him that",
    "%%",
    "we should leave before",
    "%%",
    "the storm hits.",
    "%%",
    "See you soon.",
  ].join("\n");
  const nodes = mergeCues(splitUnits(text, "subtitle"));

  const sentences = nodes.filter((node) => node.kind === "sentence");
  assert.equal(sentences.length, 2, "two sentences");
  assert.equal(sentences[0].parts.length, 3, "first sentence spans three cues");
  assert.equal(sentences[1].parts.length, 1, "second sentence is one cue");
  assert.deepEqual(collectCues(nodes), [
    "I told him that we should leave before the storm hits.",
    "See you soon.",
  ]);
});

test("mergeCues keeps every separator so `%%` never reaches the upstream", () => {
  const text = "A1\n%%\nA2 continues.\n%%\nB ends.";
  const nodes = mergeCues(splitUnits(text, "subtitle"));
  for (const text of collectCues(nodes)) {
    assert.ok(!text.includes("%%"), "no boundary marker inside an upstream string");
  }
  // Every cue's separator is carried by its part, so nothing is lost.
  const separators = nodes
    .filter((node) => node.kind === "sentence")
    .flatMap((node) => node.parts.map((part) => part.separator));
  assert.equal(separators.filter((sep) => sep.includes("%%")).length, 2);
});

test("mergeCues closes a runaway group at maxChars", () => {
  const cues = Array.from({ length: 12 }, (_, index) => `fragment ${index} without a terminator`);
  const text = cues.join("\n%%\n");
  const nodes = mergeCues(splitUnits(text, "subtitle"), { maxChars: 60 });
  const sentences = nodes.filter((node) => node.kind === "sentence");
  assert.ok(sentences.length > 1, "a long run without a period is split into several groups");
  for (const sentence of sentences) {
    // A group is closed as soon as it reaches maxChars, so everything before its
    // last cue must still be under the limit -- that is the real invariant.
    const beforeLast = sentence.parts
      .slice(0, -1)
      .reduce((sum, part) => sum + part.text.length, 0);
    assert.ok(beforeLast < 60, "each group is closed as soon as it reaches maxChars");
  }
  // Every cue is carried exactly once, so nothing is dropped by the split.
  const carried = sentences.reduce((sum, sentence) => sum + sentence.parts.length, 0);
  assert.equal(carried, 12);
});

test("splitMerged splits on newlines when the translation keeps them", () => {
  const parts = [{ text: "a" }, { text: "b" }, { text: "c" }];
  assert.deepEqual(splitMerged("一\n二\n三", parts), ["一", "二", "三"]);
});

test("splitMerged divides proportionally when the newlines are gone", () => {
  const parts = [{ text: "aaaaaaaa" }, { text: "bb" }];
  const pieces = splitMerged("一二三四五六七八九十", parts);
  assert.equal(pieces.length, 2);
  assert.equal(pieces.join(""), "一二三四五六七八九十", "no characters are dropped");
  assert.ok(pieces[0].length > pieces[1].length, "the longer cue gets the larger share");
});

test("splitMerged returns the whole string for a single cue", () => {
  assert.deepEqual(splitMerged("only one", [{ text: "only" }]), ["only one"]);
});

test("rebuildCues puts each piece back on its own cue and restores separators", () => {
  const text = "A1\n%%\nA2 ends.\n%%\nB1\n%%\nB2 ends.";
  const nodes = mergeCues(splitUnits(text, "subtitle"));
  const pieces = ["甲一\n甲二", "乙一\n乙二"];
  assert.equal(rebuildCues(nodes, pieces), "甲一\n%%\n甲二\n%%\n乙一\n%%\n乙二");
});

test("rebuildCues rejects a missing translation instead of writing 'undefined'", () => {
  const nodes = mergeCues(splitUnits("A ends.\n%%\nB ends.", "subtitle"));
  assert.throws(() => rebuildCues(nodes, ["only one"]), (error) => {
    assert.ok(error instanceof ServiceError);
    assert.equal(error.code, "upstream_incomplete_result");
    return true;
  });
});

test("splitMerged never opens a piece with a closing mark when the source has no spaces", () => {
  const parts = [{ text: "The meeting has been" }, { text: "moved to Thursday" }, { text: "because of the holiday." }];
  const pieces = splitMerged("因为假期，会议改到周四了。", parts);
  assert.equal(pieces.length, 3);
  for (const piece of pieces) {
    assert.ok(piece.length > 0, "no empty piece");
    assert.ok(!/^[，。、；：！？…]/u.test(piece), `piece must not open with punctuation: ${JSON.stringify(piece)}`);
  }
  assert.equal(pieces.join(""), "因为假期，会议改到周四了。", "no characters are dropped");
});

test("splitMerged distributes a short translation without losing characters", () => {
  // Regression: snapCut used to return `floor` for short text, so every extra
  // cue collapsed onto the same offset. Characters were dropped only via the
  // empty pieces this produced downstream; guard the invariant instead.
  const three = splitMerged("译", [{ text: "a" }, { text: "b" }, { text: "c" }]);
  assert.equal(three.length, 3);
  assert.equal(three.join(""), "译", "no characters are dropped");

  const five = splitMerged("abc", [
    { text: "aa" },
    { text: "bb" },
    { text: "cc" },
    { text: "dd" },
    { text: "ee" },
  ]);
  assert.equal(five.length, 5);
  assert.equal(five.join(""), "abc", "no characters are dropped");
  assert.equal(five.filter((piece) => piece !== "").length, 3, "one piece per available character");
});

test("splitMerged puts the only character on the first cue, never in front of it", () => {
  const pieces = splitMerged("译", [{ text: "a" }, { text: "b" }, { text: "c" }]);
  assert.equal(pieces[0], "译", "the first cue carries the text");
});

test("splitMerged ignores a trailing line break instead of splitting on it", () => {
  const pieces = splitMerged("x\n", [{ text: "a" }, { text: "b" }]);
  assert.equal(pieces.length, 2);
  assert.equal(pieces.join(""), "x", "no characters are dropped");
  assert.equal(pieces.filter((piece) => piece !== "").length, 1);
});
