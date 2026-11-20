# 更新记录

本文件记录本项目的主要变更。版本号与 `package.json` 保持一致。

## v0.6.0

### 重构（单源构建）

- **Worker 不再是手抄的第二份内核**：`worker/worker.js` 现在由 `worker/scripts/build.mjs` 用 esbuild 从仓库根 `src/`（`units.mjs` / `lang.mjs` / `doubao.mjs` / `errors.mjs`）打包生成，`worker/src/worker-entry.mjs` 只保留 Worker 特有的 HTTP 外壳（路由、CORS、API Key 鉴权、请求体上限、SSE/JSON 响应）。删掉了约 700 行复制品。
- 打包产物 **28.3 KB（gzip 11.5 KB）**，体积较手维护版 40.3 KB 减少约 30%。
- 新增 `npm run check`：校验 `worker.js` 与 `src/` 是否同步，CI/本地可挂。
- 行为与错误语义保持不变，`test-hardening.mjs` 83 项全部通过。

## v0.5.4

### 修复（第三轮独立审查发现的问题）

- **`subtitle-context` 绕过 10,000 字符单元上限**：原校验只查合并前的原始 cue，缝合后超过 10,000 字符的单元无人复查，会被原样送上游并产生一个空批次（上游报错 → 502）。现在改为在 `collectCues` 之后对**实际发送的每条文本**逐条校验，超长统一 `413 request_too_large`；批循环补 `current.length > 0` 守卫，不再产生空批次。新增 2 个回归用例（缝合超长 413、单 cue 超长 413）。
- **Cookie 的 JSON 导出路径两仓不一致**：`workerCookie` 的 JSON 分支不再原样拼接，改为 trim name/value、同名取后者、丢弃空值，与 magpie 插件 `parseCookieEntries` 一致；重建后再扫一遍 `[\r\n]`，拒绝藏在 value 里的换行（插件侧同样补了这道检查）。新增 3 个回归用例（padded name、同名去重、换行注入）。
- `test-hardening.mjs` 83 项；`check-size.mjs` 当前 40285 B / gzip 13856 B（上限 45,000）。

## v0.5.3

### 修复（第二轮复审发现的 Worker 侧缺陷）

- **Cookie 重建会误杀以 `=` 结尾的合法值**：`workerCookie` 的重建分支原来用 `!part.endsWith("=")` 丢弃空值段，导致 base64 padding（如 `sessionid=abc==`）在「同一 header 另有畸形段」时被整段丢掉甚至整条 503。改为判别「`=` 之后的值为空」，并把重建统一为 Map 语义（同名取后者），与 magpie 插件 `validateCookie` 逐字一致。新增两个回归用例（base64 值存活、同名去重）。
- **`subtitle`/`subtitle-context` 的 `%%` 边界解析与插件不同源**：Worker 原来用正则 split，无法识别「首行就是 `%%`」和「`%%` / `%%` 相邻」两种情形，会把 `%%` 泄漏进正文送上游。改为与插件相同的行走法（`splitCueLines` + `splitSubtitleUnits`）。新增两个回归用例。修复后 14 组边界输入两仓输出逐字一致。
- `test-hardening.mjs` 78 项；`check-size.mjs` 上限由 40,000 放宽到 **45,000 字节**（自设自律线，CF 免费版压缩后上限 3 MB），当前 39460 B / gzip 13616 B。

## v0.5.2

### 修复（第二轮代码审查：B 类问题）

- **单行输入被误当成指令而 400**：`stripInstruction` 原来只按正则判断首行像不像「Translate ... into X」，单行请求（如 `Translate the docs into English`）会把整行当指令，正文变空 → `400 empty_translation_input`。现在要求指令**独占首行且其后仍有非空正文**才剥离，单行一律当正文翻译。
- **畸形 Cookie header 原样透传**：`workerCookie` 现在会重建空值段、`=` 两侧带空格的段、缺 `=` 的段（如 `"sessionid = spaced"` → `"sessionid=spaced"`、`"sessionid=; sessionid_ss=x"` → `"sessionid_ss=x"`），与 magpie 插件的 `validateCookie` 行为一致。裸 sessionid 值不受影响。
- 新增回归用例：「a single-line directive-looking message is translated」「Cookie 规范化」相关断言。
- `test-hardening.mjs` 74 项；`check-size.mjs` 当前 37.8 KB / 40 KB（gzip 13.1 KB）。

## v0.5.1

### 修复（代码审查发现的阻断级问题）

