// Translation-unit splitting and backfilling for the Doubao upstream.
//
// The upstream translates a flat list of plain-text strings and answers with a
// list of the same length. Anything that must survive the round trip verbatim --
// line breaks, blank lines and the standalone `%%` boundary lines -- is kept out
// of the strings that travel upstream and is re-attached by `rebuild`.
// Alignment is therefore structural: it never depends on the model echoing `%%`
// back, so a model that renders `%%` as "percent sign" cannot shift the output.
//
// The one invariant every function here protects:
//
//   rebuild(splitUnits(x, mode), collectTexts(splitUnits(x, mode))) === x
//
// for every plain-text `x` and every mode. That is why nothing in this module
// rejects, trims away or rewrites input: a unit is always a byte-exact slice of
// the original text and the separators are exactly the rest.

import { tooLarge, upstreamError } from "./errors.mjs";

/** The line a client may use on its own to mark a boundary between units. */
export const BATCH_SEPARATOR = "%%";

/** A line that is nothing but the boundary marker (surrounding spaces allowed). */
export const SEPARATOR_LINE = /^[ \t]*%%[ \t]*$/;

// A cue keeps its internal breaks; only the break run touching a boundary is
// moved into the separator. This mirrors the Worker, which only ever folds the
// newline run adjacent to `%%` into the separator -- never trailing spaces.
const LEADING_BREAKS = /^[\r\n]+/;
const TRAILING_BREAKS = /[\r\n]+$/;

const FOUR_BATCH_MESSAGE =
  "Text exceeds four batches (50 lines / 10,000 characters each).";

/**
 * Split `text` into lines that carry their own terminator, so that
 * `lines.map(({ body, break: brk }) => body + brk).join("") === text`.
 * The terminator is "" for the last line when the text does not end in a break.
 * @param {string} text
 * @returns {{ body: string, break: string }[]}
 */
function splitLines(text) {
  const lines = [];
  // Built per call: a module-level /g regex would leak `lastIndex` between calls.
  const pattern = /\r\n|\r|\n/g;
  let start = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    lines.push({ body: text.slice(start, match.index), break: match[0] });
    start = match.index + match[0].length;
  }
  lines.push({ body: text.slice(start), break: "" });
  return lines;
}

/**
 * `default` mode: every non-blank line is one unit, so a blank line is its own
 * separator-only unit and a `%%` line is a boundary unit.
 * @param {string} text
 * @returns {{ text: string, separator: string }[]}
 */
function splitDefault(text) {
  const segments = [];
  for (const { body, break: lineBreak } of splitLines(text)) {
    if (SEPARATOR_LINE.test(body) || body.trim() === "") {
      segments.push({ text: "", separator: body + lineBreak });
    } else {
      segments.push({ text: body, separator: lineBreak });
    }
  }
  return segments;
}

/**
 * `subtitle` mode: only a standalone `%%` line is a boundary, so a cue keeps its
 * internal line breaks verbatim.
 *
 * Implemented as a line walk rather than a split() regex on purpose. A regex
 * that anchors on `(break+ %% break*)` cannot see a `%%` on the very first line
 * (nothing precedes it) and, once it consumes the break after a `%%`, the next
 * `%%` of a `%%`/`%%` pair has no break left to anchor on -- both leaks put a
 * `%%` line into the text, which is exactly what must never happen.
 * @param {string} text
 * @returns {{ text: string, separator: string }[]}
 */
