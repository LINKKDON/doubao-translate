# 插件内部模块契约（冻结版）

本文件是团队并行开发的唯一接口依据。**任何模块都不得修改别人的导出签名**；发现契约有问题先改本文件并通知 lead。

## 0. 目标

本仓库的**仓库根目录即 magpie 插件形态**，供 magpie 插件市场 / `github:` / `file://` 安装，用于陪读蛙、Cherry Studio 等 OpenAI 兼容客户端。同一份翻译内核的 Cloudflare Worker 形态在 `worker/` 子目录（`worker/worker.js` 由本目录 `src/` 打包生成，见 `worker/scripts/build.mjs`）。
**`worker/` 子目录下的 Worker 形态由 `src/` 打包生成，不要手改 `worker/worker.js`；改逻辑只改 `src/`。**

插件 = 把 Worker 的翻译内核移植到 magpie 的 OpenCode 插件 API 里，融合两者优势：

| 优势来源 | 要保留的能力 |
| --- | --- |
| Worker | 180 语言归一化 + 目标语言永不失败（兜底默认值）、`%%` 分隔符由服务端保管、`default`/`subtitle`/`subtitle-context` 三上下文模式（`subtitle-context` 会把被切碎的句子重新缝合后整句翻译）、错误码语义（429 `upstream_rate_limit` + Retry-After、499、504）、5xx 重试 1 次 |
| magpie 插件 | 免部署（宿主内跑）、三协议（openai-chat / openai-responses / anthropic）、三引擎（doubao-ai-translation / volcengine-translate / microsoft-translator）、宿主提供 `/v1/models`、插件选项 UI、Cookie 登录 + 过期提示 |

## 1. 运行环境与硬约束

- 宿主在 **Bun** 里加载插件，本机开发用 **Node ≥ 24**（`node --check` 与 `node:test` 可用）。
- **零运行时依赖**：不新增 npm 依赖，只用标准库（`TextEncoder`/`TextDecoder`/`crypto.randomUUID`/`AbortSignal`）。插件必须能 `file://` 直接加载。
- 所有模块是 **ESM `.mjs`**，`export` 具名符号，不写 `export default`（除 `src/index.mjs` 的插件函数）。
- 不读 `plugin-auth.json`：凭据只从 `getAuth()` 拿。
- 不打印 Cookie / key 到日志。
- 注释与文档字符串用英文；面向用户的报错文案用英文（与 Worker 一致），README 用中文。

## 2. 模块清单与导出签名

### `src/errors.mjs`（已由 lead 冻结，勿改）

```js
export class ServiceError extends Error { code; status; param; retryable; headers }
export const invalid = (message, code = "invalid_request", param = null) => ServiceError
export const configError = (message, code = "configuration_error") => ServiceError
export const upstreamError = (message, code = "upstream_http_error", status = 502, headers = null) => ServiceError
export function errorType(status): string            // 429→rate_limit_error, 401→authentication_error, <500→invalid_request_error, else api_error
export function errorPayload(error, fallback?): { status, headers, body: { error: { message, type, code, param } } }
export function abortError(error, { timeoutSignal, requestSignal }): ServiceError | null
```

### `src/lang.mjs`（agent: lang）

```js
export const KNOWN_LANGS: string[]                    // Worker 的 ~180 个语言码，顺序保留
export const LANGUAGE_NAMES: Record<string, string>   // 小写语言名 → tag（Worker 的 `j` 表，约 200 条）
export const LANGUAGE_PATTERN: RegExp                 // 抓「指令后面的整段短语」，见下
export function normalizeLanguage(raw: string): string | null   // 名字/代码 → tag；不认识返回 null，绝不 throw
export function requireLanguage(raw: string, param = "target_lang"): string  // 不认识抛 invalid(...,"unsupported_target_language",param)
export function stripInstruction(content: string): { instruction: string, body: string }   // 仅当指令独占首行且其后仍有非空正文时才剥离；单行文本一律当正文（否则会 400）
export function languageFromInstruction(instruction: string): string | null
export function languageFromContexts(contexts: string[]): { language: string | null, conflicting: boolean }
export function resolveTargetLanguage({ explicit, instruction, contexts, fallback }): string
export function languageName(tag: string): string     // tag → 展示名（缺省回 tag 本身）
```

`resolveTargetLanguage` 语义（**这是修掉原插件 bug 的核心**）：
1. `explicit`（body.target_lang 或 `x-doubao-target-lang`）存在 → `requireLanguage(explicit)`（不认识就 400 `unsupported_target_language`）。
2. `instruction` 里能抽出语言 → 用它。
3. `contexts` 里能抽出语言 → 用它；抽到 ≥2 个不同 tag → 抛 `invalid("Conflicting target languages.", "invalid_request")`。
4. 否则 → `fallback`（默认 `"zh"`）。**只要 fallback 合法就绝不抛错。**

