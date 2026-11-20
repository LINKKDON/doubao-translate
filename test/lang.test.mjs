// Tests for the language module.
//
// Two properties matter and are tested hard:
//
// 1. COVERAGE. Read Frog ships 180 `englishName`s and sends them verbatim as
//    `target_lang`. Every single one must resolve to a Doubao tag; a client
//    must never see "unsupported language" for a name its own UI offered.
// 2. NO FAILURE ON A GUESS. `resolveTargetLanguage` only ever refuses an
//    explicit bad `target_lang` (or two conflicting contexts). A directive or
//    a system prompt that mentions a language we cannot place must fall
//    through to the fallback — that is the bug this module exists to fix.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  KNOWN_LANGS,
  LANGUAGE_NAMES,
  LANGUAGE_PATTERN,
  languageFromContexts,
  languageFromInstruction,
  languageName,
  normalizeLanguage,
  requireLanguage,
  resolveTargetLanguage,
  stripInstruction,
} from "../src/lang.mjs";
import { ServiceError } from "../src/errors.mjs";

// The 180 `[code, englishName]` pairs from @read-frog/definitions, inlined so
// the test needs no package resolution and no network.
const READ_FROG_LANGUAGES = [
  ["en", "English"],
  ["zh-Hans", "Simplified Mandarin Chinese"],
  ["zh-Hant", "Traditional Mandarin Chinese"],
  ["yue", "Cantonese"],
  ["es", "Spanish"],
  ["ru", "Russian"],
  ["ar", "Standard Arabic"],
  ["bn", "Bengali"],
  ["hi", "Hindi"],
  ["pt-BR", "Brazilian Portuguese"],
  ["pt-PT", "European Portuguese"],
  ["id", "Indonesian"],
  ["ja", "Japanese"],
  ["fr", "French"],
  ["de", "German"],
  ["jv", "Javanese"],
  ["ko", "Korean"],
  ["te", "Telugu"],
  ["vi", "Vietnamese"],
  ["mr", "Marathi"],
  ["it", "Italian"],
  ["ta", "Tamil"],
  ["tr", "Turkish"],
  ["ur", "Urdu"],
  ["gu", "Gujarati"],
  ["pl", "Polish"],
  ["uk", "Ukrainian"],
  ["kn", "Kannada"],
  ["mai", "Maithili"],
  ["ml", "Malayalam"],
  ["fa", "Iranian Persian"],
  ["my", "Burmese"],
  ["sw", "Swahili (individual language)"],
  ["su", "Sundanese"],
  ["ro", "Romanian"],
  ["pa", "Panjabi"],
  ["bho", "Bhojpuri"],
  ["am", "Amharic"],
  ["ha", "Hausa"],
  ["ff", "Nigerian Fulfulde"],
  ["bs", "Bosnian"],
  ["hr", "Croatian"],
  ["nl", "Dutch"],
  ["sr", "Serbian (Cyrillic)"],
  ["th", "Thai"],
  ["ckb", "Central Kurdish"],
  ["yo", "Yoruba"],
  ["uz", "Uzbek"],
  ["ms", "Malay"],
  ["ig", "Igbo"],
  ["ne", "Nepali (individual language)"],
  ["ceb", "Cebuano"],
  ["skr", "Saraiki"],
  ["fil", "Tagalog"],
  ["hu", "Hungarian"],
  ["az", "Azerbaijani"],
  ["si", "Sinhala"],
  ["koi", "Komi-Permyak"],
  ["el", "Modern Greek (1453-)"],
  ["cs", "Czech"],
  ["mag", "Magahi"],
  ["rn", "Rundi"],
  ["be", "Belarusian"],
  ["mg", "Plateau Malagasy"],
  ["qug", "Chimborazo Highland Quichua"],
  ["mad", "Madurese"],
  ["ny", "Nyanja"],
  ["za", "Yongbei Zhuang"],
  ["ps", "Northern Pashto"],
  ["rw", "Kinyarwanda"],
  ["zu", "Zulu"],
  ["bg", "Bulgarian"],
  ["sv", "Swedish"],
  ["ln", "Lingala"],
  ["so", "Somali"],
  ["hms", "Southern Qiandong Miao"],
  ["hnj", "Hmong Njua"],
  ["ilo", "Iloko"],
  ["kk", "Kazakh"],
  ["he", "Hebrew"],
  ["nb", "Norwegian Bokmål"],
  ["nn", "Norwegian Nynorsk"],
  ["af", "Afrikaans"],
  ["sq", "Albanian"],
  ["as", "Assamese"],
  ["eu", "Basque"],
  ["br", "Breton"],
  ["ca", "Catalan"],
  ["co", "Corsican"],
  ["cy", "Welsh"],
  ["da", "Danish"],
  ["dv", "Divehi"],
  ["eo", "Esperanto"],
  ["et", "Estonian"],
  ["fo", "Faroese"],
  ["fj", "Fijian"],
  ["fi", "Finnish"],
  ["fy", "Western Frisian"],
  ["gd", "Scottish Gaelic"],
  ["ga", "Irish"],
  ["gl", "Galician"],
  ["gn", "Guarani"],
  ["ht", "Haitian Creole"],
  ["haw", "Hawaiian"],
  ["hy", "Armenian"],
  ["io", "Ido"],
  ["ia", "Interlingua"],
  ["is", "Icelandic"],
  ["ka", "Georgian"],
  ["km", "Khmer"],
  ["ky", "Kyrgyz"],
  ["lo", "Lao"],
  ["la", "Latin"],
  ["lv", "Latvian"],
  ["lt", "Lithuanian"],
  ["lb", "Luxembourgish"],
  ["mk", "Macedonian"],
  ["mt", "Maltese"],
  ["mn", "Mongolian"],
  ["mi", "Maori"],
  ["nso", "Northern Sotho"],
  ["oc", "Occitan"],
  ["or", "Odia"],
  ["om", "Oromo"],
  ["fa-AF", "Dari"],
  ["sa", "Sanskrit"],
  ["sk", "Slovak"],
  ["sl", "Slovenian"],
  ["sm", "Samoan"],
  ["sn", "Shona"],
  ["sd", "Sindhi"],
  ["st", "Southern Sotho"],
  ["ty", "Tahitian"],
  ["tt", "Tatar"],
  ["tg", "Tajik"],
  ["ti", "Tigrinya"],
  ["to", "Tongan"],
  ["tn", "Tswana"],
  ["tk", "Turkmen"],
  ["ug", "Uyghur"],
  ["vo", "Volapük"],
  ["wo", "Wolof"],
  ["xh", "Xhosa"],
  ["yi", "Eastern Yiddish"],
  ["ak", "Akan"],
  ["bm", "Bambara"],
  ["bi", "Bislama"],
  ["bo", "Tibetan"],
  ["ce", "Chechen"],
  ["cv", "Chuvash"],
  ["dz", "Dzongkha"],
  ["ee", "Ewe"],
  ["kab", "Kabyle"],
  ["lg", "Ganda"],
  ["os", "Ossetian"],
  ["ss", "Swati"],
  ["ve", "Venda"],
  ["war", "Waray"],
  ["nd", "North Ndebele"],
  ["nr", "South Ndebele"],
  ["pam", "Pampanga"],
  ["hil", "Hiligaynon"],
  ["bik", "Central Bikol"],
  ["min", "Minangkabau"],
  ["ace", "Acehnese"],
  ["bug", "Buginese"],
  ["ban", "Balinese"],
  ["bjn", "Banjar"],
  ["mak", "Makasar"],
  ["sas", "Sasak"],
  ["tet", "Tetum"],
  ["ch", "Chamorro"],
  ["niu", "Niuean"],
  ["tvl", "Tuvaluan"],
  ["gil", "Gilbertese"],
  ["mh", "Marshallese"],
  ["pau", "Palauan"],
  ["wls", "Wallisian"],
  ["rar", "Rarotongan"],
  ["hif", "Fiji Hindi"],
];

