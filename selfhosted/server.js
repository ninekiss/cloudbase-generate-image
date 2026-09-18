/**
 * server.js —— generateImage 的「自建服务器」版本
 *
 * 背景: 原 index.js 是 CloudBase 云函数 (exports.main + 网关 event 结构)。
 *       本文件把同一套核心逻辑搬到普通 Node HTTP 服务里, 可部署到任意
 *       云主机 / 容器 / 本地, 不再依赖云函数运行时。
 *
 * ★ 与云函数版的唯一实质差异: SDK 初始化必须显式传凭证。
 *   云函数里 TENCENTCLOUD_SECRETID/KEY 由运行时自动注入, 这里没有,
 *   所以要自己给 —— 见下面 initApp()。
 *
 * 运行:
 *   CLOUDBASE_ENV=YOUR_ENV_ID \
 *   TENCENTCLOUD_SECRETID=xxx TENCENTCLOUD_SECRETKEY=xxx \
 *   API_KEY=your-key PORT=3000 \
 *   node server.js
 *
 * 接口 (与云函数版完全一致, 客户端无需改动):
 *   POST /api/gen-image           普通 HTTP 文生图/图生图
 *   POST /api/gen-image?mcp=1     MCP JSON-RPC
 *   GET  /healthz                健康检查
 *
 * 零框架依赖: 只用 Node 内置 http 模块, 不需要 express。
 */

const http = require("http")
const cloudbase = require("@cloudbase/node-sdk")

// ====== 以下 5 处常量与云函数版完全一致, 未做任何改动 ======
const PROVIDER = "hunyuan-image"
const TXT2IMG_MODEL_3_0 = "HY-Image-3.0-Plus-4090-Tob-v1.0"
const TXT2IMG_MODEL_LEGACY = "hunyuan-image"
const TXT2IMG_MODEL = process.env.DEFAULT_MODEL || TXT2IMG_MODEL_3_0
const IMG2IMG_MODEL = "HY-Image-v3.0-I2I-ToB-v1.0.1"
const ALLOWED_SIZES = ["1024x1024", "1280x720", "720x1280", "1280x1280"]
const MAX_PROMPT_3_0 = 8192
const MAX_PROMPT = 500
const FOOTNOTE_MAX = 16

const API_KEY = (process.env.API_KEY || "").trim()

// ====== ★ 关键差异: 显式凭证初始化 ======
// 官方文档 (node-sdk 初始化页) 明确支持在任意 Node 进程里这样初始化:
//   init({ env, accessKey })                              —— 服务端 API Key, 推荐
//   init({ env, secretId, secretKey })                    —— 腾讯云密钥对(长期密钥), 管理员角色
//   init({ env, secretId, secretKey, sessionToken })      —— 临时密钥, 必须带 sessionToken!
// 不传凭证时会去读环境变量 TENCENTCLOUD_SECRETID/KEY —— 自建环境里通常没有,
// 于是报 "getCredential failed / secretId or secretKey not found"。
//
// ★ 2026-09-18 实测踩坑: 临时密钥(从 STS 换来的)如果**只传 secretId/secretKey、
//   漏传 sessionToken**, 请求会返回 **HTTP 401 Request failed with status code 401**。
//   临时密钥必须三者齐全。长期密钥(控制台 CAM 生成的那种)才不需要 sessionToken。
let _app = null
function getApp() {
  if (_app) return _app
  const env = process.env.CLOUDBASE_ENV || process.env.TCB_ENV
  if (!env) throw new Error("缺少 CLOUDBASE_ENV 环境变量 (云开发环境 ID)")

  const opts = { env, timeout: 60000 }
  if (process.env.CLOUDBASE_APIKEY) {
    // 方式一(推荐): 服务端 API Key, 无需密钥对
    opts.accessKey = process.env.CLOUDBASE_APIKEY
  } else if (process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY) {
    opts.secretId = process.env.TENCENTCLOUD_SECRETID
    opts.secretKey = process.env.TENCENTCLOUD_SECRETKEY
    // ★ 临时密钥必须带 token, 否则 401
    const token = process.env.TENCENTCLOUD_SESSIONTOKEN || process.env.TENCENTCLOUD_TOKEN
    if (token) opts.sessionToken = token
  } else {
    throw new Error(
      "缺少凭证: 请配置 CLOUDBASE_APIKEY，或 TENCENTCLOUD_SECRETID + TENCENTCLOUD_SECRETKEY" +
      "（临时密钥还需 TENCENTCLOUD_SESSIONTOKEN）"
    )
  }
  _app = cloudbase.init(opts)
  return _app
}