- **字幕缝合在超短译文下会丢字/产生空片**：`splitMerged` 的切点在极短译文时全部落在同一点（`snapCut` 返回 `floor`），导致 5 个 cue + 3 个字这类输入只回填 3 个 cue。现在切点严格递增（`cut ≥ floor + 1` 且为后续 cue 预留字符），只要译文长度 ≥ cue 数就不会有空片；行数精确对齐也要求每一行非空，避免 `"x\n"` 尾换行被当成两行。与 magpie 插件 `src/units.mjs` 逐字同源。
- 新增回归用例：「one-character translation spread over three cues」。
- `check-size.mjs` 当前 36.6 KB / 40 KB（gzip 12.6 KB）。

## v0.5.0

### 字幕句子缝合（与 magpie 插件对齐）

- `subtitle-context` 不再只是 `subtitle` 的别名，改为真正的**句子缝合**：把被切碎的相邻 cue 先拼成整句再发上游，译文按各 cue 原始长度比例切回原 cue 行。解决「上一句只翻了一半、下一句接不上」——上游接口没有 prompt/上下文通道，也不会把 `raw_text` 数组里的相邻项当作上下文，逐条发就必然碎片化。
- 缝合规则与 magpie 插件一致：遇到句末标点（`.!?…。！？` 等）或累计 800 字符才收束成一句；译文若保留了换行且行数等于 cue 数则逐行精确回填，否则按源 cue 长度比例切分（切点吸附到空白/标点，避免从逗号、句号等收尾符号开头）。
- `check-size.mjs` 的单文件上限由 32,000 放宽到 **40,000 字节**（这是本仓库的自律线，不是 Cloudflare 限制；免费版压缩后上限 3 MB）。当前 worker.js 约 35.9 KB，gzip 约 12.4 KB。
- `test-hardening.mjs` 72 项：3 个旧的「subtitle-context 等同 subtitle」用例改写为缝合语义（含 5-cue 索引对齐、极碎 cue 回填、分隔符与空白保留）。
- README 补齐字幕模式对照与缝合说明。

## v0.4.0

### 破坏性变更：变量改名与模型 id 统一小写

- **`DOUBAO_COOKIE` 改名为 `DOUBAO_SESSION_ID`**。现在只需要 `sessionid` 的值，变量名如实反映语义。Worker 仍然读取旧的 `DOUBAO_COOKIE` 作为兜底（`env.DOUBAO_SESSION_ID ?? env.DOUBAO_COOKIE`），所以已部署的实例不会因为改名立刻 503；但请在 Cloudflare 面板把变量名改过来，旧名会在后续版本移除。
- **三个模型 id 统一为小写 kebab-case**：`doubao-ai-translation`（默认）、`volcengine-translate`、`microsoft-translator`。此前默认模型是 `Doubao-AI-Translation`，与另外两个大小写风格不一致。查找仍然大小写不敏感，旧 id `doubao-ai` 与旧写法 `Doubao-AI-Translation` 都能解析到同一引擎，响应体 `model` 字段回显规范的小写 id。
- `wrangler.jsonc` 的 `name` 与 `package.json` 的包名同步改为 `doubao-translate-worker`，与仓库名一致。**注意：这会部署出一个新的 Worker 域名**（`doubao-translate-worker.<子域>.workers.dev`），旧域名上的变量与自定义域名需要手动迁到新 Worker。
- `test-hardening.mjs` 72 项：新增「旧变量名 `DOUBAO_COOKIE` 仍可鉴权」用例。
- `wrangler.jsonc` 的 `DOUBAO_MAX_CONCURRENCY` 由 `3` 调整为 `4`，与代码兜底默认值一致；翻译 API 优先保证吞吐。
- 两个仓库的 README 重排：统一为「居中标题 + 徽章 + 目录 + 分区表格」结构，标题改为纯文字、去掉 emoji。

## v0.3.1

### 新增 `/v1/models` 与风控配额错误码

- 新增 `GET /v1/models`：返回 OpenAI 格式的模型列表（`Doubao-AI-Translation`、`volcengine-translate`、`microsoft-translator`），供 OpenAI SDK 与各类 GUI 客户端在启动时自动填充模型选择器。此前该路径返回 `404 not_found`，客户端只能手填模型名。该端点仍校验 `API_KEY`，但不需要豆包登录态。
- 上游 `710022002` / `710022013`（风控 / `tourist reach limited`）不再笼统报 `502 upstream_stream_error`，改为 `429 upstream_quota_exceeded`，客户端可据此退避重试，也便于区分「凭证失效」与「被限流」。
- `test-hardening.mjs` 从 66 项扩到 **71 项**。
- 仓库改名为 `doubao-translate-worker`，文档内的 clone / Deploy 按钮链接同步更新（`wrangler.jsonc` 的 `name` 与 npm 包名在 v0.4.0 才同步改名）。

## v0.3.0

### 与 magpie 插件形态对齐