`normalizeLanguage` 必须能识别陪读蛙 `@read-frog/definitions` 的全部 180 个 `englishName`（如 `Simplified Mandarin Chinese`→`zh`、`Traditional Mandarin Chinese`→`zh-Hant`、`Brazilian Portuguese`→`pt`、`Standard Arabic`→`ar`、`Cantonese`→`zh`、`Modern Greek (1453-)`→`el`、`Swahili (individual language)`→`sw`），以及 ISO 码（`zh-Hans`/`zh-TW`/`pt-BR`/`es-419`）。

### `src/units.mjs`（agent: units）

```js
export const BATCH_SEPARATOR = "%%"
export const SEPARATOR_LINE = /^[ \t]*%%[ \t]*$/      // 独立一行的分隔符
export function splitUnits(text: string, mode?: "default"|"subtitle"|"subtitle-context"): Segment[]
// Segment = { text: string, separator: string }
// text === "" 表示这是分隔符占位单元，不上传上游
export function collectTexts(segments: Segment[]): string[]        // 过滤空 text
export function rebuild(segments: Segment[], results: string[]): string
export function planBatches(texts: string[], { size = 50, chars = 10000, maxBatches = 4 }): string[][]

// 句子缝合（仅 subtitle-context 模式使用）
export function mergeCues(segments: Segment[], { maxChars = 800 }?): Node[]
// Node = { kind: "literal", text: string } | { kind: "sentence", parts: { text: string, separator: string }[] }
export function collectCues(nodes: Node[]): string[]              // 每个 sentence 用单个空格 join 成一条
export function splitMerged(translation: string, parts: { text: string }[]): string[]
export function rebuildCues(nodes: Node[], results: string[]): string
```

关键语义：`%%` 行**永远不进 `text`**，只作为 `separator` 挂在相邻段上；`rebuild` 把原文逐字拼回。这样模型即使把 `%%` 译成「百分号」也不影响对齐。

`subtitle-context` 模式的额外语义（句子缝合）：字幕 cue 是**显示**单位而非语言单位，一个句子常被切到多个 cue（"I told him that" / "we should leave before" / "the storm hits."）。逐条发上游时每段都丢掉主语或宾语。`mergeCues` 把 cue 按句末标点（`SENTENCE_END`）重新拼成整句，`collectCues` 用单个空格合并成一条字符串送上游，`rebuildCues` 再把整句译文摊回原来的 cue（译文按行数精确对齐，否则按源 cue 字符长度比例切分，切口尽量落在空白处）。`maxChars`（默认 800）防止无句末标点的长 cue 吞掉整篇。`default`/`subtitle` 的行为完全不变。

`splitMerged` 的硬约束：**每片切点严格递增**，因此只要译文长度 ≥ cue 数，就不会出现空片；译文比 cue 短时允许后几片为空（宁可空片也不丢字）。行数精确对齐只在**每一行都非空**时采用，避免 `"x\n"` 这种尾换行被当成两行。`worker.js` 内的 `splitMerged`/`snapCut` 必须与此逐字同源。

### `src/doubao.mjs`（agent: doubao）

```js
export const BASE_ORIGIN = "https://www.doubao.com"
export const DESKTOP_PARAMS: Readonly<Record<string, string>>    // 豆包官方浏览器扩展（v1.38.0）固定查询参数：aid=586864、real_aid=586864、device_platform=web、version=1.38.0、version_code=20800、pc_version=1.38.0、pkg_type=release_version、is_new_user=0、language=zh、browser_language=zh-CN、region=CN、sys_region=CN、samantha_web=1、use-olympus-account=1，外加每次随机的 tea_uuid（18 位数字）与 web_tab_id（UUID v4）
export const EXTENSION_VERSION = "1.38.0"          // 伪装对齐的扩展版本
export const UPSTREAM_URL = "https://www.doubao.com/samantha/plugin/stream_article_translate?<DESKTOP_PARAMS>"   // 绝不能是裸路径
export const USER_AGENT: string                        // Chrome/147 Windows，替代 Node 默认的 `node`
export const BROWSER_HEADERS: Readonly<Record<string, string>>   // UA / Origin / Referer / accept-language / sec-ch-ua* / sec-fetch-* / agw-js-conv: str
export const ENGINES: Record<string, string>          // { "doubao-ai-translation": "1", "volcengine-translate": "0", "microsoft-translator": "3" }
export const MODEL_ALIASES: Record<string, string>    // { "doubao-ai": "doubao-ai-translation" }（改名前旧 id 仍可用）
export const DEFAULT_MODEL = "doubao-ai-translation"
export function resolveEngine(model?: string): string             // 未知 model 抛 ServiceError 404 model_not_found；model id 大小写不敏感，并接受 provider/model 形式
export function validateCookie(raw: string): string                // 接受三种粘贴形式：裸 sessionid 值（自动补 "sessionid="）、Cookie header、浏览器导入的 Cookie JSON（转 header）；拒绝 CR/LF 注入；只要求 sessionid 或 sessionid_ss；畸形的 header（空值、`=` 两侧带空格、缺 `=` 的段）会被重建为规范形式而非原样透传；失败抛 configError
export const ACCOUNT_INFO_URL: string                             // 豆包 /passport/account/info/v2/ 端点（同样带 DESKTOP_PARAMS + account_sdk_source/sdk_version）
export async function fetchAccountInfo({ cookie, fetchImpl, signal }): Promise<{ uid: string, name: string }>
// 校验 Cookie 并自动取账号名：会话有效返回 { uid, name(screen_name 优先) }；会话过期/访问者/非 2xx 抛 ServiceError 401 upstream_auth_error
export function buildUpstreamBody({ texts, target, engine, scene }): object
export async function translateBatch({ texts, target, engine, scene, cookie, fetchImpl, signal, requestSignal, retries }): Promise<string[]>
export function parseUpstreamStream(text: string, expected: number): string[]   // 解析 SSE，按 index 对齐，缺失/越界抛 upstream_stream_error
```

