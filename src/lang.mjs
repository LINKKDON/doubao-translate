// Language normalisation for the magpie plugin.
//
// The Worker (`worker.js`) normalises every incoming language name/code to a
// Doubao language tag and never lets a Read Frog client fail on a name it does
// not know. This module is a straight port of that behaviour with one change:
// the low-level helpers never throw, they return `null`. Only
// `requireLanguage` (and `resolveTargetLanguage`'s explicit/conflict paths)
// raise a ServiceError.
//
// The two tables below are inlined from the Worker's first line so the plugin
// stays a zero-dependency, `file://`-loadable ESM module: no file reads, no
// network, no /tmp.

import { invalid } from "./errors.mjs";

// Doubao language tags. The Worker's 141 codes keep their exact order; the
// codes appended after them are the extra tags Read Frog's 180 `englishName`s
// resolve to (the Worker table simply had no entry for those languages, e.g.
// `Maithili`, `Cebuano`, `Tetum`).
export const KNOWN_LANGS = Object.freeze(["zh", "zh-Hant", "en", "ja", "ko", "fr", "de", "es", "es-ES", "pt", "ru", "ar", "it", "id", "ms", "th", "vi", "fil", "uz", "bn", "hi", "jv", "te", "mr", "ta", "tr", "ur", "gu", "pl", "uk", "kn", "ml", "fa", "my", "sw", "su", "ro", "pa", "am", "ha", "ff", "bs", "hr", "nl", "sr", "ku", "yo", "ig", "ne", "hu", "az", "si", "el", "cs", "be", "ny", "rw", "zu", "bg", "sv", "ln", "so", "kk", "he", "nb", "nn", "af", "sq", "as", "eu", "br", "ca", "co", "cy", "da", "dv", "eo", "et", "fo", "fj", "fi", "fy", "gd", "ga", "gl", "gn", "ht", "hy", "io", "ia", "is", "ka", "km", "ky", "lo", "la", "lv", "lt", "lb", "mk", "mt", "mn", "mi", "oc", "or", "om", "sa", "sk", "sl", "sm", "sn", "sd", "st", "ty", "tt", "tg", "ti", "to", "tn", "tk", "ug", "vo", "wo", "xh", "yi", "ak", "bm", "bi", "bo", "ce", "cv", "dz", "ee", "lg", "os", "ss", "ve", "nd", "nr", "ch", "mh", "ace", "ban", "bho", "bik", "bjn", "bug", "ceb", "gil", "haw", "hif", "hil", "hms", "hnj", "ilo", "kab", "koi", "mad", "mag", "mai", "mak", "mg", "min", "niu", "nso", "pam", "pau", "ps", "qug", "rar", "rn", "sas", "skr", "tet", "tvl", "war", "wls", "za"]);