- `DOUBAO_COOKIE` 只要求 `sessionid`（或 `sessionid_ss`）：`sid_tt`、`uid_tt` 与 `sessionid` 同源同寿命，强制要求它们不增加安全性，却让粘贴步骤变得啰嗦。现在三种写法都能用——只填 `sessionid` 的值、填完整 Cookie Header、或填浏览器导出的 Cookie JSON（`[...]` 与 `{"cookies":[...]}` 都识别）。
- 上游请求改为**豆包官方浏览器扩展（v1.38.0）的真实协议**：补上 `aid=586864` 等扩展固定查询参数与随机的 `tea_uuid` / `web_tab_id`，请求头带 Chrome UA、`Origin`、`Referer`、`sec-ch-ua`、`sec-fetch-*`、`Agw-Js-Conv: str`，`Accept` 改为 `text/event-stream`。此前用的是 Node 默认 `User-Agent: node` 与裸 URL，是最容易被判定为非网页客户端的两个特征。
- 模型 id 与显示名改为 `Doubao-AI-Translation`；`volcengine-translate`、`microsoft-translator` 保持不变；旧 id `doubao-ai` 仍作为别名可用（大小写不敏感）。响应体里的 `model` 字段回显解析后的规范 id。
- 未知模型不再只接受 `doubao-ai`，而是按支持列表校验，错误文案列出全部可选值。
- `test-hardening.mjs` 从 43 项扩到 **66 项**，新增 Cookie 规范化（裸值 / `Cookie:` 前缀 / `sessionid_ss` / 完整 Header / Cookie JSON / 4 种非法值）与上游伪装参数、模型映射的断言。
- 移除子目录 `magpie-plugin/`：该形态已独立成仓库并完成改名，仓库内旧副本会误导安装路径。

### Added