// ====== 鉴权 (逻辑与云函数版一致, 只是 event 换成 req) ======
function extractProvidedKey(headers, query, body) {
  const h = headers || {}
  const lower = {}
  for (const k of Object.keys(h)) lower[String(k).toLowerCase()] = h[k]

  const fromHeader = lower["x-api-key"] || lower["api-key"]
  if (fromHeader) return String(fromHeader).trim()

  const auth = lower["authorization"]
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim()

  if (query && (query.api_key || query.apikey)) return String(query.api_key || query.apikey).trim()
  if (body && typeof body === "object" && (body.api_key || body.apikey)) {
    return String(body.api_key || body.apikey).trim()
  }
  return ""
}

// 协议层方法白名单 —— 不消耗后端额度, 一律放行 (判据与 mcpDispatch 共用)
const MCP_PROTOCOL_METHODS = new Set([
  "initialize", "ping", "tools/list", "logging/setLevel",
])
function isProtocolMethod(method) {
  if (typeof method !== "string") return false
  if (MCP_PROTOCOL_METHODS.has(method)) return true
  return (
    method.indexOf("notifications/") === 0 ||
    method.indexOf("resources/") === 0 ||
    method.indexOf("prompts/") === 0
  )
}
function isNotificationMethod(method) {
  return typeof method === "string" && method.indexOf("notifications/") === 0
}

// 返回 null = 通过; 否则返回 { code, message }
// 注意: 自建服务里「所有请求都来自 HTTP」, 不再有"直接调用函数"这条放行路径。
function checkAuth(headers, query, body, method, isMcpContent) {
  if (!API_KEY) {
    return {
      code: "server_misconfigured",
      message: "服务端未配置 API_KEY 环境变量，已拒绝所有访问。请先配置环境变量。",
    }
  }
  // 协议层方法 (握手/探活/能力协商) 放行
  if (isProtocolMethod(method)) return null
  // MCP 通道: 只有 tools/call 会消耗额度, 其余不校验, 由 dispatch 回 -32601。
  // ★ 必须用 isMcpContent 分开 —— 普通 HTTP 的 method 是 null,
  //   无条件放行会导致所有 HTTP 请求免鉴权。
  if (isMcpContent && method !== "tools/call") return null

  const provided = extractProvidedKey(headers, query, body)
  if (!provided) {
    return {
      code: "unauthorized",
      message: "缺少 API Key。请通过 header `x-api-key` 传入（也支持 `Authorization: Bearer <key>`、`?api_key=` 或 body 里的 `api_key`）。",
    }
  }
  if (provided !== API_KEY) return { code: "unauthorized", message: "API Key 无效。" }
  return null
}

// ====== 状态码映射 (与云函数版一致) ======
const ERROR_HTTP_STATUS = {
  invalid_param: 400,
  url_in_images_field: 422,
  download_failed: 422,
  server_misconfigured: 500,
}

// 云函数版是 httpify() 返回 {statusCode, body} 给网关;
// 这里直接算出状态码, 交给下面的 sendJson()。
function resolveStatus(result) {
  if (result && typeof result === "object" && typeof result.statusCode === "number") {
    return result.statusCode
  }
  const isBusinessError =
    result && typeof result === "object" && result.success === false && typeof result.code === "string"
  if (!isBusinessError) return 200
  return ERROR_HTTP_STATUS[result.code] || 400
}

// ====== sharp 压缩 (与云函数版逐字相同) ======
const REF_MAX_EDGE = 768
const REF_JPEG_QUALITY = 82
const REF_MAX_B64 = 120 * 1024

let _sharp = null
let _sharpTried = false
function getSharp() {
  if (_sharpTried) return _sharp
  _sharpTried = true
  try { _sharp = require("sharp") } catch (e) { _sharp = null }
  return _sharp
}

function b64Size(b64) {
  const len = b64.length
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0
  return Math.floor((len * 3) / 4) - pad
}