// Names that the Worker's own table resolved only via a family fallback, plus
// the ones it had no entry for at all. These are the regression-prone ones.
const DOCUMENTED_NAMES = [
  ["Simplified Mandarin Chinese", "zh"],
  ["Traditional Mandarin Chinese", "zh-Hant"],
  ["Brazilian Portuguese", "pt"],
  ["European Portuguese", "pt"],
  ["Standard Arabic", "ar"],
  ["Cantonese", "zh"],
  ["Modern Greek (1453-)", "el"],
  ["Swahili (individual language)", "sw"],
  ["Tagalog", "fil"],
];

test("every Read Frog englishName resolves to a tag", () => {
  assert.equal(READ_FROG_LANGUAGES.length, 180);

  const failures = [];
  for (const [, name] of READ_FROG_LANGUAGES) {
    const tag = normalizeLanguage(name);
    if (tag === null) {
      failures.push(name);
      continue;
    }
    assert.equal(typeof tag, "string");
    assert.ok(
      KNOWN_LANGS.includes(tag),
      `${JSON.stringify(name)} resolved to ${JSON.stringify(tag)}, which is not a known tag`,
    );
  }
  assert.deepEqual(failures, [], `${failures.length} Read Frog names did not resolve`);
});

test("every Read Frog code resolves too", () => {
  const failures = [];
  for (const [code] of READ_FROG_LANGUAGES) {
    if (normalizeLanguage(code) === null) failures.push(code);
  }
  assert.deepEqual(failures, []);
});