- 新增 **magpie 插件形态**（初版曾放在子目录 `magpie-plugin/`，现已独立为 [doubao-translation-magpie](https://github.com/LINKKDON/doubao-translation-magpie) 并从本仓库移除），把同一套翻译内核做成 magpie 插件，不用部署 Worker 即可在陪读蛙 / 沉浸式翻译里使用。
  - 目标语言覆盖陪读蛙全部 **180 / 180**（上游同类插件为 14 / 180；陪读蛙默认的 `zh-Hans` → `Simplified Mandarin Chinese` 在那边会直接报 `Unable to determine target translation language.`）。
  - `%%` 批量分隔符由服务端保管，不再上传给豆包上游，模型改写分隔符也不会导致拆包错位或 502。
  - 支持 `default` / `subtitle` / `subtitle-context` 三种上下文模式，以及 OpenAI Chat / Responses / Anthropic 三种协议、三个翻译引擎。
  - 错误码、重试与超时语义与 Worker 形态逐条对齐（`upstream_rate_limit` + `Retry-After`、`499 request_cancelled`、`504 upstream_timeout`、5xx/网络异常默认重试 1 次）。
  - **根目录 `worker.js`、`wrangler.jsonc` 与 Cloudflare Workers 部署未做任何改动**。

## v0.2.1

### 流式兼容层

- 接受 `stream: true`：内部仍等待豆包返回完整译文，再输出标准 OpenAI `chat.completion.chunk` 事件并以 `data: [DONE]` 结束，解决陪读蛙划词翻译等只走流式协议的客户端报 `Disable stream for this endpoint.`。
- 支持 `stream_options.include_usage`，追加一条零 token 的用量事件；非布尔 `stream` 返回 `400 invalid_request`。

### 字幕模式

- `subtitle` 不再把单条字幕内部的多行拆分或归一化：只把独立一行的 `%%` 当作字幕边界，普通空行、连续空行、CRLF 和正文首尾空白都原样保留并回填。
- 新增 `subtitle-context` 上下文模式：与 `subtitle` 走同一条索引对齐路径，一次请求内整批字幕一起发给上游，模型因此能看到相邻字幕的上下文。
- 修正 `subtitle-context`：不再把整组正文压成单个上游单元、也不再要求模型回显 `%%`。旧实现下 5 条字幕的批次实测 100% 返回 `502 upstream_stream_error`，导致客户端退回逐条翻译、上下文完全丢失。
- `subtitle-context` 与 `subtitle` 现在都按上游返回的 `index` 回填，单条上限 10,000 字符，纯空白字幕条并入分隔符而不上传空元素。
- `x-doubao-context-mode` 只接受 `default` / `subtitle` / `subtitle-context`，其他值返回 `400 invalid_request`。

### 稳定性与错误语义

- 上游 `429` 改为 `rate_limit_error`，并透传合法的 `Retry-After`；CORS 暴露 `Retry-After` 与 `x-request-id`。
- `Retry-After` 只透传纯秒数或标准 RFC 1123 HTTP-date，不再接受可被 `Date.parse` 误判的其他字符串（如 `7.5`）。
- 上游 `5xx` 和网络异常增加 1 次随机退避重试（`200–399 ms`），仍失败时保持原有 `502` / `504` 语义。
- 区分上游超时与客户端取消：上游超时返回 `504 upstream_timeout` 且不重试；客户端断开返回 `499 request_cancelled`，不再误报为超时。
- SSE 在索引完整时不再强制要求 `[DONE]`；索引缺失仍返回 `502 upstream_incomplete_result`。
- 翻译指令允许省略冒号，支持 `Translate to <语言>` 与 `翻译成<语言>` 的首行形式，并避免把指令送入翻译正文。
- 新增 `test-hardening.mjs`（35 项）并接入 `npm run build`，覆盖字幕模式、`Retry-After`、重试、超时与取消归因。
- 单文件 Worker 仍低于 32,000 字节上限（约 26.9 KB，gzip 约 8.8 KB）。

### 部署配置

- `wrangler.jsonc` 不再声明 `secrets.required`，改为 `keep_vars: true`：`API_KEY` 与 `DOUBAO_COOKIE` 由 Cloudflare 面板以明文变量维护，构建部署时保留面板变量，不再被删除。
- 说明：面板上已是明文变量时，配置里若仍保留 `secrets.required`，构建会以 `The following required secrets have not been set` 失败；README 已补充明文变量与 Secret 两种维护方式的取舍。

### 命名

- 去掉 `lite` 品牌：`/health` 的 `runtime` 返回值改为 `cloudflare-workers`；`stream: true` 与内部错误兜底的提示文案不再包含 Lite 字样。
- `wrangler.jsonc`、`package.json`、`package-lock.json` 的名称统一为 `doubao-translate2api`，与 Cloudflare 上的 Worker 服务名保持一致。

## v0.2.0

### 新增：请求内批次并发

- 新增 `DOUBAO_MAX_CONCURRENCY` 环境变量，取值 `1`–`4`，默认 `4`。
- 批次从严格串行改为按并发度分组并发执行。
- 实测（上游每批模拟 500ms 延迟，200 行 = 4 批）：

  | 配置 | 耗时 | 加速比 |
  | --- | --- | --- |
  | 串行（旧版） | 2043 ms | 1.00x |
  | `DOUBAO_MAX_CONCURRENCY=1` | 2044 ms | 1.00x |
  | `DOUBAO_MAX_CONCURRENCY=2` | 1032 ms | 1.98x |
  | `DOUBAO_MAX_CONCURRENCY=4`（默认） | 504 ms | 4.05x |

- 设为 `1` 时行为与旧版完全一致（实测耗时差 1 ms）。
- **输出顺序不变**：结果按原始行序回填，不会因并发错位。
- **错误语义不变**：任一批次失败时返回的错误码与串行版一致，且无未处理的 Promise 拒绝。

  | 失败场景 | 返回 |
  | --- | --- |
  | 上游 429 | `429 upstream_rate_limit` |
  | 上游 5xx | `502 upstream_http_error` |
  | 上游流不完整 | `502 upstream_incomplete_result` |
  | 网络失败 / 超时 | `502 upstream_network_error` / `504 upstream_timeout` |

### 新增：`scene` 参数可配置

- 新增 `DOUBAO_DEFAULT_SCENE` 环境变量，取值 `1`–`6`，默认 `2`（与旧版硬编码值一致）。
- 新增 `x-doubao-scene` 请求头，可按请求覆盖环境变量。
- 非法值处理：

  | 来源 | 非法时返回 |
  | --- | --- |
  | `x-doubao-scene` | `400 invalid_request` |
  | `DOUBAO_DEFAULT_SCENE` | `503 configuration_error` |

### 测试

- 新增 13 个回归测试套件，全部通过：
  - 语言解析优先级（9 项）
  - HTML 守卫（16 项）
  - SSE 解析（5 项）
  - 行数与批次数上限
  - 413 归因（区分请求体过大与批次数超限）
  - 队列参数边界
  - 并发错误语义（6 项）
  - `scene` 参数（7 项）

### 体积

- `worker.js`：8,071 → 14,254 字节，仍远低于 32,000 字节上限。

---

## v0.1.3

- 语言解析优先级修正：`target_lang` / `x-doubao-target-lang` > user 消息前缀 > system 提示词（仅取有效猜测）> `DOUBAO_DEFAULT_TARGET_LANG`。
- 语言表扩容，覆盖更多语言名；地区码归一化（`en-US` → `en`、`zh-TW` → `zh-Hant` 等）。
- HTML 守卫收紧：只在真实标记时拒绝，正文中作为普通文字出现的标签名不再误判。
- 上游重复 `index` 时取最后一条，避免结果被旧值覆盖。