function splitSubtitle(text) {
  // 1. Fold the lines into alternating runs of cue material and boundary lines.
  //    Consecutive lines of the same kind collapse into one run.
  const runs = [];
  for (const { body, break: lineBreak } of splitLines(text)) {
    const kind = SEPARATOR_LINE.test(body) ? "boundary" : "cue";
    const raw = body + lineBreak;
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.raw += raw;
    else runs.push({ kind, raw });
  }

  // 2. Turn the runs into segments. `carry` holds separator material that still
  //    has to be appended to the segment before it (or, at the very start, to a
  //    separator-only placeholder).
  const segments = [];
  let carry = "";
  const attach = () => {
    if (!carry) return;
    const last = segments[segments.length - 1];
    if (last) last.separator += carry;
    else segments.push({ text: "", separator: carry });
    carry = "";
  };

  for (const run of runs) {
    if (run.kind === "boundary") {
      carry += run.raw;
      continue;
    }
    let raw = run.raw;
    // A break run opening a cue belongs to whatever came before it, so that a
    // cue never travels upstream with a leading newline glued to its text.
    const lead = LEADING_BREAKS.exec(raw);
    if (lead) {
      carry += lead[0];
      raw = raw.slice(lead[0].length);
    }
    attach();
    const trail = TRAILING_BREAKS.exec(raw);
    const tail = trail ? trail[0] : "";
    if (tail) raw = raw.slice(0, raw.length - tail.length);
    if (raw.trim()) {
      segments.push({ text: raw, separator: "" });
      carry = tail;
    } else {
      // Whitespace-only run: nothing to translate, keep it as separator material.
      carry = raw + tail;
    }
  }
  attach();
  return segments;
}

/**
 * `subtitle-context` is an alias of `subtitle`: the whole batch already travels
 * upstream as one `raw_text` array, so the model sees every cue's context. The
 * name is kept only because Read Frog already sends it.
 * @param {unknown} mode
 * @returns {"default" | "subtitle" | "subtitle-context"}
 */
function normalizeMode(mode) {
  // Tolerate the Worker's `{ mode }` shape as well as the documented positional
  // string, so a caller ported straight from worker.js still works.
  const raw = typeof mode === "string" ? mode : mode?.mode;
  const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (name === "subtitle" || name === "subtitle-context") return name;
  return "default";
}

/**
 * Split `text` into translation units.
 *
 * `text === ""` yields no units. Otherwise the units partition `text` exactly:
 * `segments.map((s) => s.text + s.separator).join("") === text`, and no
 * standalone `%%` line ever appears inside a `text`.
 * @param {string} text
 * @param {"default" | "subtitle" | "subtitle-context"} [mode]
 * @returns {{ text: string, separator: string }[]}
 */
export function splitUnits(text, mode = "default") {
  const value = text == null ? "" : typeof text === "string" ? text : String(text);
  const segments =
    normalizeMode(mode) === "default" ? splitDefault(value) : splitSubtitle(value);
  // Drop a trailing unit that carries neither text nor separator (it happens
  // when the input ends with a line break): it would only add noise downstream.
  while (segments.length) {
    const last = segments[segments.length - 1];
    if (last.text || last.separator) break;
    segments.pop();
  }
  return segments;
}

/**
 * The strings that actually travel upstream, in order. Separator-only units are
 * skipped, so `texts.length` is the number of translations to expect back.
 * @param {{ text: string, separator: string }[]} segments
 * @returns {string[]}
 */
export function collectTexts(segments) {
  const texts = [];
  for (const segment of segments ?? []) {
    if (segment && typeof segment.text === "string" && segment.text.length > 0) {
      texts.push(segment.text);
    }
  }
  return texts;
}

/**
 * Put the translations back where the original units were.
 *
 * Extra results are ignored; a missing or non-string result is a hard error
 * rather than the literal "undefined" leaking into the user's text.
 * @param {{ text: string, separator: string }[]} segments
 * @param {string[]} results one translation per unit with a non-empty `text`
 * @returns {string}
 */
export function rebuild(segments, results) {
  const list = Array.isArray(results) ? results : [];
  let index = 0;
  let output = "";
  for (const segment of segments ?? []) {
    if (!segment) continue;
    const separator = typeof segment.separator === "string" ? segment.separator : "";
    if (!segment.text) {
      output += separator;
      continue;
    }
    const translation = list[index++];
    if (typeof translation !== "string") {
      throw upstreamError(
        "Translation results do not align with the text units.",
        "upstream_incomplete_result",
        502,
      );
    }
    output += translation + separator;
  }
  return output;
}