// Lowercased language name -> tag. The Worker's 170 entries come first (their
// insertion order drives the display-name table below), followed by the names
// added so all 180 Read Frog names resolve.
export const LANGUAGE_NAMES = Object.freeze({
  "traditional chinese": "zh-Hant",
  "simplified chinese": "zh",
  "chinese": "zh",
  "繁体中文": "zh-Hant",
  "繁體中文": "zh-Hant",
  "简体中文": "zh",
  "中文": "zh",
  "english": "en",
  "英文": "en",
  "英语": "en",
  "japanese": "ja",
  "日文": "ja",
  "日语": "ja",
  "korean": "ko",
  "韩文": "ko",
  "韩语": "ko",
  "french": "fr",
  "german": "de",
  "spanish": "es",
  "portuguese": "pt",
  "russian": "ru",
  "arabic": "ar",
  "italian": "it",
  "indonesian": "id",
  "malay": "ms",
  "thai": "th",
  "vietnamese": "vi",
  "filipino": "fil",
  "tagalog": "fil",
  "uzbek": "uz",
  "zh-cn": "zh",
  "zh-hans": "zh",
  "zh-tw": "zh-Hant",
  "zh-hk": "zh-Hant",
  "simplified mandarin chinese": "zh",
  "traditional mandarin chinese": "zh-Hant",
  "cantonese": "zh",
  "standard arabic": "ar",
  "bengali": "bn",
  "hindi": "hi",
  "javanese (javanese)": "jv",
  "javanese": "jv",
  "telugu": "te",
  "marathi": "mr",
  "tamil": "ta",
  "turkish": "tr",
  "urdu": "ur",
  "gujarati": "gu",
  "polish": "pl",
  "ukrainian": "uk",
  "kannada": "kn",
  "malayalam": "ml",
  "iranian persian": "fa",
  "burmese": "my",
  "swahili (individual language)": "sw",
  "swahili": "sw",
  "sundanese": "su",
  "romanian": "ro",
  "panjabi": "pa",
  "amharic": "am",
  "hausa": "ha",
  "nigerian fulfulde": "ff",
  "bosnian (cyrillic)": "bs",
  "bosnian": "bs",
  "croatian": "hr",
  "dutch": "nl",
  "serbian (cyrillic)": "sr",
  "serbian": "sr",
  "central kurdish": "ku",
  "yoruba": "yo",
  "northern uzbek (cyrillic)": "uz",
  "northern uzbek": "uz",
  "malay (individual language) (arabic)": "ms",
  "igbo": "ig",
  "nepali (individual language)": "ne",
  "nepali": "ne",
  "hungarian": "hu",
  "north azerbaijani (cyrillic)": "az",
  "north azerbaijani": "az",
  "sinhala": "si",
  "modern greek (1453-)": "el",
  "modern greek": "el",
  "czech": "cs",
  "belarusian": "be",
  "nyanja": "ny",
  "kinyarwanda": "rw",
  "zulu": "zu",
  "bulgarian": "bg",
  "swedish": "sv",
  "lingala": "ln",
  "somali": "so",
  "kazakh": "kk",
  "hebrew": "he",
  "norwegian bokmål": "nb",
  "norwegian nynorsk": "nn",
  "afrikaans": "af",
  "albanian": "sq",
  "assamese": "as",
  "basque": "eu",
  "breton": "br",
  "catalan": "ca",
  "corsican": "co",
  "welsh": "cy",
  "danish": "da",
  "divehi": "dv",
  "esperanto": "eo",
  "estonian": "et",
  "faroese": "fo",
  "fijian": "fj",
  "finnish": "fi",
  "western frisian": "fy",
  "scottish gaelic": "gd",
  "irish": "ga",
  "galician": "gl",
  "guarani": "gn",
  "haitian creole": "ht",
  "armenian": "hy",
  "ido": "io",
  "interlingua": "ia",
  "icelandic": "is",
  "georgian": "ka",
  "khmer": "km",
  "kyrgyz": "ky",
  "lao": "lo",
  "latin": "la",
  "latvian": "lv",
  "lithuanian": "lt",
  "luxembourgish": "lb",
  "macedonian": "mk",
  "maltese": "mt",
  "mongolian": "mn",
  "maori": "mi",
  "occitan": "oc",
  "odia": "or",
  "oromo": "om",
  "sanskrit": "sa",
  "slovak": "sk",
  "slovenian": "sl",
  "samoan": "sm",
  "shona": "sn",
  "sindhi": "sd",
  "southern sotho": "st",
  "tahitian": "ty",
  "tatar": "tt",
  "tajik": "tg",
  "tigrinya": "ti",
  "tongan": "to",
  "tswana": "tn",
  "turkmen": "tk",
  "uyghur": "ug",
  "volapük": "vo",
  "wolof": "wo",
  "xhosa": "xh",
  "eastern yiddish": "yi",
  "akan": "ak",
  "bambara": "bm",
  "bislama": "bi",
  "tibetan": "bo",
  "chechen": "ce",
  "chuvash": "cv",
  "dzongkha": "dz",
  "ewe": "ee",
  "ganda": "lg",
  "ossetian": "os",
  "swati": "ss",
  "venda": "ve",
  "north ndebele": "nd",
  "south ndebele": "nr",
  "chamorro": "ch",
  "marshallese": "mh",
  "maithili": "mai",
  "bhojpuri": "bho",
  "cebuano": "ceb",
  "saraiki": "skr",
  "azerbaijani": "az",
  "komi-permyak": "koi",
  "magahi": "mag",
  "rundi": "rn",
  "plateau malagasy": "mg",
  "chimborazo highland quichua": "qug",
  "madurese": "mad",
  "yongbei zhuang": "za",
  "northern pashto": "ps",
  "southern qiandong miao": "hms",
  "hmong njua": "hnj",
  "iloko": "ilo",
  "hawaiian": "haw",
  "northern sotho": "nso",
  "dari": "fa",
  "kabyle": "kab",
  "waray": "war",
  "pampanga": "pam",
  "hiligaynon": "hil",
  "central bikol": "bik",
  "minangkabau": "min",
  "acehnese": "ace",
  "buginese": "bug",
  "balinese": "ban",
  "banjar": "bjn",
  "makasar": "mak",
  "sasak": "sas",
  "tetum": "tet",
  "niuean": "niu",
  "tuvaluan": "tvl",
  "gilbertese": "gil",
  "palauan": "pau",
  "wallisian": "wls",
  "rarotongan": "rar",
  "fiji hindi": "hif",
});