`translateBatch` 必须实现：上游 5xx 重试 1 次（200–399ms 随机退避）；429 → `upstream_rate_limit` 并透传合法 `retry-after`；空 body → `upstream_incomplete_result`；`{"code":710012001}` → `upstream_auth_error`；`{"code":710022002}` / `{"code":710022013}` → `upstream_quota_exceeded`(429)；超时 → `upstream_timeout`(504)；客户端断开 → 499。

**伪装要求（合规观察点）**：本插件伪装的是豆包**官方浏览器扩展**的翻译接口（不是桌面端）。所有上游请求（翻译与账号查询）必须带 `DESKTOP_PARAMS` 查询串和 `BROWSER_HEADERS`（`Referer: https://www.doubao.com/`、`Accept: text/event-stream`、`agw-js-conv: str`）；Node 默认 `User-Agent: node` 是最明显的特征，绝不能裸发。上游调用按 `maxConcurrency`（默认 `4`）并发，保证翻译吞吐。

### `src/protocols.mjs`（agent: protocols）

```js
export const PROTOCOLS = { "/v1/chat/completions": "openai-chat", "/v1/responses": "openai-responses", "/v1/messages": "anthropic" }
export function protocolOf(pathname: string): string | null       // 不认识的路径返回 null（调用方 400）
export function adaptRequest(protocol: string, body: object, { headers, options }): Request
// Request = { protocol, model, stream, includeUsage, target, text, contexts, contextMode, scene }
//   contexts: string[] —— system/developer/instructions 的纯文本，供 lang.resolveTargetLanguage 抽语言用
export function renderResponse(protocol: string, { id, model, content, usage, created } = {}): object
export function renderStream(protocol: string, { id, model, content, includeUsage, usage, created } = {}): string   // 完整 SSE 文本
export function checkCapabilities(body: object, protocol: string): void   // 不支持的能力抛 unsupported_feature
```

三协议都要能拿到：最后一条 user 文本、system/developer/instructions 上下文、`target_lang`、`stream`、`stream_options.include_usage`。

### `src/index.mjs`（lead）

导出 `DoubaoTranslatePlugin`（async 函数），组装 `auth` / `config` / `provider` hooks，串起上面四个模块。

`provider.models(provider, { auth })` 只返回静态模型表，**不得因凭证缺失或过期而失败**：仅当 `auth.type === "api"` 且 `auth.key` 非空时才探活，且探活异常一律吞掉（模型列表照常返回，登录态留到第一次真实请求再报 401）。

## 3. 错误码表（两形态共用，勿增删）

| status | code |
| --- | --- |
| 400 | `invalid_request` / `unsupported_input` / `empty_translation_input` / `unsupported_feature` / `unsupported_target_language` |
| 401 | `unauthorized`（magpie 宿主鉴权，插件不校验） |
| 404 | `model_not_found`（插件形态；Worker 形态另有 `not_found`） |
| 413 | `request_too_large` |
| 429 | `upstream_rate_limit` / `upstream_quota_exceeded` |
| 499 | `request_cancelled` |
| 502 | `upstream_auth_error` / `upstream_http_error` / `upstream_network_error` / `upstream_incomplete_result` / `upstream_stream_error` |
| 503 | `configuration_error` |
| 504 | `upstream_timeout` |

## 4. 验收（每人自查 + lead 集成）

1. `node --check <每个文件>` 通过。
2. `node --test test/*.test.mjs` 全绿（必须 glob）。
3. 语言覆盖：陪读蛙 180 个语言名 **180/180** 能解析出 tag（不是抛错）。
4. `%%` 四种变异（原样 / 全角 / 空串 / 译成「百分号」）**全部**能正确回填。
5. 零依赖：`grep -rn "from \"[^.]" src` 只允许 `node:` 前缀。
