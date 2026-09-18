# generateImage — 腾讯云开发（CloudBase）AI 生图云函数

[![CI](https://github.com/ninekiss/cloudbase-generate-image/actions/workflows/ci.yml/badge.svg)](https://github.com/ninekiss/cloudbase-generate-image/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一个可直接部署的 CloudBase 云函数，把**混元生图**封装成两种形态：

1. **HTTP 接口** —— 文生图 / 图生图，带 API Key 鉴权与真实 HTTP 状态码
2. **MCP Server** —— 可直接接入 Claude Code / Cursor 等标准 MCP 客户端

同时提供一份**零框架自建版**（`selfhosted/`），同一套核心逻辑可脱离云函数在普通 Node 进程运行。

---

## 特性

| 能力 | 状态 | 入参 |
|---|---|---|
| 文生图 T2I | ✅ | `prompt` / `model` / `size` / `seed` |
| 图生图 I2I | ✅ | `prompt` + `image_urls`（推荐）或 `images`（base64） |
| 自定义水印 | ✅ | `footnote`（≤16 字符，右下角） |
| **无水印** | ✅ | `footnote` 传**空白空格** `" "` |
| 参考图自动压缩 | ✅ | 自动触发（>120KB），`compress:false` 可关 |
| seed 可复现 | ✅ | `seed` |
| MCP 协议 | ✅ | `?mcp=1` 或 header `x-mcp:1` |
| API Key 鉴权 | ✅ | fail-closed，环境变量 `API_KEY` + header `x-api-key` |
| HTTP 状态码透传 | ✅ | 200 / 400 / 401 / 422 / 500 |
| Clarity 超分 / 多图 | ❌ | SDK 不支持，需直连腾讯云裸 API |

---

## 目录结构

```
.
├── index.js              # 云函数主逻辑（单文件，无外部框架依赖）
├── package.json          # 依赖：@cloudbase/node-sdk + sharp
├── docs/实测报告.md       # ★ 完整技术文档：能力 / 实测 / 踩坑 / 调用示例
└── selfhosted/           # 可脱离云函数运行的自建版
    ├── server.js         #   零框架，仅用 Node 内置 http 模块
    ├── package.json
    └── README.md         #   迁移说明：哪些要改、凭证怎么传、差异清单
```

---

## 快速开始（云函数）

### 1. 部署

```bash
# 依赖 sharp（含原生绑定）建议用云函数层挂载，代码包内不要带 node_modules
# 详见 docs/实测报告.md 第十节
```

部署后在函数配置里设置环境变量：

| 变量 | 必填 | 说明 |
|---|---|---|
| `API_KEY` | ✅ | 对外鉴权 key。**fail-closed**：不配置则拒绝所有 HTTP 访问 |
| `DEFAULT_MODEL` | ❌ | 覆盖默认文生图模型 |

### 2. 调用

```bash
curl -X POST "https://YOUR_ENV_ID-YOUR_APPID.ap-shanghai.app.tcloudbase.com/api/gen-image" \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"prompt":"一只戴着宇航头盔的柴犬，赛博朋克风格","size":"1024x1024"}'
```

### 3. 接入 MCP 客户端

```json
{
  "mcpServers": {
    "generate-image": {
      "type": "http",
      "url": "https://YOUR_ENV_ID-YOUR_APPID.ap-shanghai.app.tcloudbase.com/api/gen-image?mcp=1",
      "headers": { "x-api-key": "YOUR_API_KEY" }
    }
  }
}
```

> `type` 必填 —— 只有 `url` 没有 `type` 会被客户端当作 stdio 传输，报错。

---

## 快速开始（自建版，不用云函数）

```bash
cd selfhosted
npm install

CLOUDBASE_ENV=YOUR_ENV_ID \
TENCENTCLOUD_SECRETID=xxx \
TENCENTCLOUD_SECRETKEY=xxx \
API_KEY=your-api-key \
node server.js
```

接口与云函数版**完全一致**，客户端无需改动。差异与注意事项见 [`selfhosted/README.md`](selfhosted/README.md)。

> **临时密钥必须同时传 `sessionToken`**，否则报 HTTP 401。长期密钥（CAM 生成）不需要。

---

## 这个项目踩过的坑（都写进文档了）

[`docs/实测报告.md`](docs/实测报告.md) 是本仓库最有价值的部分，记录了实测过程中发现的真实问题：

- **★ `ai.createImageModel(X)` 的第一个参数是 provider，不是模型名** —— 传错必 404（本项目最大的坑）
- **★ CloudBase HTTP 网关只返回普通对象时一律回 HTTP 200** —— 错误分支必须返回带 `statusCode` 的结构才能透传真实状态码
- **★ MCP 鉴权：只有 `tools/call` 该校验 key** —— `initialize` / `ping` / `notifications/*` 等协议层方法必须放行，否则标准客户端连不上
- **★ 用「字段是否为空」判断请求通道是不可靠的** —— 曾因此让普通 HTTP 请求整个绕过鉴权
- **★ `sharp` 在 CloudBase 上必须用云函数层挂载** —— 本地 `node_modules` 会被打包上传，平台不匹配导致 `require` 失败

---

## 环境要求

- Node.js 18+（云函数运行时 Nodejs18.15）
- `@cloudbase/node-sdk` **>= 3.18.3**（2.x 没有 `ai()` 方法，会报 `app.ai is not a function`）
- `sharp` ^0.33.5

---

## 持续集成

仓库自带 GitHub Actions 工作流 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)，在 push / PR 到 `main` 时自动执行：

| 任务 | 内容 |
|---|---|
| **语法与结构校验** | 在 Node `18.15` / `20` / `22` 三档下跑 `node --check` 校验 `index.js` 与 `selfhosted/server.js`；并校验两个 `package.json` 可被 `JSON.parse` |
| **敏感信息扫描** | 拦截硬编码密钥（`AKID...`、`sk-...`、`gh*_...`、`*secretKey = "..."`）与真实环境标识（`pc-<envId>`、`lam-<functionId>`、真实 appid） |

设计取舍：

- **刻意不做 `npm install`** —— 本仓库依赖 `sharp`（含原生绑定）和 `@cloudbase/node-sdk`，在 CI 装它意义不大（真正的运行环境是云函数层挂载的 `sharp`），且会拖慢流水线。语法校验已足以拦住绝大多数低级错误。
- **敏感信息扫描是防回归的**，不是替代人工审计 —— 仓库是公开的，任何一次 `git push` 前都会被这道门拦住。
- 三个 Node 版本覆盖了「云函数运行时 18.15」到「最新 LTS」，跨版本语法差异（如较新的内置 API）能被提前发现。

本地想跑同样的检查：

```bash
node --check index.js
node --check selfhosted/server.js
```

---

## License

MIT