test("the documented name mappings", () => {
  for (const [name, expected] of DOCUMENTED_NAMES) {
    assert.equal(normalizeLanguage(name), expected, `${name} -> ${expected}`);
  }
});

test("ISO codes, region forms and case", () => {
  const cases = [
    ["en", "en"],
    ["EN", "en"],
    ["en-US", "en"],
    ["zh", "zh"],
    ["zh-Hans", "zh"],
    ["zh-CN", "zh"],
    ["zh-cn", "zh"],
    ["zh-Hant", "zh-Hant"],
    ["zh-TW", "zh-Hant"],
    ["zh-HK", "zh-Hant"],
    ["zh-MO", "zh-Hant"],
    ["pt", "pt"],
    ["pt-BR", "pt"],
    ["pt-PT", "pt"],
    ["es", "es"],
    ["es-419", "es"],
    ["es-ES", "es"],
    ["ja-JP", "ja"],
    ["ko_KR", "ko"],
    ["fr-FR", "fr"],
    ["fa-AF", "fa"],
    ["nb-NO", "nb"],
    ["sr-Cyrl", "sr"],
    // Read Frog codes whose tag the Worker spells differently.
    ["yue", "zh"],
    ["ckb", "ku"],
    ["iw", "he"],
    ["in", "id"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeLanguage(input), expected, `${input} -> ${expected}`);
  }
});

test("unknown values return null and never throw", () => {
  for (const input of ["klingon", "not a language", "", "   ", "-", "zz-ZZ", "x"]) {
    assert.equal(normalizeLanguage(input), null, JSON.stringify(input));
  }
  for (const input of [undefined, null, 42, {}, [], true]) {
    assert.equal(normalizeLanguage(input), null);
  }
});

test("prototype keys are not languages", () => {
  // The tables are plain objects; a bare `table[key]` lookup would answer
  // "constructor" with a function instead of undefined.
  for (const key of ["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"]) {
    assert.equal(normalizeLanguage(key), null, key);
  }
});

test("surrounding punctuation is tolerated", () => {
  assert.equal(normalizeLanguage("Japanese."), "ja");
  assert.equal(normalizeLanguage(" Japanese "), "ja");
  assert.equal(normalizeLanguage("Japanese:"), "ja");
  assert.equal(normalizeLanguage("日语"), "ja");
  assert.equal(normalizeLanguage("简体中文"), "zh");
  assert.equal(normalizeLanguage("繁体中文"), "zh-Hant");
  assert.equal(normalizeLanguage("繁體中文"), "zh-Hant");
});

test("requireLanguage returns the tag or throws a 400", () => {
  assert.equal(requireLanguage("Japanese"), "ja");
  assert.equal(requireLanguage("zh-Hans"), "zh");

  assert.throws(
    () => requireLanguage("klingon"),
    (error) => {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.code, "unsupported_target_language");
      assert.equal(error.status, 400);
      assert.equal(error.param, "target_lang");
      return true;
    },
  );

  // The caller names the offending parameter.
  assert.throws(
    () => requireLanguage("klingon", "x-doubao-target-lang"),
    (error) => error.param === "x-doubao-target-lang",
  );
});

test("stripInstruction removes a colon directive", () => {
  const result = stripInstruction("Translate to Japanese:\n\n\nHello");
  assert.equal(result.instruction, "Translate to Japanese:");
  assert.equal(result.body, "Hello");
});

test("stripInstruction removes a directive without a colon", () => {
  const result = stripInstruction("Translate to Japanese\nHello\nWorld");
  assert.equal(result.instruction, "Translate to Japanese");
  assert.equal(result.body, "Hello\nWorld");
});