async function compressRefImage(b64) {
  const origBytes = b64Size(b64)
  if (b64.length <= REF_MAX_B64) {
    return { b64, info: { applied: false, reason: "below_threshold", origBytes, outBytes: origBytes } }
  }
  const sharp = getSharp()
  if (!sharp) {
    return { b64, info: { applied: false, reason: "sharp_unavailable", origBytes, outBytes: origBytes } }
  }
  try {
    const input = Buffer.from(b64, "base64")
    const meta = await sharp(input).metadata()
    const w = meta.width || 0
    const h = meta.height || 0
    if (!w || !h) {
      return { b64, info: { applied: false, reason: "unknown_dimensions", origBytes, outBytes: origBytes } }
    }
    const scale = Math.min(1, REF_MAX_EDGE / Math.max(w, h))
    let pipe = sharp(input).rotate()
    if (scale < 1) pipe = pipe.resize(Math.round(w * scale), Math.round(h * scale), { fit: "inside" })
    const out = await pipe.jpeg({ quality: REF_JPEG_QUALITY, mozjpeg: true }).toBuffer()
    if (out.length >= origBytes) {
      return { b64, info: { applied: false, reason: "no_gain", origBytes, outBytes: origBytes } }
    }
    return {
      b64: out.toString("base64"),
      info: {
        applied: true, reason: "compressed", origBytes, outBytes: out.length,
        from: w + "x" + h,
        to: Math.round(w * scale) + "x" + Math.round(h * scale),
      },
    }
  } catch (e) {
    return { b64, info: { applied: false, reason: "error: " + (e && e.message), origBytes, outBytes: origBytes } }
  }
}

async function fetchToBase64(url) {
  const https = require("https")
  const httpLib = require("http")
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : httpLib
    lib.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchToBase64(res.headers.location).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        const buf = []
        res.on("data", (c) => buf.push(c))
        res.on("end", () => reject(new Error("下载参考图失败 " + res.statusCode + ": " + Buffer.concat(buf).toString().slice(0, 200))))
        return
      }
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => resolve(Buffer.concat(chunks).toString("base64")))
    }).on("error", reject).on("timeout", () => reject(new Error("下载参考图超时")))
  })
}

function normalizeFootnote(v) {
  if (v === undefined || v === null) return null
  if (typeof v !== "string") return null
  return v.slice(0, FOOTNOTE_MAX)
}

function isBlankFootnote(v) {
  return typeof v === "string" && v.trim() === ""
}

function fail(code, message, extra) {
  return { success: false, code, message, ...(extra || {}) }
}

// ====== 核心生成逻辑 (与云函数版一致, 未改动业务行为) ======
async function doGenerate(input) {
  const prompt = (input.prompt || "").trim()
  if (!prompt) return fail("invalid_param", "缺少 prompt 参数")

  const app = getApp()
  const ai = app.ai()
  const size = ALLOWED_SIZES.includes(input.size) ? input.size : "1024x1024"
  const footnote = normalizeFootnote(input.footnote)

  const imgUrls = input.image_urls || input.url
  const imgB64 = input.images
  if (Array.isArray(imgB64) && imgB64.length > 0 &&
      typeof imgB64[0] === "string" && /^https?:\/\//i.test(imgB64[0].trim())) {
    return fail("url_in_images_field",
      "检测到 URL 传进了 images 字段。images 只接受 base64 字符串；" +
      "URL 请改用 image_urls:[url]（推荐: 请求体小、函数内自动压缩）。",
      { mode: "i2i" })
  }

  if ((Array.isArray(imgUrls) && imgUrls.length > 0) || (Array.isArray(imgB64) && imgB64.length > 0)) {
    let images = Array.isArray(imgB64) ? imgB64.slice() : []
    let compressInfo = null
    if (Array.isArray(imgUrls) && imgUrls.length > 0 && images.length === 0) {
      try {
        for (const u of imgUrls.slice(0, 1)) {
          images.push(await fetchToBase64(u))
        }
      } catch (e) {
        return fail("download_failed",
          "无法下载参考图(" + e.message + ")。请改用 images:[base64] 直接传图。",
          { mode: "i2i" })
      }
    }
    images = images.slice(0, 1)
    if (images.length > 0 && input.compress !== false) {
      const r = await compressRefImage(images[0])
      images[0] = r.b64
      compressInfo = r.info
    }
    const imageModel = ai.createImageModel(PROVIDER)
    const params = { model: IMG2IMG_MODEL, prompt, images, size }
    params.revise = input.revise || { value: true }
    if (footnote !== null) params.footnote = footnote
    if (input.seed != null) params.seed = input.seed
    try {
      const res = await imageModel.generateImage(params)
      const { data, error } = res
      if (error) return { success: false, mode: "i2i", compress: compressInfo, ...error }
      const img = data?.[0] || {}
      const { url, ...rest } = img
      return { ...rest, imageUrl: url || "", success: true, mode: "i2i", model: IMG2IMG_MODEL,
        footnote: footnote, noWatermark: isBlankFootnote(footnote) || null, compress: compressInfo }
    } catch (e) {
      return { success: false, mode: "i2i", compress: compressInfo, errMsg: e && e.message, errStack: e && e.stack }
    }
  }

  const model = input.model || TXT2IMG_MODEL
  const maxPrompt = model === TXT2IMG_MODEL_LEGACY ? MAX_PROMPT : MAX_PROMPT_3_0
  if (prompt.length > maxPrompt) {
    return fail("invalid_param", `prompt 最多 ${maxPrompt} 字符（模型 ${model}）`)
  }

  const imageModel = ai.createImageModel(PROVIDER)
  const genParams = { model, prompt, size, revise: input.revise || { value: false } }
  if (footnote !== null) genParams.footnote = footnote
  if (input.seed != null) genParams.seed = input.seed

  try {
    const res = await imageModel.generateImage(genParams)
    const { data, error } = res
    if (error) return { success: false, mode: "t2i", ...error }
    const img = data?.[0] || {}
    const { url, ...rest } = img
    return { ...rest, imageUrl: url || "", success: true, mode: "t2i", model,
      footnote: footnote, noWatermark: isBlankFootnote(footnote) || null }
  } catch (e) {
    return { success: false, mode: "t2i", errMsg: e && e.message, errStack: e && e.stack }
  }
}