// A few ISO codes that the Worker spelled differently, or that Read Frog sends
// in place of the Worker's tag. Kept out of LANGUAGE_NAMES so they never leak
// into `languageName` as a display name.
// Codes a client may send that are not a tag we translate into. Two groups:
// a language Read Frog names with its own code but Doubao spells as a broader
// tag (`yue`, `ckb`), and the deprecated ISO 639-1 codes still emitted by older
// browser and library versions (`iw`, `in`, `jw`, `ji`, `mo`, `tl`, `no`).
const CODE_ALIASES = Object.freeze({
  yue: "zh",
  "zh-yue": "zh",
  ckb: "ku",
  iw: "he",
  in: "id",
  jw: "jv",
  ji: "yi",
  mo: "ro",
  tl: "fil",
  no: "nb",
  prs: "fa",
});

// "Translate to Japanese", "翻译成日语", "Target language: Japanese" — the
// group captures the whole phrase after the directive so `normalizeLanguage`
// can decide whether it is a language it knows.
export const LANGUAGE_PATTERN =
  /(?:\btranslate\b[^\n:：]{0,160}?\b(?:to|into)\s+|翻译(?:成|为)|(?:target|output)\s+language\s*[:：]\s*)([^\n:：.!]+)(?=[:：.!]|$)/i;

