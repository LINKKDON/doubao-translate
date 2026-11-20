<div align="center">

# 豆包翻译 · magpie 插件

把豆包网页版的翻译能力做成 magpie 插件：不用部署 Worker、不用公网地址、不用 API Key，装进 magpie 后即可作为 OpenAI 兼容 provider 使用。

OpenAI 兼容 · 纯文本 · 零依赖 · MIT

![Node](https://img.shields.io/badge/Node.js-24-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![Tests](https://img.shields.io/badge/tests-188%20passing-2EA44F?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)

</div>

同一个仓库里还有一个 Cloudflare Workers 形态，在 `worker/` 子目录，**与插件共用同一份 `src/` 源码**（`worker/worker.js` 由它打包生成）。详见 [worker/README.md](./worker/README.md)。

## 目录

[项目说明](#about) · [免责声明](#disclaimer) · [合规风险](#compliance) · [安装](#install) · [登录](#login) · [模型](#models) · [字幕翻译](#subtitles) · [插件选项](#options) · [伪装与稳定性](#disguise) · [限制](#limits) · [错误码](#errors) · [已知限制](#known-limits) · [开发与测试](#dev)

---

<a id="about"></a>

## 项目说明

插件装进 [magpie](https://github.com/yetone/magpie)，由宿主发起 OpenAI 兼容请求，插件负责 `%%` 拆包、调用豆包网页版翻译接口、按原顺序回填。零运行时依赖，源码只 import 相对路径模块与 `node:` 内置模块。

| 适合 | 不适合 |
| --- | --- |
| 本地划词、整页翻译、字幕批量翻译 | 需要提示词控制、术语表或自定义风格 |
| 已在用 magpie、不想额外部署服务 | 多轮对话、function calling、真正的逐字流式 |

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

<a id="install"></a>

## 安装

前置：magpie 已装好；一个已登录 <https://www.doubao.com> 的网页版账号。

插件就在仓库**根目录**（Worker 形态在 `worker/` 子目录，不会被装进来），可直接从 git 安装（magpie → Settings → Plugins → 添加插件）：

```text
github:LINKKDON/doubao-translate
```

想锁定版本就加 `#` + commit SHA（`#` 后是 git ref，不是子目录）；仓库打过 tag 后也可写 `#v0.1.1`：

```bash
git tag v0.1.1 && git push origin v0.1.1
```

本地开发想即时生效，可 `git clone` 后用 `file://` 指向仓库根目录（例 `file:///home/you/doubao-translate`）。

<a id="login"></a>

## 登录

登录方式为 **Import Doubao Cookie**，不弹浏览器、不要 API Key。

1. 浏览器登录 <https://www.doubao.com>，`F12` → Application → Cookies → `https://www.doubao.com`
2. 复制 `sessionid` 那一行**后面的值**（不带 `sessionid=`；也可整条 Cookie header 或浏览器导出的 Cookie JSON）
3. magpie → Settings → Plugins → 豆包翻译 → 登录 → 粘贴

只需 `sessionid`（或 `sessionid_ss`）的值，其余 Cookie 可选。插件会去掉多余空白、按需补上 `sessionid=`，调用豆包账号信息接口校验会话，并**自动读取账号名**，无需手填。Cookie 只由 magpie 宿主保管，插件经 `getAuth()` 读取，绝不写进 `Authorization` 头；过期时响应带 `X-Magpie-Sign-In: expired`，magpie 据此提示重新登录。

<a id="models"></a>

## 模型

| 模型 | 说明 |
| --- | --- |
| `doubao-ai-translation` | 默认，豆包 AI 翻译，质量最好 |
| `volcengine-translate` | 火山引擎机翻 |
| `microsoft-translator` | 微软翻译 |

三个 id 统一小写，大小写不敏感；旧 id `doubao-ai` 与旧写法 `Doubao-AI-Translation` 仍可用。写错返回 `404 model_not_found` 并列出可用项。

<a id="subtitles"></a>

## 字幕翻译

字幕的每一行（cue）是**显示**单位，不是语言单位：一个句子常被切成好几条 cue，例如

```
I told him that
%%
we should leave before
%%
the storm hits.
```

逐条送上游时每段都会丢掉主语或宾语，回来就是「我告诉他」/「我们应该在」/「暴风雨来袭时。」这种接不上的碎片——这是上游接口本身的限制（它只接受待译文本数组，没有上下文或提示词通道，也不会拿同批邻居当参考）。

插件用请求头 `x-doubao-context-mode` 选择切分方式：

| 模式 | 行为 |
| --- | --- |
| `default`（默认） | 每个非空行单独一条，适合网页整页/划词 |
| `subtitle` | 只有**独立一行的** `%%` 是边界，cue 内部换行原样保留；逐 cue 翻译 |
| `subtitle-context` | 在上面的基础上，**把被切碎的句子按句末标点重新缝合**，整句送上游翻译，再把译文按原 cue 边界摊回去显示 |

要用字幕缝合，请把提示词模式设成 `subtitle-context`（`%%` 行由插件保管，不会进入上游文本）。缝合有两点取舍：

- 译文必须能按 cue 数摊回：先尝试按换行对齐，对不上就按源 cue 的长度比例切分，切口尽量落在空白处，因此个别 cue 的断句位置可能和原文略有出入。
- `maxChars`（默认 800）会在累计字符数达到上限时强制断句，避免没有句号的长 cue 把整篇吞成一句。

最好的效果仍是**让一个 cue 就是一个完整句子**——那样缝合层无事可做，天然对齐。

<a id="options"></a>

## 插件选项

magpie → Plugins 页 → 已安装插件那一行的 Options JSON 编辑器：

```json
{
  "targetLang": "zh",
  "scene": 2,
  "maxConcurrency": 4,
  "requestTimeoutMs": 45000,
  "totalTimeoutMs": 180000,
  "authTimeoutMs": 10000,
  "maxRetries": 1
}
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `targetLang` | `"zh"` | 识别不到目标语言时的兜底 |
| `scene` | `2` | 上游 `scene`（1–6） |
| `maxConcurrency` | `4` | 并发上限；翻译 API 需要吞吐，默认 4 路 |
| `requestTimeoutMs` | `45000` | 单批上游超时 |
| `totalTimeoutMs` | `180000` | 整个请求超时 |
| `authTimeoutMs` | `10000` | 登录校验超时 |
| `maxRetries` | `1` | 5xx / 网络异常重试次数 |

<a id="disguise"></a>

## 伪装与稳定性

这套接口是豆包**官方浏览器扩展**（v1.38.0）使用的内部翻译接口，并非公开 API。为降低被风控拦截的概率，插件在传输层对齐了扩展客户端：

- 每个上游请求都带扩展的固定查询参数（`aid=586864`、`device_platform=web`、`version=1.38.0`、`version_code=20800`、`tea_uuid`、`web_tab_id` 等）和一套浏览器请求头（Chrome UA、`Origin`、`Referer: https://www.doubao.com/`、`Accept: text/event-stream`、`sec-fetch-*`、`agw-js-conv: str`），不会以 `User-Agent: node` 裸发。
- 上游按 `maxConcurrency`（默认 `4`）并发以保吞吐；频率过高时请自行调低。

即便如此，频率过高、账号异常或出口 IP 被标记时仍可能被要求人工验证，请控制使用频率。

<a id="limits"></a>

## 限制

| 项 | 上限 |
| --- | --- |
| HTTP 请求体 | 2 MiB |
| 一次请求正文总量 | 20,000 字符 |
| 单个翻译单元 | 10,000 字符 |
| 一次请求翻译单元数 | 200 |
| 每批 | 50 条且 ≤ 10,000 字符 |

超限返回 `413 request_too_large`。

<a id="errors"></a>

## 错误码

| 状态 | `code` | 含义 |
| --- | --- | --- |
| 400 | `invalid_request` | 请求不合法（未知路径、JSON 错、header 非法） |
| 400 | `unsupported_input` | 输入不是纯文本 |
| 400 | `empty_translation_input` | 待翻译正文为空 |
| 400 | `unsupported_feature` | 用了不支持的字段（tools / reasoning / n>1 / response_format） |
| 400 | `unsupported_target_language` | 语言码不认识 |
| 401 | `cookie_missing` | 还没登录（带 `X-Magpie-Sign-In: expired`） |
| 401 | `cookie_invalid` | Cookie 格式不对（缺 `sessionid` / `sessionid_ss`） |
| 401 | `upstream_auth_error` | 豆包登录已过期 |
| 404 | `model_not_found` | 模型名不在可选范围 |
| 413 | `request_too_large` | 超过限制 |
| 429 | `upstream_rate_limit` | 豆包限流，透传 `Retry-After` |
| 429 | `upstream_quota_exceeded` | 账号或匿名会话触发豆包风控配额，稍后重试或换新登录 |
| 499 | `request_cancelled` | 客户端断开 |
| 502 | `upstream_http_error` / `upstream_network_error` / `upstream_incomplete_result` / `upstream_stream_error` | 上游异常 |
| 503 | `configuration_error` | 插件配置错误 |
| 504 | `upstream_timeout` | 上游超时 |

<a id="known-limits"></a>

## 已知限制

- 只翻纯文本；自定义提示词、术语表、多轮对话、工具调用、结构化输出均不生效。
- 不支持图片 / 音频输入。
- 只翻最后一条 user 消息，历史消息仅用于推断目标语言。
- 流式为协议兼容的假流式（等完整译文后一次性下发）。
- `usage` 恒为 0（豆包翻译接口不返回 token 用量）。

<a id="dev"></a>

## 开发与测试

```bash
node --check src/*.mjs
node --test test/*.test.mjs      # 必须用 glob，node 24 下传目录会 MODULE_NOT_FOUND
```

- 零运行时依赖：`src/` 只 import `./xxx.mjs` 与 `node:` 内置模块。
- 180 语言扫掠测试使用仓库内 `test/fixtures/rf_langs.json`，离线运行。
- 模块接口见 [CONTRACT.md](./CONTRACT.md)。

| 模块 | 职责 |
| --- | --- |
| `src/index.mjs` | 插件入口：config / auth / provider 三个 hook 与请求分发 |
| `src/lang.mjs` | 语言归一化、指令解析、目标语言兜底 |
| `src/units.mjs` | `%%` 拆包与回填、三上下文模式、句子缝合、分批 |
| `src/doubao.mjs` | 上游请求（扩展协议伪装）、三引擎、Cookie 校验、账号信息、重试与错误语义 |
| `src/protocols.mjs` | OpenAI Chat / Responses / Anthropic 三协议适配与渲染 |
| `src/errors.mjs` | 统一错误类型与状态码映射 |

---

<div align="center">

<sub>只用本人账号，别把 Cookie 交给任何人</sub>

</div>
