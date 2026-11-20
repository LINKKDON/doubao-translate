<div align="center">

# 豆包翻译 · Cloudflare Worker

把豆包网页版的翻译能力封装成 Cloudflare Worker，作为 OpenAI 兼容的纯文本翻译接口，供任何支持自定义 Provider 的翻译插件使用。

OpenAI 兼容 · 纯文本 · 无状态 · MIT

![Node](https://img.shields.io/badge/Node.js-24-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![Worker](https://img.shields.io/badge/worker.js-28.3%20KB-333333?style=flat-square)
![Tests](https://img.shields.io/badge/tests-83%20passing-2EA44F?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)

</div>

```text
翻译插件（沉浸式翻译 / 陪读蛙）──► Worker（worker/）──► 豆包网页版翻译接口
      OpenAI 兼容请求                鉴权 · 拆包 · 回填        raw_text + target_lang
```

> `worker/worker.js` 是**构建产物**，由 `worker/scripts/build.mjs` 从仓库根 `src/` 的共享内核打包生成。改逻辑请改 `src/`，然后 `npm run build`。

## 目录

[项目说明](#about) · [免责声明](#disclaimer) · [合规风险](#compliance) · [快速开始](#quickstart) · [配置](#config) · [客户端接入](#client) · [字幕模式](#modes) · [接口参考](#api) · [限制与超时](#limits) · [错误与重试](#errors) · [安全](#security) · [本地开发](#local) · [排错](#troubleshoot) · [许可](#license)

---

<a id="about"></a>

## 项目说明

Worker 接收 OpenAI Chat Completions 请求，把正文拆成翻译单元发往豆包网页版翻译接口，再按原顺序回填成 OpenAI 响应。全程无状态、单文件部署、零第三方运行时依赖。

| 适合 | 不适合 |
| --- | --- |
| 沉浸式翻译、陪读蛙等 OpenAI 兼容插件 | 需要提示词控制、术语表或自定义风格 |
| 网页整页翻译、字幕批量翻译、划词翻译 | 多轮对话、function calling、真正的逐字流式 |

> **它不是通用 LLM 网关。** 上游只接收「正文 + 目标语言」，提示词、术语表、多轮对话、工具调用都不生效；`stream: true` 只是协议兼容的假流式。

同一个仓库里还有 **magpie 插件形态**（仓库根目录即插件），装进 magpie 即用，无需部署与 API Key。**两者共用同一份源码**：插件直接用 `src/`，Worker 的 `worker/worker.js` 由 `src/` 打包生成，因此 `%%` 拆包、字幕缝合与错误语义完全一致。

| | Worker（`worker/`） | magpie 插件（仓库根） |
| --- | --- | --- |
| 部署 | Cloudflare Workers | 装进 magpie，无部署 |
| 访问范围 | 有公网地址，多设备可用 | 只在本机 |
| 鉴权 | `API_KEY` | magpie 宿主 |
| 协议 | OpenAI Chat | OpenAI Chat / Responses / Anthropic |
| 目标语言 | 141 个语言名 | 180 个 |
| 源码 | `worker/worker.js`（构建产物） | `src/`（唯一真源） |

<a id="disclaimer"></a>

## 免责声明

- 第三方**非官方**项目，与豆包、字节跳动及其关联公司无隶属或授权关系。
- 仅供个人学习、研究与自用，不得用于违反豆包服务条款或法律法规的用途。
- 登录依赖你本人账号的 Cookie（`sessionid` 属敏感凭证），请勿公开、提交或分享；账号风险自负。
- 按 MIT 协议「现状」提供，不对可用性、准确性或任何直接、间接损失担保。

<a id="compliance"></a>

## 合规风险

- **账号授权 ≠ 接口授权**：能登录网页版，不代表获准批量调用翻译接口。
- **个人使用不自动免责**：仅自己使用也应遵守平台条款与限制。
- **不绕过平台限制**：本项目不做验证码绕过、风控规避或频率破解。
- **处理文本需有权限**：不要提交他人隐私或受版权保护的敏感数据。
- **商业或对外服务需单独评估**：用于商业或对外提供服务前请自行完成合规评估并取得授权。

免责声明与 MIT 协议均不能替代平台授权。

---

<a id="quickstart"></a>

## 快速开始

四步：部署 → 填两个变量 → 客户端填三个值 → curl 自测。

### 1 · 部署

| 方式 | 怎么做 |
| --- | --- |
| 本地 Wrangler（推荐） | `cd worker && npm ci && npm run build && npm run deploy`（需 Node 24） |
| Cloudflare 面板 / Workers Builds | Root directory 填 `worker`，Build command 填 `npm run build` |
| 控制台粘贴 | 把 `worker/worker.js` 整段贴进 Worker 编辑器保存 |

> 仓库根是 magpie 插件包，Worker 是 `worker/` 子包；在 Cloudflare 侧配置时注意 **Root directory = `worker`**，否则找不到 `worker.js`。

### 2 · 填两个必需变量

Worker → **设置 → 运行时变量和密钥**：

| 名称 | 填什么 |
| --- | --- |
| `API_KEY` | 自己生成的随机串，≥ 16 字符且不含空白 |
| `DOUBAO_SESSION_ID` | 豆包 `sessionid` 的值（也可填完整 Cookie Header 或 Cookie JSON） |

> v0.4.0 起变量名由 `DOUBAO_COOKIE` 改为 `DOUBAO_SESSION_ID`。Worker 仍把旧名作为兜底读取，请把面板上的名字改过来，旧名后续会移除。

<details>
<summary>生成 API_KEY 与取 Cookie 的具体步骤</summary>

```sh
openssl rand -hex 32                                   # macOS / Linux
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # Windows
```

取 Cookie：登录 `https://www.doubao.com` → `F12` → **Network** → 刷新 → 任一请求的 **Request Headers** → `Cookie` → 只复制 `sessionid` 那一行**后面的值**（不带 `sessionid=`）。

> `sessionid` 是 HttpOnly，`document.cookie` 读不到；它等同账号密码，别贴到任何公开地方。

</details>

### 3 · 客户端填三个值

| 配置项 | 值 |
| --- | --- |
| Base URL | `https://<你的 Worker 域名>/v1` |
| API Key | 与 Worker 的 `API_KEY` 相同 |
| 模型 | `doubao-ai-translation` |

模板用纯文本，如 `Translate to {{to}}:\n\n{{text}}`；流式开或关均可。

### 4 · 自测

```sh
curl -s "https://<你的 Worker 域名>/health"
# {"status":"ok","runtime":"cloudflare-workers"}

curl -s "https://<你的 Worker 域名>/v1/chat/completions" \
  -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" \
  -d '{"model":"doubao-ai-translation","messages":[{"role":"user","content":"Translate to Chinese:\nHello there."}]}'
```

`choices[0].message.content` 应为中文译文；`usage` 的 token 恒为 `0`（上游不返回用量）。所有响应带 `x-request-id`，排错时一并提供。

---

<a id="config"></a>

## 配置

| 变量 | 必需 | 默认 | 说明 |
| --- | --- | --- | --- |
| `API_KEY` | 是 | — | ≥ 16 字符且不含空白；客户端 Bearer Token |
| `DOUBAO_SESSION_ID` | 是 | — | 含 `sessionid`（或 `sessionid_ss`）；只填值即可 |
| `DOUBAO_DEFAULT_TARGET_LANG` | 否 | `zh` | 请求未指定目标语言时的兜底 |
| `DOUBAO_DEFAULT_SCENE` | 否 | `2` | 上游 `scene`（1–6），可用 `x-doubao-scene` 覆盖 |
| `DOUBAO_MAX_CONCURRENCY` | 否 | `4` | 单请求内并发的批次数（1–4）；遇 `429` 先降到 2 或 1 |

必需变量缺失或非法返回 `503 configuration_error`，`message` 会指明是哪一项。

<details>
<summary>明文变量还是 Secret，怎么切换</summary>

默认用**明文变量**，`wrangler.jsonc` 设了 `"keep_vars": true`，每次部署保留面板变量，换 Cookie 只需面板改一次。

改用 Secret：`npx wrangler secret put API_KEY`、`npx wrangler secret put DOUBAO_SESSION_ID`，并在 `wrangler.jsonc` 加回 `"secrets": { "required": [...] }`，否则下次 `wrangler deploy` 会删掉这两个 Secret。

| 对比 | 明文变量 | Secret |
| --- | --- | --- |
| 面板可读回 | 能，有权限的人都看得到 | 不能，只显示名称 |
| 改值方式 | 面板直接编辑 | `wrangler secret put` 重写 |
| 适合 | 单人维护、Cookie 常换 | 多人协作、更在意暴露面 |

> 两者不要混用：面板是明文、配置却写 `secrets.required`，构建会报 `The following required secrets have not been set`。

</details>

> 面板改完变量**不等于生效**：Git 连接的 Worker 会先生成新版本，需到「部署」页把该版本提升到 100% 流量再复测。

---

<a id="client"></a>

## 客户端接入

```python
from openai import OpenAI

client = OpenAI(base_url="https://<你的 Worker 域名>/v1", api_key="<API_KEY>")
resp = client.chat.completions.create(
    model="doubao-ai-translation",
    messages=[{"role": "user", "content": "Translate to Chinese:\nHello there."}],
)
print(resp.choices[0].message.content)
```

字幕类客户端的 `subtitle` / `subtitle-context` 模式必须由客户端主动带 `x-doubao-context-mode` 请求头——Worker **不会**根据内容猜这是网页还是字幕。

---

<a id="modes"></a>

## 字幕模式

模式由请求头 `x-doubao-context-mode` 决定，省略即 `default`。

| 模式 | 取值 | 拆分方式 | 适用 |
| --- | --- | --- | --- |
| 逐行 | 省略 / `default` | 每个非空行一个单元 | 网页整页翻译 |
| 字幕逐条 | `subtitle` | 独立一行的 `%%` 才是边界，字幕内部换行原样保留 | 客户端已按字幕条组包 |
| 字幕缝合 | `subtitle-context` | 同 `subtitle`，但先把被切碎的 cue 缝成整句再翻译，译文按原 cue 边界回填 | 字幕把一句话拆成多条 cue 的客户端 |

整批字幕一次请求内一起发给豆包（`raw_text` 本身就是数组），对齐由上游返回的 `index` 保证，**不依赖模型回显 `%%`**（要求模型复读分隔符时 5 条以上批次实测 100% 失败）。单条上限 10,000 字符，含空白的字幕条会并入分隔符。

`subtitle-context` 额外做**句子缝合**：上游接口没有 prompt/上下文通道、也不会把数组里相邻项当作上下文，所以被拆开的句子必须先合并再翻译。Worker 会把相邻 cue 拼成一句（遇到句末标点或累计 800 字符才收束）发给上游，再把整句译文按各 cue 的原始长度比例切回原 cue 行——语义完整，但在极碎的 cue 下可能断在词组中间。与 magpie 插件行为一致。

---

<a id="api"></a>

## 接口参考

| 方法与路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `POST /v1/chat/completions` | 必需 | 翻译入口（`Authorization: Bearer` 或 `x-api-key`） |
| `GET /v1/models` | 必需 | OpenAI 格式模型列表；不需要 `DOUBAO_SESSION_ID` |
| `GET /health` | 无需 | 健康检查 |
| `OPTIONS ...` | 无需 | 预检，返回 `204` |

请求体：`messages`（必填，最后一条 `user` 的 `content` 必须是字符串）；`model`（默认 `doubao-ai-translation`，可选 `volcengine-translate`、`microsoft-translator`，旧名 `doubao-ai` 等价，其他值 `404 model_not_found`）；`stream`（`true` 返回 SSE）；`target_lang`（目标语言，优先级最高）；`tools` / `functions` / `reasoning` 出现即 `400 unsupported_feature`。

请求头：`x-doubao-target-lang`（优先级低于 body `target_lang`）、`x-doubao-scene`（1–6）、`x-doubao-context-mode`。

**目标语言优先级**：① body `target_lang` → ② 头 `x-doubao-target-lang` → ③ `user` 开头指令（`Translate to Chinese:` / `翻译成中文：`，可省冒号）→ ④ `system` / `developer` 里的语言名 → ⑤ `DOUBAO_DEFAULT_TARGET_LANG`。移除指令后无正文 `400 empty_translation_input`，多条 system 冲突 `400 invalid_request`，语言无法识别 `400 unsupported_target_language`。

> 发给上游的请求体固定为 `{raw_text, target_lang, translate_service, scene, frontend_source}`，所以提示词、术语表、多轮、工具、推理参数一律不生效；`system` / `developer` 只用于猜语言。

---

<a id="limits"></a>

## 限制与超时

| 项目 | 上限 | 超出 |
| --- | --- | --- |
| HTTP 请求体 | 64 KiB | `413 request_too_large` |
| 翻译正文总长 | 20,000 字符 | `413 request_too_large` |
| 单行 / 单条字幕 / 上下文组 | 10,000 字符 | `413 request_too_large` |
| 非空翻译单元 | 200 个 | `413 request_too_large` |
| 上游批次 | ≤ 4 批（每批 ≤ 50 单元且 ≤ 10,000 字符） | `413 request_too_large` |
| 上游响应体 / 译文总量 | 512 KiB / 256 KiB | `502 upstream_stream_error` |
| 单批 / 整个请求超时 | 45 秒 / 90 秒 | `504 upstream_timeout` |

网页翻译建议每批 25 行左右。HTML、YAML、`text` 包装模板会被拒绝（`400 unsupported_input`），但正文里的 `<br>`、`a < b` 不会误判。

---

<a id="errors"></a>

## 错误与重试

| 状态 | `code` | 含义 |
| --- | --- | --- |
| `400` | `invalid_request` | JSON、参数或上下文模式不合法 |
| `400` | `unsupported_input` | 用了 HTML / YAML 等不支持的模板 |
| `400` | `empty_translation_input` | 剥掉指令后没有正文 |
| `400` | `unsupported_feature` | 请求了工具、推理等不支持的能力 |
| `400` | `unsupported_target_language` | 目标语言无法识别 |
| `401` | `unauthorized` | API Key 缺失或错误 |
| `404` | `model_not_found` / `not_found` | 模型不在列表内，或路径错误 |
| `413` | `request_too_large` | 超过请求体、正文、单元数或批次限制 |
| `429` | `upstream_rate_limit` | 豆包上游 429 限流（带 `Retry-After`） |
| `429` | `upstream_quota_exceeded` | 风控配额用尽（上游 `710022002` / `710022013`） |
| `499` | `request_cancelled` | 客户端在翻译完成前断开 |
| `502` | `upstream_auth_error` | 豆包登录态失效（Cookie 过期，上游 `710012001`） |
| `502` | `upstream_http_error` / `upstream_network_error` | 上游 HTTP 或网络失败 |
| `502` | `upstream_incomplete_result` / `upstream_stream_error` | 上游返回不完整或格式异常 |
| `503` | `configuration_error` | 必需或可选变量不合法 |
| `504` | `upstream_timeout` | 上游超时 |

OpenAI 错误结构：`401` → `authentication_error`、其他 4xx → `invalid_request_error`、`429` → `rate_limit_error`、5xx → `api_error`，原因看 `code`。

重试：上游 `5xx` / 网络异常自动重试 1 次（退避 `200–399 ms`）；`429`、超时、客户端断开不重试；`Retry-After` 只透传纯秒数或 HTTP-date。

`stream: true` 返回标准 `chat.completion.chunk`，顺序为 `delta{role,content}` → `delta{} + finish_reason:stop` → `[DONE]`；带 `include_usage` 时追加一条零 token 用量事件。译文在发第一个事件前已完整生成（首字延迟同普通请求）。

---

<a id="security"></a>

## 安全

| 事项 | 说明 |
| --- | --- |
| 公开仓库 | 提交、Issue、PR 都不要出现真实 Cookie 或 Key；`.dev.vars*` 已忽略 |
| 明文变量 = 面板可见 | 有账户权限的人都读得到值 |
| Cookie 等价于账号 | `sessionid` 泄露即可冒用你的豆包登录态 |
| Key 只影响本项目 | 泄露后换一个即可，记得同步所有客户端 |
| CORS 是 `*` | 任何网站都能调用，但仍需带 Key，别把 Key 写进前端 |

> Cookie 过期时返回 `502 upstream_auth_error`，重新取 Cookie 覆盖 `DOUBAO_SESSION_ID` 即可。

---

<a id="local"></a>

## 本地开发

```sh
git clone https://github.com/LINKKDON/doubao-translate.git
cd doubao-translate/worker && npm ci
cp .dev.vars.example .dev.vars      # Windows PowerShell: Copy-Item
npm run dev                          # wrangler dev，会先跑 npm run build
```

`npm run build` = `node scripts/build.mjs`（从 `../src` 打包出 `worker.js`）+ `node --check worker.js`（语法）+ `node test-hardening.mjs`（83 项回归）+ `node check-size.mjs`（≤ 45,000 字节）。

> `worker.js` 是生成物，**不要手改**。改逻辑请改根目录 `src/`，再 `npm run build`；`npm run check` 会在 CI/本地校验 `worker.js` 与源码是否同步。回归覆盖语言解析与优先级、CORS、`429`/`Retry-After`、`5xx` 与网络重试、超时与客户端取消、SSE 完整性、批次并发、字幕拆分与上下文模式、`400`/`413` 边界。

> 模拟测试不能替代真实账号与 Cookie 的联调，上线后请用真实客户端做一次端到端验收。

---

<a id="troubleshoot"></a>

## 排错

| 现象 | 处理 |
| --- | --- |
| `401 unauthorized` | Key 与 `API_KEY` 不一致，或多空格 / 引号 |
| `503 configuration_error` | 变量缺失或越界，看响应 `message` |
| `404 model_not_found` | 模型名不在列表（省略即 `doubao-ai-translation`） |
| `400 unsupported_input` | 模板不是纯文本，换成 `Translate to {{to}}:\n\n{{text}}` |
| `502 upstream_auth_error` | Cookie 过期，重新取 Cookie 覆盖 |
| `429 upstream_rate_limit` | 请求太密：`DOUBAO_MAX_CONCURRENCY` 降到 1–2 或按 `Retry-After` 退避 |
| `413 request_too_large` | 一次发太多：网页每批 ≤ 25 行，字幕单条/组 ≤ 10,000 字符 |
| 字幕上下句不连贯 | 客户端没带 `x-doubao-context-mode`，或用了 `subtitle` 而非 `subtitle-context` |
| 提示词 / 术语表没反应 | 上游只收正文和语言，本就不支持 |
| 面板改变量线上没变 | 新版本未承接流量，去「部署」页提升到 100% |

---

<a id="license"></a>

## 许可

- 当前版本 `0.6.0`，完整历史见 [CHANGELOG.md](CHANGELOG.md)
- 基于上游同源的 Cloudflare Worker 项目（[mu-zi-lee](https://github.com/mu-zi-lee)）独立维护
- MIT License，见 [LICENSE](LICENSE)

<div align="center">

<sub>只用本人账号，别把 Cookie 和 Key 交给任何人</sub>

</div>