// Trailing punctuation a client (or the pattern above) may leave attached to a
// language name: "Japanese." / "日语。" / "English,". Parentheses are excluded
// on purpose — names such as "Modern Greek (1453-)" end with one.
const TRAILING_PUNCT = /[\s:：,，.。;；!！?？、"'“”‘’]+$/;

// Detected before parentheses are stripped, so "(Traditional)" still counts.
const TRADITIONAL_HINT = /traditional|hant|taiwan|hong\s?kong/;

// Qualifiers the Worker drops before retrying a lookup ("Modern Greek" ->
// "greek" is not a name, but "Simplified Chinese" -> "chinese" is).
const QUALIFIERS =
  /\b(simplified|traditional|standard|modern|literary|mandarin|the|language)\b/g;

// Keys that are codes rather than human names; skipped when building display
// names ("zh-cn", "zh-hans", "zh-tw").
const CODE_LIKE = /^[a-z]{2,3}(?:-[a-z0-9]{2,10})*$/;

/**
 * `zh`/`zh-Hant` for a `xx-YY` style code: script beats region, so `zh-TW` and
 * `zh-HK` stay Traditional while `zh-CN`/`zh-Hans` become Simplified.
 * Returns `null` for anything that is not a base code we know.
 */
function normalizeRegionCode(code, traditional) {
  const index = code.indexOf("-");
  if (index < 1) return null;
  const base = code.slice(0, index);
  if (!/^[a-z]{2,3}$/.test(base)) return null;
  if (base === "zh") {
    return /-(?:tw|hk|mo|hant)\b/.test(code) || traditional ? "zh-Hant" : "zh";
  }
  const hit = KNOWN_LANGS.find((known) => known.toLowerCase() === base);
  return hit ?? null;
}

/** Case-insensitive exact tag lookup in KNOWN_LANGS. */
function knownCode(value) {
  return KNOWN_LANGS.find((known) => known.toLowerCase() === value) ?? null;
}

/**
 * Own-property lookup in a frozen table. The tables are plain objects, so a
 * bare `table[key]` would answer "constructor"/"valueOf" with an inherited
 * function instead of `undefined`.
 */
function lookup(table, key) {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * A language name or code as a Doubao tag, or `null` when it is not one we
 * know. Never throws: an unparsable value is the caller's decision to make.
 */
export function normalizeLanguage(raw) {
  if (typeof raw !== "string") return null;

  let text = raw.replace(/_/g, "-").replace(/\s+/g, " ").trim();
  text = text.replace(TRAILING_PUNCT, "").trim();
  if (text === "") return null;

  let compact = text.toLowerCase();

  const alias = lookup(CODE_ALIASES, compact);
  if (alias !== undefined) return alias;

  const traditional = TRADITIONAL_HINT.test(compact);
  const applyTraditional = (tag) =>
    tag === "zh" && traditional ? "zh-Hant" : tag;

  const direct = lookup(LANGUAGE_NAMES, compact);
  if (direct !== undefined) return applyTraditional(direct);

  // "Modern Greek (1453-)" -> "Modern Greek", "Javanese (Javanese)" -> "Javanese".
  compact = compact.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (compact === "") return null;

  const afterParens = lookup(LANGUAGE_NAMES, compact);
  if (afterParens !== undefined) return applyTraditional(afterParens);

  const region = normalizeRegionCode(compact, traditional);
  if (region !== null) return region;

  const code = knownCode(compact);
  if (code !== null) return code;

  // Drop qualifiers and try once more: "Simplified Mandarin Chinese" already
  // resolves directly, but "Literary Chinese" only gets here.
  const stripped = compact.replace(QUALIFIERS, "").replace(/\s+/g, " ").trim();
  if (stripped !== "") {
    const strippedName = lookup(LANGUAGE_NAMES, stripped);
    if (strippedName !== undefined) return applyTraditional(strippedName);
    const strippedCode = knownCode(stripped);
    if (strippedCode !== null) return strippedCode;
  }

  // Last resort, as the Worker does it: a family name we can place even when
  // the exact variant is unknown ("Brazilian Portuguese" -> pt).
  if (/chinese|cantonese|mandarin/.test(compact)) {
    return traditional ? "zh-Hant" : "zh";
  }
  if (/arabic/.test(compact)) return "ar";
  if (/portuguese/.test(compact)) return "pt";
  if (/spanish/.test(compact)) return "es";

  return null;
}

/**
 * Like `normalizeLanguage`, but an unknown value is a 400: the client asked
 * for a language explicitly, so silently translating into something else would
 * be worse than refusing.
 */
export function requireLanguage(raw, param = "target_lang") {
  const tag = normalizeLanguage(raw);
  if (tag === null) {
    throw invalid(
      "Unsupported target language. Use target_lang with a language code.",
      "unsupported_target_language",
      param,
    );
  }
  return tag;
}

/**
 * Split a leading "Translate to X:" directive from the text to translate.
 *
 * Both forms clients actually send are handled — with a colon
 * (`Translate to Japanese:\n\n\nHello`) and without (`Translate to Japanese\nHello`)
 * — in English and Chinese (`翻译成日语：`). All blank lines after the directive
 * are dropped so they never reach the first cue or the upstream service.
 */
export function stripInstruction(content) {
  if (typeof content !== "string") return { instruction: "", body: "" };

  const bodyStart = (prefix) =>
    content.slice(prefix.length).replace(/^(?:\r\n|\r|\n)+/, "");

  const colonMatch =
    content.match(/^(?:please\s+)?translate[^\n:：]{1,160}[:：][ \t]*/i) ??
    content.match(/^(?:请)?翻译(?:成|为)[^\n:：]{1,80}[:：][ \t]*/);

  if (colonMatch) {
    return { instruction: colonMatch[0], body: bodyStart(colonMatch[0]) };
  }

  // Some clients omit the colon: treat a leading directive line as the
  // instruction instead of translating the directive itself.
  //
  // This only applies when the directive sits on its own line AND there is a
  // non-empty payload after it. A single-line message that merely starts with
  // "translate ... into ..." is real text — treating it as a directive would
  // swallow the whole payload and return 400 empty_translation_input.
  const firstLine = content.match(/^[^\r\n]*/)?.[0] ?? "";
  const rest = content.slice(firstLine.length);
  const newlineDirective =
    /^(?:please\s+)?translate\b[^\r\n:：]{0,160}?\b(?:to|into)\s+\S[^\r\n]*$/i.test(
      firstLine,
    ) || /^(?:请)?翻译(?:成|为)\s*\S[^\r\n]*$/.test(firstLine);

  if (newlineDirective && /^(?:\r\n|\r|\n)/.test(rest) && bodyStart(firstLine).trim() !== "") {
    return { instruction: firstLine, body: bodyStart(firstLine) };
  }

  return { instruction: "", body: content };
}

/**
 * The language named by an instruction, or `null`. Used for the directive the
 * client prepended and for system/developer contexts alike.
 */
export function languageFromInstruction(instruction) {
  if (typeof instruction !== "string" || instruction === "") return null;
  const guess = instruction.match(LANGUAGE_PATTERN)?.[1];
  return guess === undefined ? null : normalizeLanguage(guess);
}

/**
 * The language named by system/developer contexts.
 *
 * `conflicting` is true when the contexts name two or more different tags; in
 * that case `language` is `null` and the caller must refuse (the Worker answers
 * 400 "Conflicting target languages.").
 */
export function languageFromContexts(contexts) {
  const found = [];
  if (Array.isArray(contexts)) {
    for (const entry of contexts) {
      const tag = languageFromInstruction(entry);
      if (tag !== null) found.push(tag);
    }
  }
  const unique = [...new Set(found)];
  if (unique.length > 1) return { language: null, conflicting: true };
  return { language: unique[0] ?? null, conflicting: false };
}

/**
 * The target tag for one request, in the Worker's order of precedence:
 * explicit `target_lang` -> the "Translate to X" directive -> the system
 * contexts -> `fallback` (default `zh`).
 *
 * Step 4 is the fix for the original plugin's bug: a directive or context that
 * mentions a language name we cannot resolve must fall through to the fallback
 * instead of failing the whole request. Only a bad `explicit` value, two
 * conflicting contexts, or an unusable `fallback` can throw.
 */
export function resolveTargetLanguage({
  explicit,
  instruction,
  contexts,
  fallback = "zh",
} = {}) {
  if (explicit !== null && explicit !== undefined && String(explicit).trim() !== "") {
    return requireLanguage(explicit);
  }

  const fromInstruction = languageFromInstruction(instruction);
  if (fromInstruction !== null) return fromInstruction;

  const { language, conflicting } = languageFromContexts(contexts);
  if (conflicting) {
    throw invalid("Conflicting target languages.", "invalid_request");
  }
  if (language !== null) return language;

  const usableFallback =
    typeof fallback === "string" && fallback.trim() !== "" ? fallback : "zh";
  return requireLanguage(usableFallback);
}

/**
 * tag -> English display name ("ja" -> "Japanese"), built from the name table:
 * the shortest plain-ASCII name wins, so `zh` reads "Chinese" rather than
 * "Simplified Mandarin Chinese". Unknown tags come back unchanged.
 */
const DISPLAY_NAMES = (() => {
  const best = new Map();
  const score = (name) => [
    /[^\x20-\x7e]/.test(name) ? 1 : 0,
    /[()]/.test(name) ? 1 : 0,
    name.length,
  ];
  const better = (left, right) => {
    const a = score(left);
    const b = score(right);
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return a[index] < b[index];
    }
    return false;
  };
  for (const [name, tag] of Object.entries(LANGUAGE_NAMES)) {
    if (CODE_LIKE.test(name)) continue;
    const current = best.get(tag.toLowerCase());
    if (current === undefined || better(name, current)) {
      best.set(tag.toLowerCase(), name);
    }
  }
  const display = new Map();
  for (const [tag, name] of best) {
    display.set(tag, name.replace(/(^|\s)([a-z])/g, (_, space, letter) => `${space}${letter.toUpperCase()}`));
  }
  return display;
})();

/** A human-readable name for a tag; the tag itself when we have no name. */
export function languageName(tag) {
  if (typeof tag !== "string" || tag === "") return "";
  return DISPLAY_NAMES.get(tag.toLowerCase()) ?? tag;
}