test("stripInstruction handles CRLF and Chinese directives", () => {
  assert.deepEqual(stripInstruction("Translate to Japanese:\r\n\r\nHello"), {
    instruction: "Translate to Japanese:",
    body: "Hello",
  });
  assert.deepEqual(stripInstruction("翻译成日语：\n\n你好"), {
    instruction: "翻译成日语：",
    body: "你好",
  });
  assert.deepEqual(stripInstruction("请翻译成日语：你好"), {
    instruction: "请翻译成日语：",
    body: "你好",
  });
  assert.deepEqual(stripInstruction("翻译成日语\n你好"), {
    instruction: "翻译成日语",
    body: "你好",
  });
});

test("stripInstruction leaves ordinary text alone", () => {
  assert.deepEqual(stripInstruction("Hello world"), {
    instruction: "",
    body: "Hello world",
  });
  assert.deepEqual(stripInstruction("\n\nHello"), {
    instruction: "",
    body: "\n\nHello",
  });
  // A directive with no text after it still splits, with an empty body.
  assert.deepEqual(stripInstruction("Translate to Japanese:"), {
    instruction: "Translate to Japanese:",
    body: "",
  });
  assert.deepEqual(stripInstruction(undefined), { instruction: "", body: "" });
});

test("LANGUAGE_PATTERN captures the whole trailing phrase", () => {
  assert.ok(LANGUAGE_PATTERN instanceof RegExp);

  const cases = [
    ["Translate to Japanese:", "Japanese"],
    ["translate into Simplified Mandarin Chinese.", "Simplified Mandarin Chinese"],
    ["Translate to Modern Greek (1453-)", "Modern Greek (1453-)"],
    ["Translate to Swahili (individual language)", "Swahili (individual language)"],
    ["翻译成日语", "日语"],
    ["Target language: Cantonese", "Cantonese"],
    ["target language: Klingon", "Klingon"],
  ];
  for (const [text, expected] of cases) {
    assert.equal(text.match(LANGUAGE_PATTERN)?.[1], expected, text);
  }

  // Reusing the pattern must not depend on hidden `lastIndex` state.
  assert.equal(LANGUAGE_PATTERN.global, false);
});

test("languageFromInstruction", () => {
  assert.equal(languageFromInstruction("Translate to Japanese:"), "ja");
  assert.equal(
    languageFromInstruction(
      "You are a professional Simplified Mandarin Chinese native translator who needs to fluently translate text into Simplified Mandarin Chinese.",
    ),
    "zh",
  );
  assert.equal(languageFromInstruction("Translate to Klingon:"), null);
  assert.equal(languageFromInstruction("Just be helpful."), null);
  assert.equal(languageFromInstruction(""), null);
  assert.equal(languageFromInstruction(undefined), null);
});

test("languageFromContexts", () => {
  assert.deepEqual(languageFromContexts(["Translate to Korean"]), {
    language: "ko",
    conflicting: false,
  });
  assert.deepEqual(
    languageFromContexts(["Translate to Korean", "translate into Korean"]),
    { language: "ko", conflicting: false },
  );
  assert.deepEqual(
    languageFromContexts(["Translate to Korean", "Translate to Japanese"]),
    { language: null, conflicting: true },
  );
  assert.deepEqual(languageFromContexts([]), { language: null, conflicting: false });
  assert.deepEqual(languageFromContexts(undefined), { language: null, conflicting: false });
  assert.deepEqual(languageFromContexts("nope"), { language: null, conflicting: false });
});

test("resolveTargetLanguage: explicit wins", () => {
  assert.equal(
    resolveTargetLanguage({
      explicit: "Japanese",
      instruction: "Translate to Korean:",
      contexts: ["Translate to French"],
      fallback: "zh",
    }),
    "ja",
  );
  // An explicit language we do not know is the one thing we refuse.
  assert.throws(
    () =>
      resolveTargetLanguage({
        explicit: "klingon",
        instruction: "Translate to Korean:",
        contexts: [],
        fallback: "zh",
      }),
    (error) => error.code === "unsupported_target_language",
  );
});

test("resolveTargetLanguage: instruction beats contexts", () => {
  assert.equal(
    resolveTargetLanguage({
      explicit: undefined,
      instruction: "Translate to Japanese:",
      contexts: ["Translate to French"],
      fallback: "zh",
    }),
    "ja",
  );
});

test("resolveTargetLanguage: contexts are used, conflicts refused", () => {
  assert.equal(
    resolveTargetLanguage({
      explicit: undefined,
      instruction: "",
      contexts: ["Translate to Korean"],
      fallback: "zh",
    }),
    "ko",
  );
  assert.throws(
    () =>
      resolveTargetLanguage({
        explicit: undefined,
        instruction: "",
        contexts: ["Translate to Korean", "Translate to Japanese"],
        fallback: "zh",
      }),
    (error) => {
      assert.equal(error.code, "invalid_request");
      assert.equal(error.status, 400);
      return true;
    },
  );
});