// ====== MCP (与云函数版一致) ======
const MCP_TOOLS = [
  {
    name: "generate_image",
    description:
      "生成图片。传 prompt 走文生图；传 images 或 image_urls 走图生图（基于参考图改风格/改内容），" +
      "参考图只支持 1 张，会自动压缩到 768px JPEG。" +
      "返回 imageUrl（24 小时有效，需及时落盘）。" +
      "水印：默认右下角「AI生成」；传 footnote 自定义文字（≤16 字符）；传空白空格可让水印不可见（无水印）。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "图片描述文本。文生图时建议 20~200 字，写清主体/风格/构图/光线。hunyuan-image 最多 500 字符" },
        images: {
          type: "array", items: { type: "string" },
          description: "图生图参考图，base64 数组（不含 data:image/...;base64, 前缀），最多 1 张。超过 120KB 自动压缩。⚠️ 只接受 base64；URL 请用 image_urls",
        },
        image_urls: {
          type: "array", items: { type: "string" },
          description: "图生图参考图 URL（与 images 二选一，images 优先）。请求体小、函数内自动压缩。腾讯云 COS 签名 URL 可正常下载；外部域名可能失败",
        },
        size: { type: "string", enum: ["1024x1024", "1280x720", "720x1280", "1280x1280"], description: "输出尺寸，默认 1024x1024" },
        footnote: { type: "string", description: "右下角水印文字，最多 16 字符。不传则为默认「AI生成」；★ 传空白（单个空格）可让水印不可见" },
        seed: { type: "number", description: "随机种子 [1, 4294967295]。固定同一 seed + 同一 prompt 可复现相同结果" },
        compress: { type: "boolean", description: "是否自动压缩参考图，默认 true" },
        revise: { type: "object", description: "{ value: boolean } 是否开启 prompt 改写。文生图默认关闭；图生图默认开启" },
        model: {
          type: "string",
          description: "仅文生图有效。默认 HY-Image-3.0-Plus-4090-Tob-v1.0（prompt 上限 8192）；传 hunyuan-image 切回旧模型（更快，上限 500）",
        },
      },
      required: ["prompt"],
    },
  },
]

async function mcpDispatch(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "generateImage-mcp", version: "2.1.0-selfhosted" },
      }
    case "tools/list":
      return { tools: MCP_TOOLS }
    case "tools/call": {
      const name = params && params.name
      const args = (params && params.arguments) || {}
      if (name === "generate_image") {
        return { content: [{ type: "text", text: JSON.stringify(await doGenerate(args)) }] }
      }
      return { content: [{ type: "text", text: "unknown tool: " + name }], isError: true }
    }
    case "ping":
      return {} // ping 是请求(有 id), 正常回空对象
    case "logging/setLevel":
      return {}
    default:
      // ★ 通知(notifications/*)按 JSON-RPC 规范**不应有响应**。
      //   之前落到 default 返回 {isError:true} + "unsupported method" ——
      //   虽然在鉴权层已放行(不会 401), 但语义是错的: 通知的答复本该被忽略。
      //   返回哨兵值, 由 HTTP 层转成 202 空响应。
      if (isNotificationMethod(method)) return MCP_NO_CONTENT
      // 其余未知/未实现方法: 按 JSON-RPC 规范回标准错误 -32601
      // (而不是塞进 content 当"工具错误")
      return { __jsonrpcError: { code: -32601, message: "Method not found: " + method } }
  }
}

