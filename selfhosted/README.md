# 这个函数能脱离云函数跑吗？

**能。** 2026-09-18 已在本地 Node 进程实测通过（真实出图，4.5s），见下方[验证结果](#验证结果)。

---

## 一、依赖盘点：哪些跟云函数绑定

把 `index.js` 拆开看，只有 **4 处**跟宿主环境有关，其余全是标准 Node。

| 位置 | 绑定了什么 | 自建时要改 |
|---|---|---|
| `cloudbase.init()` | 云函数运行时**自动注入** `TENCENTCLOUD_SECRETID/KEY` | ⚠️ **唯一实质改动**：显式传凭证 |
| `exports.main(event, context)` | 云函数的入口签名 | 改成 HTTP handler |
| `event.body` / `event.headers` / `event.queryStringParameters` | API 网关的事件结构 | 改成 `req.body` / `req.headers` |
| 返回 `{statusCode, headers, body}` | 网关的状态码透传协议 | 改成 `res.status().end()` |
| `process.env.TCB_ENV` / `SCF_NAMESPACE` | 云函数环境变量 | 换成自己的配置 |

**完全不用动的部分**（占代码 80%+）：

- `ai.createImageModel(PROVIDER)` 及全部模型调用逻辑
- `compressRefImage()` / `getSharp()` —— `sharp` 是标准 npm 包
- `fetchToBase64()` —— Node 内置 `https`/`http`
- `checkAuth()` / `extractProvidedKey()` —— 纯字符串处理
- `normalizeFootnote()` / `isFootnote` / `b64Size` / `fail()`
- `MCP_TOOLS` / `mcpDispatch()` —— MCP 协议实现
- 业务参数校验、状态码映射表

---

## 二、关键点：凭证怎么来

云函数里 SDK 从运行时环境变量自动读凭证，自建环境没有，**必须显式传**。官方文档（node-sdk 初始化页）支持三种方式：

```js
// 方式一（推荐）：服务端 API Key
cloudbase.init({ env: "your-env-id", accessKey: process.env.CLOUDBASE_APIKEY })

// 方式二：腾讯云密钥对（控制台 CAM 生成的长期密钥）
cloudbase.init({ env: "your-env-id", secretId: "...", secretKey: "..." })

// 方式三：临时密钥 —— ★ 必须三个都传
cloudbase.init({ env: "your-env-id", secretId: "...", secretKey: "...", sessionToken: "..." })
```

### ★ 实测踩坑：临时密钥漏传 sessionToken 会 401

从 STS 换来的临时密钥只传 `secretId` + `secretKey`、漏掉 `sessionToken`：

```
Request failed with status code 401
  at AIRequestAdapter.fetch (node-sdk/dist/ai/request-adapter.js:118)
```

补上 `sessionToken` 后立刻成功出图。**长期密钥（CAM 控制台生成）不需要 token，临时密钥必须带。**

另外注意：不传任何凭证时 SDK 会去读环境变量 `TENCENTCLOUD_SECRETID/KEY`，读不到报的是
`getCredential failed` / `secretId or secretKey not found` —— 跟 401 是两回事，别混淆。

---

## 三、怎么跑

### 本地

```bash
cd selfhosted
npm install

CLOUDBASE_ENV=YOUR_ENV_ID \
TENCENTCLOUD_SECRETID=xxx \
TENCENTCLOUD_SECRETKEY=xxx \
API_KEY=your-api-key \
PORT=3000 \
node server.js
```

### Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
```

```bash
docker build -t generate-image .
docker run -p 3000:3000 \
  -e CLOUDBASE_ENV=YOUR_ENV_ID \
  -e TENCENTCLOUD_SECRETID=xxx \
  -e TENCENTCLOUD_SECRETKEY=xxx \
  -e API_KEY=your-api-key \
  generate-image
```

> **`sharp` 在 alpine 上要装 `vips-dev`**，或直接用 `node:22-slim`（官方预编译二进制开箱可用，最省事）。
> 装不上 `sharp` 也不会崩 —— 代码里有降级：`compress.reason` 会返回 `sharp_unavailable`，图原样透传。

### 接口

和云函数版**完全一致**，客户端不用改：

```
POST /api/gen-image          普通 HTTP 文生图 / 图生图
POST /api/gen-image?mcp=1    MCP JSON-RPC
GET  /healthz               健康检查（含凭证是否配好）
```

---

## 四、自建版的好处（顺手解锁的限制）

| 项 | 云函数版 | 自建版 |
|---|---|---|
| 请求体上限 | **≈230KB**（网关硬限制，base64 参考图容易 413） | 默认给了 **8MB**（`MAX_BODY`，可调） |
| 并发 | **上游混元并发=1**（这个改不了，是模型侧限制） | 同上，仍受上游限制 |
| 超时 | 云函数超时上限 | 自己定，出图 5~15s 从容 |
| 冷启动 | 有 | 常驻进程无冷启动 |
| 部署 | 上传代码包 / 镜像 | 任意容器平台 |
| 成本 | 按调用计费 | 按机器计费 |

**注意**：自建**不能**突破上游并发=1 的限制 —— 那是混元模型侧的限制，跟跑在哪无关。
真要并发得换裸 API（`SubmitHunyuanImageJob`）。

反过来，云函数版的好处是：免运维、自动伸缩、按量计费、和 CloudBase 其他资源（数据库/存储）内网互通。

---

## 五、两版差异清单（就这些）

| # | 差异 | 说明 |
|---|---|---|
| 1 | **凭证显式传入** | 见第二节，唯一真正的功能性改动 |
| 2 | **"直接调用函数"放行路径去掉** | 云函数版 `checkAuth` 里有 `if (!isHttp) return null`（管理端 API / 定时触发无 headers 故放行）；自建版所有请求都走 HTTP，这条分支无意义，已移除 |
| 3 | **请求体上限** 230KB → 8MB | 自建无网关限制，放宽更实用 |
| 4 | **`notifications/*` 返回 202 空体** | 见下方"顺带修的" |
| 5 | **多了 `/healthz`** | 便于容器健康检查 / K8s liveness probe |

其余逻辑（默认模型、prompt 上限、尺寸白名单、水印三态、状态码映射、参考图压缩阈值）**逐字相同**。

### 顺带修的：`notifications/*` 语义

自建版测试时发现，云函数版把 `notifications/initialized` 落到 `default` 分支，返回：

```json
{"jsonrpc":"2.0","id":null,"result":{"content":[{"type":"text","text":"unsupported method: notifications/initialized"}],"isError":true}}
```

虽然鉴权层已放行（不会再 401 了），但**语义是错的** —— 按 JSON-RPC 规范，**通知（notification）不应有响应**。
自建版改成返回 **HTTP 202 + 空 body**。绝大多数客户端会忽略这个响应，所以不是致命问题，但改对了更规范。

---

## 六、验证结果

本地 Node 进程（非云函数运行时）跑 `server.js`，用真实凭证：

| # | 用例 | 期望 | 实测 |
|---|---|---|---|
| 1 | `GET /healthz` | 200, `ok:true` | ✅ 200 |
| 2 | MCP `initialize`（免 key） | 200 | ✅ 200 |
| 3 | **`notifications/initialized`** | **202 空体** | ✅ 202, `body=""` |
| 4 | MCP `tools/list`（免 key） | 200, 1 个工具 | ✅ 200, tools=1 |
| 5 | `tools/call` 无 key | `-32001` | ✅ 200 + `-32001` |
| 6 | 缺 prompt | **400** | ✅ 400 `invalid_param` |
| 7 | **真实出图** | 200 + imageUrl | ✅ **200, 4.5s, success=true, noWatermark=true** |

出图返回的 URL 形如：

```
https://hunyuan-image-result-tob-1258344703.cos.ap-guangzhou.myqcloud.com/text2image2/strategy/metadata/...png?q-sign-algorithm=sha1&...
```

**结论：代码不只能在云函数跑。** 唯一需要处理的是凭证传入，其余是纯粹的宿主适配。

---

## 七、选哪个？

- **想省事、要免运维、已在用 CloudBase** → 留在云函数。它的自动伸缩/按量计费/内网互通是真优势。
- **要传大图（>230KB base64）、要常驻无冷启动、要部署到自有 K8s/容器** → 用自建版。
- **两者可以并存**：同一份核心逻辑，云函数收轻量请求，自建版收大图请求。客户端按 URL 切换即可。

---

## 八、环境变量速查

| 变量 | 必填 | 说明 |
|---|---|---|
| `CLOUDBASE_ENV` | ✅ | 云开发环境 ID，如 `YOUR_ENV_ID` |
| `CLOUDBASE_APIKEY` | 三选一 | 服务端 API Key（最推荐） |
| `TENCENTCLOUD_SECRETID` | 三选一 | 腾讯云 secretId |
| `TENCENTCLOUD_SECRETKEY` | 三选一 | 腾讯云 secretKey |
| `TENCENTCLOUD_SESSIONTOKEN` | 临时密钥必填 | 临时密钥的 token，**漏了会 401** |
| `API_KEY` | ✅ | 对外鉴权 key（fail-closed：不配则拒绝所有请求） |
| `DEFAULT_MODEL` | ❌ | 覆盖默认文生图模型 |
| `PORT` | ❌ | 默认 3000 |