test("resolveTargetLanguage: the fallback never fails (the original bug)", () => {
  // The exact request that used to blow up: Read Frog's Chinese system prompt
  // names "Simplified Mandarin Chinese" and nothing else in the request names a
  // language the old plugin could parse.
  assert.equal(
    resolveTargetLanguage({
      explicit: undefined,
      instruction: "",
      contexts: [
        "You are a professional Simplified Mandarin Chinese native translator who needs to fluently translate text into Simplified Mandarin Chinese.",
      ],
      fallback: "zh",
    }),
    "zh",
  );

  // Unknown guesses fall through instead of throwing.
  assert.equal(
    resolveTargetLanguage({
      explicit: undefined,
      instruction: "Translate to Klingon:",
      contexts: [],
      fallback: "zh",
    }),
    "zh",
  );
  assert.equal(
    resolveTargetLanguage({
      explicit: undefined,
      instruction: "",
      contexts: ["Translate to Klingon"],
      fallback: "zh",
    }),
    "zh",
  );

  // No request data at all, and no arguments at all.
  assert.equal(resolveTargetLanguage({}), "zh");
  assert.equal(resolveTargetLanguage(), "zh");
  assert.equal(resolveTargetLanguage({ fallback: undefined }), "zh");
  assert.equal(resolveTargetLanguage({ explicit: "", fallback: "" }), "zh");

  // A configured fallback is honoured.
  assert.equal(
    resolveTargetLanguage({ explicit: null, instruction: "", contexts: [], fallback: "ja" }),
    "ja",
  );

  // An unusable fallback is still a configuration error, not a silent default.
  assert.throws(
    () => resolveTargetLanguage({ fallback: "klingon" }),
    (error) => error.code === "unsupported_target_language",
  );
});

test("languageName", () => {
  assert.equal(languageName("ja"), "Japanese");
  assert.equal(languageName("zh"), "Chinese");
  assert.equal(languageName("zh-Hant"), "Traditional Chinese");
  assert.equal(languageName("pt"), "Portuguese");
  assert.equal(languageName("ko"), "Korean");
  assert.equal(languageName("el"), "Modern Greek");
  assert.equal(languageName("sw"), "Swahili");
  assert.equal(languageName("fil"), "Tagalog");
  // Unknown tags come back unchanged rather than as "undefined".
  assert.equal(languageName("xx"), "xx");
  assert.equal(languageName(""), "");
  assert.equal(languageName(undefined), "");
});

test("the tables are self-consistent", () => {
  assert.ok(KNOWN_LANGS.length >= 141);
  assert.equal(new Set(KNOWN_LANGS).size, KNOWN_LANGS.length, "duplicate codes");
  assert.ok(Object.isFrozen(KNOWN_LANGS));
  assert.ok(Object.isFrozen(LANGUAGE_NAMES));

  const known = new Set(KNOWN_LANGS);
  for (const [name, tag] of Object.entries(LANGUAGE_NAMES)) {
    assert.ok(known.has(tag), `name ${JSON.stringify(name)} points at unknown tag ${tag}`);
    assert.equal(name, name.toLowerCase(), `name keys must be lowercase: ${name}`);
  }
});

test("the module has no runtime dependencies", () => {
  const source = readFileSync(new URL("../src/lang.mjs", import.meta.url), "utf8");
  const specifiers = [...source.matchAll(/^\s*import\s[^'"]*from\s*["']([^"']+)["']/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(specifiers, ["./errors.mjs"]);
  // Inlined tables: no filesystem or network access at runtime.
  assert.equal(/\brequire\(|\breadFileSync\b|\bfetch\(/.test(source), false);
});

test("stripInstruction keeps a single-line message that only looks like a directive", () => {
  // Regression: a one-line payload has no body after the first line, so it must
  // be translated instead of being swallowed (which produced a 400).
  assert.deepEqual(stripInstruction("Translate the docs into English"), {
    instruction: "",
    body: "Translate the docs into English",
  });
  assert.deepEqual(stripInstruction("Translate this into Chinese"), {
    instruction: "",
    body: "Translate this into Chinese",
  });
  assert.deepEqual(
    stripInstruction("Translate the following text into Chinese. Hello world."),
    {
      instruction: "",
      body: "Translate the following text into Chinese. Hello world.",
    },
  );
});