// 哨兵: 表示"这是通知, 不需要响应体"
const MCP_NO_CONTENT = Symbol("mcp-no-content")

// ====== HTTP 层 (替换云函数 event 解析与网关返回协议) ======
function sendJson(res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...(extraHeaders || {}),
  })
  res.end(body)
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (c) => {
      size += c.length
      // 自建服务没有网关的 230KB 限制, 但给个上限避免被大包打爆
      if (size > limitBytes) {
        reject(new Error("请求体过大"))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      if (!raw) return resolve({ raw: null, parsed: null })
      try { resolve({ raw, parsed: JSON.parse(raw) }) }
      catch (e) { resolve({ raw, parsed: null }) }
    })
    req.on("error", reject)
  })
}

const MAX_BODY = 8 * 1024 * 1024 // 8MB, 自建服务可以放宽很多

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost")
    const query = Object.fromEntries(url.searchParams.entries())

    if (url.pathname === "/healthz") {
      let aiOk = false
      let aiErr = null
      try { getApp().ai(); aiOk = true } catch (e) { aiErr = e.message }
      return sendJson(res, aiOk ? 200 : 500, {
        ok: aiOk, version: "2.1.0-selfhosted", env: process.env.CLOUDBASE_ENV || null,
        authConfigured: !!API_KEY, error: aiErr,
      })
    }

    if (url.pathname !== "/api/gen-image") {
      return sendJson(res, 404, { success: false, code: "not_found", message: "未知路径: " + url.pathname })
    }
    if (req.method !== "POST") {
      return sendJson(res, 405, { success: false, code: "method_not_allowed", message: "请用 POST" })
    }

    const { parsed } = await readBody(req, MAX_BODY)

    // MCP 模式: ?mcp=1 或 header x-mcp: 1
    const isMcp = query.mcp === "1" ||
      String(req.headers["x-mcp"] || "") === "1"

    if (isMcp) {
      const rpc = parsed && typeof parsed === "object" ? parsed : {}
      const deny = checkAuth(req.headers, query, parsed, rpc.method, true)
      if (deny) {
        return sendJson(res, 200, {
          jsonrpc: "2.0", id: rpc.id != null ? rpc.id : null,
          error: { code: -32001, message: deny.message },
        })
      }
      const result = await mcpDispatch(rpc.method, rpc.params || {})
      // 通知没有响应体: 按 Streamable HTTP 规范回 202 Accepted + 空 body
      if (result === MCP_NO_CONTENT) {
        res.writeHead(202, { "Content-Length": 0 })
        return res.end()
      }
      if (result && typeof result === "object" && result.__jsonrpcError) {
        return sendJson(res, 200, { jsonrpc: "2.0", id: rpc.id != null ? rpc.id : null, error: result.__jsonrpcError })
      }
      return sendJson(res, 200, { jsonrpc: "2.0", id: rpc.id != null ? rpc.id : null, result })
    }

    // 普通 HTTP
    const deny = checkAuth(req.headers, query, parsed, null, false)
    if (deny) {
      return sendJson(res, 401, { success: false, code: "unauthorized", message: deny.message },
        { "WWW-Authenticate": 'Bearer realm="generateImage"' })
    }

    const input = { ...query, ...(parsed && typeof parsed === "object" ? parsed : {}) }
    const result = await doGenerate(input)
    return sendJson(res, resolveStatus(result), result)
  } catch (e) {
    return sendJson(res, 500, {
      success: false, code: "internal_error",
      message: e && e.message, stack: e && e.stack,
    })
  }
})

const PORT = Number(process.env.PORT || 3000)
server.listen(PORT, () => {
  console.log(`generateImage (self-hosted) listening on :${PORT}`)
  console.log(`  POST http://localhost:${PORT}/api/gen-image`)
  console.log(`  POST http://localhost:${PORT}/api/gen-image?mcp=1   (MCP)`)
  console.log(`  GET  http://localhost:${PORT}/healthz`)
  if (!API_KEY) console.warn("⚠️  未配置 API_KEY, 所有请求都会被拒 (fail-closed)")
})

module.exports = { server, doGenerate, checkAuth, resolveStatus }