// --- Sentence stitching (the `subtitle-context` mode) -----------------------
//
// A subtitle line is a *display* unit, not a linguistic one: one sentence is
// routinely split across several cues. Sent upstream one cue at a time, each
// fragment is translated in isolation and comes back with its subject or object
// missing ("I told him that" / "we should leave before" / "the storm hits.").
// The upstream has no prompt or context channel and does not use neighbouring
// array items as context, so the only cure is to translate the whole sentence.
//
// `mergeCues` glues the fragments back into sentences; `rebuildCues` spreads a
// merged translation across the original cues again, so the display keeps its
// line structure while each sentence is translated as a whole.

/** A cue that ends a sentence (terminator, optionally followed by closers). */
const SENTENCE_END = /[.!?…。！？]+["'”’)\]）】》」』]*\s*$/u;

/** True when `text` ends like a finished sentence. */
function endsSentence(text) {
  return SENTENCE_END.test(text);
}

/**
 * Stitch subtitle segments into sentence groups.
 *
 * Returns a flat list of nodes in document order:
 *   `{ kind: "literal", text }`            -- separator-only run, passes through
 *   `{ kind: "sentence", parts: Part[] }`  -- one or more cues translated as a whole
 *
 * A cue joins the open sentence unless the previous cue ended one; a sentence is
 * also closed once it grows past `maxChars`, so one runaway cue cannot swallow
 * the whole document and blow the per-unit limit.
 * @param {{ text: string, separator: string }[]} segments
 * @param {{ maxChars?: number }} [options]
 * @returns {({ kind: "literal", text: string } | { kind: "sentence", parts: { text: string, separator: string }[] })[]}
 */
export function mergeCues(segments, options = {}) {
  const { maxChars = 800 } = options ?? {};
  const nodes = [];
  let parts = [];
  let length = 0;
  const flush = () => {
    if (parts.length) nodes.push({ kind: "sentence", parts });
    parts = [];
    length = 0;
  };
  for (const segment of segments ?? []) {
    if (!segment) continue;
    const text = typeof segment.text === "string" ? segment.text : "";
    const separator = typeof segment.separator === "string" ? segment.separator : "";
    if (!text) {
      flush();
      nodes.push({ kind: "literal", text: separator });
      continue;
    }
    parts.push({ text, separator });
    length += text.length;
    if (endsSentence(text) || length >= maxChars) flush();
  }
  flush();
  return nodes;
}

/**
 * The strings that travel upstream for stitched nodes: one per sentence, its
 * cues joined by a single space so the sentence reads as one line.
 * @param {ReturnType<typeof mergeCues>} nodes
 * @returns {string[]}
 */
export function collectCues(nodes) {
  const texts = [];
  for (const node of nodes ?? []) {
    if (node && node.kind === "sentence") {
      texts.push(node.parts.map((part) => part.text.trim()).join(" "));
    }
  }
  return texts;
}

/**
 * Pick a cut offset near `target` that falls on whitespace, so words are not
 * split in two. Falls back to the exact offset for scripts without spaces.
 */
function snapCut(text, target, floor) {
  const window = Math.max(2, Math.round(text.length * 0.15));
  // A piece must never *start* with a closing mark such as a comma, or the
  // rebuilt cue reads "，会议改到周四了。" instead of "会议改到周四了。".
  const closers = /[，。、；：！？…」』）】》〉〞"'”’]/u;
  // Ending a piece right after one of these is a natural phrase boundary.
  const breaks = /[，。、；：！？…\s]/u;

  let bestPunctuation = -1;
  for (let delta = 0; delta <= window; delta += 1) {
    for (const offset of [target - delta, target + delta]) {
      if (offset <= floor || offset >= text.length) continue;
      const before = text[offset - 1] ?? "";
      const after = text[offset] ?? "";
      if (/\s/.test(before)) return offset; // a space is the ideal cut
      if (breaks.test(before) && !closers.test(after)) {
        if (bestPunctuation === -1 || Math.abs(offset - target) < Math.abs(bestPunctuation - target)) {
          bestPunctuation = offset;
        }
      }
    }
  }
  if (bestPunctuation !== -1) return bestPunctuation;

  // Scripts with neither spaces nor punctuation: just avoid opening on a closer.
  for (let delta = 0; delta <= window; delta += 1) {
    for (const offset of [target - delta, target + delta]) {
      if (offset > floor && offset < text.length && !closers.test(text[offset] ?? "")) {
        return offset;
      }
    }
  }
  return Math.min(Math.max(target, floor), text.length);
}

/**
 * Spread one merged translation back over its cues, by relative source length.
 * A translation that kept the cue line breaks verbatim is split on them exactly;
 * otherwise the characters are divided in proportion to each cue's own length.
 * @param {string} translation
 * @param {{ text: string }[]} parts
 * @returns {string[]} one piece per part
 */
export function splitMerged(translation, parts) {
  const value = typeof translation === "string" ? translation : "";
  const count = parts?.length ?? 0;
  if (count <= 1) return [value];

  const lines = value.split(/\r\n|\r|\n/);
  // Only trust the kept line breaks when every line carries text; a trailing
  // break ("x\n") would otherwise produce an empty cue.
  if (lines.length === count && lines.every((line) => line.trim() !== "")) {
    return lines.map((line) => line.trim());
  }

  const weights = parts.map((part) => Math.max(1, (part.text ?? "").trim().length));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const pieces = [];
  let floor = 0;
  let acc = 0;
  for (let index = 0; index < count; index += 1) {
    acc += weights[index];
    let cut;
    if (index === count - 1) {
      cut = value.length;
    } else {
      // Keep every cut strictly ahead of the previous one. snapCut can return
      // `floor` itself for very short translations, which used to emit empty
      // cues; give this cue at least one character and reserve the rest.
      const remaining = count - index - 1;
      const maxCut = Math.max(floor + 1, value.length - remaining);
      cut = snapCut(value, Math.round((acc / total) * value.length), floor);
      cut = Math.min(Math.max(cut, floor + 1), maxCut);
    }
    pieces.push(value.slice(floor, cut).trim());
    floor = cut;
  }
  return pieces;
}

/**
 * Rebuild the document from stitched nodes and their merged translations.
 * @param {ReturnType<typeof mergeCues>} nodes
 * @param {string[]} results one translation per sentence node, in order
 * @returns {string}
 */
export function rebuildCues(nodes, results) {
  const list = Array.isArray(results) ? results : [];
  let index = 0;
  let output = "";
  for (const node of nodes ?? []) {
    if (!node) continue;
    if (node.kind === "literal") {
      output += node.text ?? "";
      continue;
    }
    const translation = list[index++];
    if (typeof translation !== "string") {
      throw upstreamError(
        "Translation results do not align with the text units.",
        "upstream_incomplete_result",
        502,
      );
    }
    const pieces = splitMerged(translation, node.parts);
    node.parts.forEach((part, partIndex) => {
      output += (pieces[partIndex] ?? "") + (part.separator ?? "");
    });
  }
  return output;
}

/**
 * Group units into upstream batches: at most `size` units and at most `chars`
 * characters per batch, at most `maxBatches` batches in total.
 *
 * A single unit longer than `chars` still gets a batch of its own (the upstream
 * rejects an empty batch); it is never split, because splitting it would break
 * the one-to-one alignment `rebuild` relies on.
 * @param {string[]} texts
 * @param {{ size?: number, chars?: number, maxBatches?: number }} [options]
 * @returns {string[][]}
 */
export function planBatches(texts, options = {}) {
  const { size = 50, chars = 10000, maxBatches = 4 } = options ?? {};
  const batches = [];
  let current = [];
  let currentLength = 0;
  for (const text of texts ?? []) {
    const value = typeof text === "string" ? text : String(text ?? "");
    // `current.length > 0` keeps an over-long unit from emitting an empty batch.
    if (current.length > 0 && (current.length >= size || currentLength + value.length > chars)) {
      batches.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(value);
    currentLength += value.length;
  }
  if (current.length > 0) batches.push(current);
  if (batches.length > maxBatches) {
    // The contract's error table maps request_too_large to 413.
    throw tooLarge(FOUR_BATCH_MESSAGE);
  }
  return batches;
}
