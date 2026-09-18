const cloudbase = require("@cloudbase/node-sdk")

/**
 * CloudBase AI 图像生成云函数 (同时是 MCP Server)
 *
 * 文生图 (T2I): prompt -> 默认 HY-Image-3.0-Plus-4090-Tob-v1.0（可切回 hunyuan-image）
 * 图生图 (I2I): prompt + images/image_urls -> HY-Image-v3.0-I2I-ToB-v1.0.1
 *
 * ★ provider 与 model 是两个概念, 别混 (2026-09-18 曾因此 404):
 *   - PROVIDER 恒为 "hunyuan-image", 是渠道标识, 会被拼进请求 URL;
 *     传给 createImageModel() 的**必须**是它。
 *   - 模型名放请求体 params.model, 由服务端判定。
 *   默认模型: HY-Image-3.0-Plus-4090-Tob-v1.0 (prompt 上限 8192);
 *   传 model="hunyuan-image" 显式切回老模型 (更快, prompt 上限 500)。
 *   也可用环境变量 DEFAULT_MODEL 覆盖默认值, 无需改代码。
 *
 * 入口:
 *  - 普通 HTTP: POST https://<env>.app.tcloudbase.com/api/gen-image
 *               ★ 路由路径是 /api/gen-image (不是 /api/generateImage!)
 *               body: {prompt, images?, image_urls?, size?, footnote?, seed?, compress?, revise?}
 *  - MCP:       带 ?mcp=1 或 header x-mcp:1, JSON-RPC tools/list + tools/call
 *               工具: generate_image
 *
 * HTTP 状态码约定 (v2.0.0 起统一透传):
 *   200 成功 | 400 参数错误 | 401 鉴权失败 | 422 参数语义不可用 | 500 服务端异常
 *   ★ 注意: 必须返回 {statusCode, headers, body} 网关才透传状态码;
 *     返回普通对象时网关一律回 200 (曾经参数错误也回 200, 调用方会误判成功)。
 *
 * 鉴权 (v1.8.0, fail-closed):
 *  HTTP 访问必须携带与环境变量 API_KEY **完全一致**的 key, 否则拒绝。
 *  取 key 顺序: header x-api-key > header Authorization: Bearer <key>
 *              > query ?api_key= > body api_key
 *  - ★ 未配置 API_KEY 环境变量 -> **拒绝所有 HTTP 访问**(不是放行),
 *    避免"忘了配环境变量"导致裸奔。
 *  - 唯一例外: 直接调用函数(invokeFunction / 管理端 API / 定时触发)
 *    不经 HTTP 网关, 不受此校验影响。
 *  - MCP 里**只有 tools/call 校验**(真正消耗混元额度), 其余一律放行:
 *      * 协议层: initialize / ping / tools/list / notifications/* / resources/* / prompts/*
 *        (客户端握手/探活/能力协商必需; 拒了会让客户端判定服务端异常)
 *      * 未知方法也放行 -> 由 mcpDispatch 回标准 -32601, 不返回 -32001。
 *        ★ 否则拼错方法名会报"鉴权失败", 排查方向被带偏。
 *    ★ 2026-09-18 踩坑: 最初只放行 initialize / tools/list, 漏了 notifications/*。
 *      而 `notifications/initialized` 是 MCP 握手的**必需通知**(客户端握完手必发),
 *      被拒会导致标准客户端判定握手失败、直接连不上。
 *      ★ 判据是"这个方法是否消耗我的后端额度", 不是"我有没有实现它"。
 *
 * 为什么不用平台侧的权限控制(2026-09-18 查官方文档确认):
 *  - 网关 enableAuth: 全局开关, 会连带拦 /api/hello 与静态托管;
 *    校验的是 CloudBase 身份 token, 不是固定密钥。
 *  - 云函数「安全规则」: **仅对客户端 SDK 调用(callFunction) 生效**,
 *    对 HTTP 网关访问无效; 且规则值只有 true/false/"auth != null" 等,
 *    只能判"是否登录", 不支持比对固定密钥。官方文档明确:
 *    「如需更精细的权限控制, 请在云函数内部实现业务逻辑验证」——即本实现。
 *
 * 参考图自动压缩: 超过 120KB 的 base64 参考图会被自动压到最长边 768px 的 JPEG,
 *   避免触发 HTTP 网关 ≈230KB 的请求体上限。压缩依赖 sharp, 不可用时降级为原样透传
 *   (返回体 compress.reason 会说明)。传 compress:false 可关闭。
 *
 * ⚠️ SDK 能力边界 (2026-09-18 三份官方材料交叉确认, 不要再试):
 *  CloudBase AI SDK 对 generateImage(params) 做白名单过滤, 未知字段一律静默丢弃(不报错)。
 *  - 文生图官方类型 HunyuanARGenerateImageInput 只有 6 个字段:
 *      model / prompt / size / seed / footnote / revise
 *  - 图生图 = 上述 6 个 + image_urls / images
 *  → 超分(Clarity)、多图(Num) 在 SDK 层无法实现;
 *    裸 API SubmitHunyuanImageJob 才有 LogoAdd / Clarity / Num, 但需 TC3 签名。
 *  → 水印: 无独立开关, 但 footnote 传空白即可让水印不可见 (见下)。
 *
 * 水印: 默认右下角「AI生成」。
 *   - footnote 传自定义文字(<=16 字符) -> 替换为自定义水印
 *   - footnote 传空白(单个空格 " ")    -> ★ 水印不可见, 即事实上的无水印 (实测确认)
 *   - 不传 footnote                    -> 默认「AI生成」
 *   (SDK 无独立的"关水印"开关, 这是绕过它的可行办法)
 */

// ★ 注意: 下面两个概念必须严格区分, 千万别混!
//   - PROVIDER: AI 渠道/供应商标识, 恒为 "hunyuan-image", 会被拼进请求 URL
//               (`${baseUrl}/${PROVIDER}/${subUrl}`)。**永远不要改成模型名**。
//   - 模型名(model): 放在请求体 `model` 字段里, 由服务端判定。
//     (2026-09-18 教训: 曾把模型名当 provider 传 -> URL 多一层路径 -> 404)
const PROVIDER = "hunyuan-image"
// 默认文生图模型: 3.0 Plus(画质更好, prompt 上限 8192)
const TXT2IMG_MODEL_3_0 = "HY-Image-3.0-Plus-4090-Tob-v1.0"
// 老模型: 更快/更省, 但 prompt 只有 500 字符。传 model="hunyuan-image" 可显式切回
const TXT2IMG_MODEL_LEGACY = "hunyuan-image"
// 当前默认值 (可用环境变量 DEFAULT_MODEL 覆盖, 无需改代码)
const TXT2IMG_MODEL = process.env.DEFAULT_MODEL || TXT2IMG_MODEL_3_0
const IMG2IMG_MODEL = "HY-Image-v3.0-I2I-ToB-v1.0.1"
const ALLOWED_SIZES = ["1024x1024", "1280x720", "720x1280", "1280x1280"]
// prompt 上限按模型区分: 3.0 支持 8192, 老 hunyuan-image 只有 500
const MAX_PROMPT_3_0 = 8192
const MAX_PROMPT = 500
const FOOTNOTE_MAX = 16

// ==== API Key 鉴权 ======================================================
// 设计取舍:
//  - 校验做在函数内(而非网关 enableAuth / 安全规则), 因为:
//      * 网关 enableAuth 是全局开关, 会连带影响 /api/hello、静态托管等所有路由;
//        且它校验的是 CloudBase 身份 token, 不是"一串长期不变的 key"这种语义。
//      * 云函数"安全规则"**仅对客户端 SDK 调用(callFunction) 生效**,
//        对 HTTP 网关访问无效, 也只会判"是否登录", 不支持比对固定密钥。
//        (官方文档亦明确: 更精细的权限控制请在云函数内部实现)
//  - ★ fail-closed: 环境变量 API_KEY 必须配置, 且请求方必须与其**完全一致**,
//    否则一律拒绝。未配置 API_KEY 时**不是放行, 而是全部拒绝** ——
//    这样不会因为"忘了配环境变量"而意外裸奔。
//  - 唯一例外: 直接调用函数(invokeFunction / 管理端 API / 定时触发)
//    不走 HTTP 网关, 天然拿不到 headers, 也无需校验(见 checkAuth 的 event 判定)。
const API_KEY = (process.env.API_KEY || "").trim()

// 从 event 里按优先级取调用方提供的 key
function extractProvidedKey(event, query, body) {
  const h = (event && event.headers) || {}
  // header 名大小写不固定, 做一次遍历归一化
  let lower = {}
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

// 返回 null = 通过; 否则返回 { code, message } 表示拒绝原因
// isMcpContent: 是否 MCP 通道请求。★ 必须显式传入 —— 普通 HTTP 调用时 method
//   是 null, 不能靠 method 是否为空来判断"这是不是 MCP 请求"。
function checkAuth(event, query, body, method, isMcpContent) {
  // 直接调用函数(管理端 API / invokeFunction / 定时触发)放行:
  // 这类调用不经过 HTTP 网关, event 里没有 httpMethod / headers 结构。
  // 网关转发的 HTTP 请求一定带 headers(httpMethod 存在时更确定)。
  const isHttp = !!(event && (event.httpMethod || event.headers || event.requestContext))
  if (!isHttp) return null

  // fail-closed: 没配环境变量 -> 拒绝(而不是放行)
  if (!API_KEY) {
    return {
      code: "server_misconfigured",
      message: "服务端未配置 API_KEY 环境变量，已拒绝所有 HTTP 访问。请先配置环境变量。",
    }
  }

  // ★ MCP 协议层方法一律放行 —— 只做协议协商/探活/能力协商, 不消耗混元额度。
  //   2026-09-18 踩坑: 最初只放行了 initialize / tools/list, 漏了 notifications/*。
  //   而 `notifications/initialized` 是 MCP 握手的**必需通知**(客户端握完手必发),
  //   它没有 id(通知不是请求), 一旦被拒 -> 标准客户端认为握手失败, 直接连不上。
  //   ★ 判据是"这个方法是否消耗我的后端额度", 不是"我有没有实现它":
  //     - ping: 客户端探活必发, 我们不实现也不能拦, 拦了客户端判定服务端异常;
  //     - resources/*、prompts/*: 本 Server 只提供 tools, 客户端可能在握手后试探,
  //       拦掉会让它以为鉴权失败。这些方法一律放行, 由 mcpDispatch 回规范的 -32601。
  //   —— 判据与 mcpDispatch 共用 isProtocolMethod(), 避免两处不一致。
  if (isProtocolMethod(method)) return null

  //   ★ 只有真正会消耗后端额度的方法才校验 key。
  //   本 Server 只暴露一个会花钱的方法: tools/call。
  //   其余(包括拼错的、不存在的)一概不校验 —— 由 mcpDispatch 回标准的
  //   -32601 Method not found。
  //   为什么这样做: 若先校验 key, 一个拼错的 method 会返回 -32001(鉴权错误),
  //   客户端会误以为"key 不对"而去折腾凭证, 实际问题在方法名。
  //   ★ 必须用 isMcpContent 与普通 HTTP 分开 —— 普通 HTTP 调用时 method 为 null,
  //     若在这里无条件 return null 会导致**所有 HTTP 请求免鉴权**
  //     (2026-09-18 实测踩到, 单测"无 key -> 401"立刻抓出)。
  if (isMcpContent && method !== "tools/call") return null

  const provided = extractProvidedKey(event, query, body)
  if (!provided) {
    return {
      code: "unauthorized",
      message: "缺少 API Key。请通过 header `x-api-key` 传入（也支持 `Authorization: Bearer <key>`、`?api_key=` 或 body 里的 `api_key`）。",
    }
  }
  if (provided !== API_KEY) {
    return { code: "unauthorized", message: "API Key 无效。" }
  }
  return null
}

// CloudBase HTTP 网关靠这几个字段决定真正的 HTTP 状态码:
// 只返回普通对象 -> 网关一律 200 (业务错误码藏在 body 里, 调用方容易误判成功)。
// 必须返回 { isBase64Encoded, statusCode, headers, body } 才会透传状态码。
//
// ★ 2026-09-18 补坑: 最初只给"鉴权失败"做了透传, 业务错误(如 prompt 超长)仍是
//   普通对象 -> 一律 HTTP 200, 调用方按状态码判断会误判成功。现统一走 jsonResponse。
function jsonResponse(statusCode, payload, extraHeaders) {
  return {
    isBase64Encoded: false,
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(extraHeaders || {}) },
    body: JSON.stringify(payload),
  }
}

function unauthorizedResponse(msg) {
  return jsonResponse(
    401,
    { success: false, code: "unauthorized", message: msg },
    { "WWW-Authenticate": 'Bearer realm="generateImage"' }
  )
}

// 业务错误码 -> HTTP 状态码映射
//   400 调用方参数问题(可自行修复)
//   401 鉴权失败
//   422 参数语法正确但语义不可用(如参考图 URL 下不动、URL 传进了 images 字段)
//   500 服务端/上游异常(调用方重试可能有用)
const ERROR_HTTP_STATUS = {
  invalid_param: 400,
  url_in_images_field: 422,
  download_failed: 422,
  server_misconfigured: 500,
}

// 已带 statusCode 的一律原样返回(避免二次包装, 也避免把上游错误再套一层 body)
function httpify(result) {
  if (result && typeof result === "object" && typeof result.statusCode === "number") {
    return result
  }
  // 成功: 200 直接返回原始业务对象 (保持 body 结构与旧版一致, 不额外包裹)
  const isBusinessError =
    result && typeof result === "object" && result.success === false && typeof result.code === "string"
  if (!isBusinessError) return result
  return jsonResponse(ERROR_HTTP_STATUS[result.code] || 400, result)
}
// ======================================================================

async function getApp() {
  const envId = process.env.TCB_ENV || process.env.SCF_NAMESPACE || cloudbase.SYMBOL_CURRENT_ENV
  return cloudbase.init({ env: envId })
}

// ==== 参考图自动压缩 ====================================================
// 背景: CloudBase HTTP 网关对请求体有 ≈230KB 上限, 原图 base64 会 413。
// 同时 I2I 模型侧对垫图也有体积要求, 传压缩图既省带宽也更快。
// 策略: 优先用 sharp 真正压到 JPEG; 若 sharp 不可用则降级为「仅检测+原样透传」,
//       并在返回值里带 compress 字段告知调用方实际发生了什么。
const REF_MAX_EDGE = 768          // 最长边像素
const REF_JPEG_QUALITY = 82       // JPEG 质量
const REF_MAX_B64 = 120 * 1024    // base64 超过 120KB 就压 (网关 230KB 的一半, 留余量)

let _sharp = null
let _sharpTried = false
function getSharp() {
  if (_sharpTried) return _sharp
  _sharpTried = true
  try {
    _sharp = require("sharp")
  } catch (e) {
    _sharp = null
  }
  return _sharp
}

function b64Size(b64) {
  // base64 长度换算成原始字节数 (含 padding)
  const len = b64.length
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0
  return Math.floor((len * 3) / 4) - pad
}

// 返回 { b64, info } ; info 描述压缩动作, 失败时 b64 原样返回
async function compressRefImage(b64) {
  const origBytes = b64Size(b64)
  const needBySize = b64.length > REF_MAX_B64
  if (!needBySize) {
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
    let pipe = sharp(input).rotate() // rotate() 无参 = 依 EXIF 自动摆正
    if (scale < 1) {
      pipe = pipe.resize(Math.round(w * scale), Math.round(h * scale), { fit: "inside" })
    }
    const out = await pipe.jpeg({ quality: REF_JPEG_QUALITY, mozjpeg: true }).toBuffer()
    // 压完反而更大(例如原本就是小体积高压缩图)时, 保留原图
    if (out.length >= origBytes) {
      return { b64, info: { applied: false, reason: "no_gain", origBytes, outBytes: origBytes } }
    }
    return {
      b64: out.toString("base64"),
      info: {
        applied: true,
        reason: "compressed",
        origBytes,
        outBytes: out.length,
        from: w + "x" + h,
        to: Math.round(w * scale) + "x" + Math.round(h * scale),
      },
    }
  } catch (e) {
    return { b64, info: { applied: false, reason: "error: " + (e && e.message), origBytes, outBytes: origBytes } }
  }
}
// ======================================================================

async function fetchToBase64(url) {
  // 函数内把参考图 URL 下载成 base64 (I2I 端点只认 images[base64], image_urls 会被 400)
  const https = require("https")
  const http = require("http")
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http
    lib.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchToBase64(res.headers.location).then(resolve, reject)
      }
      if (!res.statusCode || res.statusCode !== 200) {
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

// footnote: 自定义水印文字, 限 16 字符
// footnote: 自定义水印文字, 限 16 字符
// 返回 null  -> 不传该参数, 用服务端默认「AI生成」水印
// 返回 " "   -> ★ 传空白(空格/全空白) 可让水印不可见 = 事实上的无水印 (2026-09-18 实测确认)
// 返回 其他   -> 自定义水印文字
function normalizeFootnote(v) {
  if (v === undefined || v === null) return null
  if (typeof v !== "string") return null
  return v.slice(0, FOOTNOTE_MAX)
}

// 传空白字符串(纯空格等)时水印不可见 -> 用于返回值里明确标注
function isBlankFootnote(v) {
  return typeof v === "string" && v.trim() === ""
}

// 统一构造"业务失败"结果: 一律带 success:false + code, 由 httpify() 决定 HTTP 状态码。
// 这样即使新增错误分支, 也不会漏掉状态码透传。
function fail(code, message, extra) {
  return { success: false, code, message, ...(extra || {}) }
}

async function doGenerate(input) {
  const prompt = (input.prompt || "").trim()
  if (!prompt) return fail("invalid_param", "缺少 prompt 参数")

  const app = await getApp()
  const ai = app.ai()
  const size = ALLOWED_SIZES.includes(input.size) ? input.size : "1024x1024"
  const footnote = normalizeFootnote(input.footnote)

  // 图生图分支 (I2I)
  // 参考图两种传法:
  //   1) images: [base64]  —— 推荐。超阈值会自动压缩(见 compressRefImage)。
  //   2) image_urls: [url] —— 实测腾讯云 COS 签名 URL 在函数内网可正常拉取;
  //      外部域名可能失败(返回 download_failed)。
  const imgUrls = input.image_urls || input.url
  const imgB64 = input.images
  // 常见误用: 把 URL 传进 images(base64 字段)。模型会把它当 base64 解码成垃圾 -> 400。
  // 这里提前拦截并给出明确引导, 省去调用方排查时间。
  if (Array.isArray(imgB64) && imgB64.length > 0 &&
      typeof imgB64[0] === "string" && /^https?:\/\//i.test(imgB64[0].trim())) {
    return fail("url_in_images_field",
      "检测到 URL 传进了 images 字段。images 只接受 base64 字符串；" +
      "URL 请改用 image_urls:[url]（推荐: 请求体小、不受网关 230KB 限制、函数内自动压缩）。",
      { mode: "i2i" })
  }
  if ((Array.isArray(imgUrls) && imgUrls.length > 0) || (Array.isArray(imgB64) && imgB64.length > 0)) {
    let images = Array.isArray(imgB64) ? imgB64.slice() : []
    let compressInfo = null
    if (Array.isArray(imgUrls) && imgUrls.length > 0 && images.length === 0) {
      try {
        for (const u of imgUrls.slice(0, 1)) {
          const b64 = await fetchToBase64(u)
          images.push(b64)
        }
      } catch (e) {
        return fail("download_failed",
          "无法下载参考图(" + e.message + ")。请改用 images:[base64] 直接传图, 或先把图传到云存储。",
          { mode: "i2i" })
      }
    }
    images = images.slice(0, 1) // I2I 最多 1 张
    // 自动压缩参考图 (关掉可传 compress:false)
    if (images.length > 0 && input.compress !== false) {
      const r = await compressRefImage(images[0])
      images[0] = r.b64
      compressInfo = r.info
    }
    // ★ 同 T2I: provider 固定 "hunyuan-image"(渠道标识), 不要传 model 名。
    //   模型名放 params.model。详因见文生图分支的注释。
    const imageModel = ai.createImageModel(PROVIDER)
    const params = {
      model: IMG2IMG_MODEL,
      prompt,
      images,
      size,
    }
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
      return { success: false, mode: "i2i", compress: compressInfo,
        errMsg: e && e.message, errStack: e && e.stack }
    }
  }

  // 文生图分支
  // 优先级: 调用方传入 model > 环境变量 DEFAULT_MODEL > 默认 3.0
  // (注意: 这里读的是 DEFAULT_MODEL, 不是 PROVIDER —— 二者含义完全不同)
  const model = input.model || TXT2IMG_MODEL
  const maxPrompt = model === TXT2IMG_MODEL_LEGACY ? MAX_PROMPT : MAX_PROMPT_3_0
  if (prompt.length > maxPrompt) {
    return fail("invalid_param", `prompt 最多 ${maxPrompt} 字符（模型 ${model}）`)
  }

  // ★ 关键: createImageModel() 的第一个参数是 provider, 它会被拼进请求 URL:
  //     `${baseUrl}/${provider}/${subUrl}`
  //   所以必须固定传 "hunyuan-image"(这是渠道/供应商标识), 绝对不要传 model 名!
  //   若误传 model 名(如 "HY-Image-3.0-Plus-4090-Tob-v1.0"), URL 会变成
  //   `.../HY-Image-3.0-Plus-4090-Tob-v1.0/images/ar/generations` -> 404。
  //   真正的模型名放在 genParams.model 里(下面), 由服务端按请求体字段判定。
  //   (2026-09-18 实测: provider 写错 -> 404; 写对 -> 3.0 模型正常出图)
  const imageModel = ai.createImageModel(PROVIDER)
  const genParams = {
    model,
    prompt,
    size,
    revise: input.revise || { value: false },
  }
  if (footnote !== null) genParams.footnote = footnote
  if (input.seed != null) genParams.seed = input.seed

  // 与 I2I 分支保持一致: 上游(混元)会偶发抛异常(限流/超时抖动),
  // 若裸调用会直接崩成 HTTP 400 FUNCTIONS_INVOCATION_FAILED, 调用方拿不到可读信息。
  try {
    const res = await imageModel.generateImage(genParams)
    const { data, error } = res
    if (error) return { success: false, mode: "t2i", ...error }
    const img = data?.[0] || {}
    const { url, ...rest } = img
    return { ...rest, imageUrl: url || "", success: true, mode: "t2i", model,
      footnote: footnote, noWatermark: isBlankFootnote(footnote) || null }
  } catch (e) {
    return { success: false, mode: "t2i",
      errMsg: e && e.message, errStack: e && e.stack }
  }
}

// MCP 工具定义
const MCP_TOOLS = [
  {
    name: "generate_image",
    description:
      "生成图片。传 prompt 走文生图；传 images 或 image_urls 走图生图（基于参考图改风格/改内容），" +
      "参考图只支持 1 张，会自动压缩到 768px JPEG 以避免网关体积限制。" +
      "返回 imageUrl（24 小时有效，需及时落盘）。" +
      "水印：默认右下角「AI生成」；传 footnote 自定义文字（≤16 字符）；传空白空格可让水印不可见（无水印）。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "图片描述文本。文生图时建议 20~200 字，写清主体/风格/构图/光线。hunyuan-image 最多 500 字符",
        },
        images: {
          type: "array",
          items: { type: "string" },
          description:
            "图生图参考图，base64 数组（不含 data:image/...;base64, 前缀），最多 1 张。" +
            "体积超过 120KB 会自动压缩到最长边 768px 的 JPEG，无需调用方预处理。" +
            "⚠️ 只接受 base64；URL 请用 image_urls（传 URL 到这里会报 url_in_images_field）",
        },
        image_urls: {
          type: "array",
          items: { type: "string" },
          description:
            "图生图参考图 URL（与 images 二选一，images 优先）。推荐用法：请求体小、不受网关 230KB 限制、" +
            "函数内自动压缩。腾讯云 COS 签名 URL 可正常下载；外部域名可能失败，失败时请改用 images",
        },
        size: {
          type: "string",
          enum: ["1024x1024", "1280x720", "720x1280", "1280x1280"],
          description: "输出尺寸，默认 1024x1024。1280x720 横版 / 720x1280 竖版。图生图同样支持",
        },
        footnote: {
          type: "string",
          description:
            "右下角水印文字，最多 16 字符。不传则为默认「AI生成」；" +
            "★ 传空白（单个空格 \" \"）可让水印不可见，即事实上的无水印（返回体 noWatermark=true）",
        },
        seed: {
          type: "number",
          description: "随机种子 [1, 4294967295]。固定同一 seed + 同一 prompt 可复现相同结果",
        },
        compress: {
          type: "boolean",
          description: "是否自动压缩参考图，默认 true。仅当参考图本身已是小体积优化图时才需设为 false",
        },
        revise: {
          type: "object",
          description: "{ value: boolean } 是否开启 prompt 改写。文生图默认关闭；图生图默认开启（会显著增强风格迁移效果）",
        },
        model: {
          type: "string",
          description:
            "仅文生图有效。默认 HY-Image-3.0-Plus-4090-Tob-v1.0（prompt 上限 8192，画质更好）；" +
            "传 hunyuan-image 可显式切回旧模型（更快，但 prompt 上限 500）。" +
            "图生图模型固定为 HY-Image-v3.0-I2I-ToB-v1.0.1（无需传）",
        },
      },
      required: ["prompt"],
    },
  },
]

// 哨兵: 表示"这是通知, 不需要响应体"
const MCP_NO_CONTENT = Symbol("mcp-no-content")

// ★ 已知的"协议层方法"白名单 —— 这些方法由客户端自行调用, 服务端可以只做最小应答。
//   作用: 让 checkAuth 与 mcpDispatch 共用同一份判据, 避免两处不一致
//   (曾出现: 鉴权放行了某方法, 但 dispatch 不认识它 -> 返回 isError, 客户端看到矛盾信号)。
const MCP_PROTOCOL_METHODS = new Set([
  "initialize", "ping", "tools/list", "logging/setLevel",
])

function isProtocolMethod(method) {
  if (typeof method !== "string") return false
  if (MCP_PROTOCOL_METHODS.has(method)) return true
  // notifications/* 与 resources/*、prompts/*、completion/* 都是协议层, 不消耗额度
  return (
    method.indexOf("notifications/") === 0 ||
    method.indexOf("resources/") === 0 ||
    method.indexOf("prompts/") === 0
  )
}

function isNotificationMethod(method) {
  return typeof method === "string" && method.indexOf("notifications/") === 0
}

async function mcpDispatch(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "generateImage-mcp", version: "2.1.1" },
      }
    case "tools/list":
      return { tools: MCP_TOOLS }
    case "tools/call": {
      const name = params && params.name
      const args = (params && params.arguments) || {}
      if (name === "generate_image") {
        const r = await doGenerate(args)
        return { content: [{ type: "text", text: JSON.stringify(r) }] }
      }
      return { content: [{ type: "text", text: "unknown tool: " + name }], isError: true }
    }
    case "ping":
      return {} // ping 是请求(有 id), 正常回空对象
    case "logging/setLevel":
      return {} // 客户端设置日志级别, 接受即可
    default:
      // ★ 通知(notifications/*)按 JSON-RPC 规范**不应有响应**。
      //   之前落到 default 返回 {isError:true}+"unsupported method" —— 虽然鉴权层已放行
      //   (不会再被 401 拦), 但语义仍是错的: 通知的答复本该被忽略。
      if (isNotificationMethod(method)) return MCP_NO_CONTENT
      // 其他协议层方法(resources/*、prompts/*): 服务端未实现, 按规范返回
      // JSON-RPC 标准错误 -32601 Method not found, 而不是塞进 content 里当"工具错误"。
      if (typeof method === "string" &&
          (method.indexOf("resources/") === 0 || method.indexOf("prompts/") === 0)) {
        return { __jsonrpcError: { code: -32601, message: "Method not found: " + method } }
      }
      // 完全未知的方法: 同样按 JSON-RPC 规范回 -32601
      return { __jsonrpcError: { code: -32601, message: "Method not found: " + method } }
  }
}

exports.main = async (event, context) => {
  let input = event
  let isMcp = false
  let rawBody = event
  let query = {}
  let body = null
  if (event && typeof event.body !== "undefined") {
    try {
      rawBody = typeof event.body === "string" ? JSON.parse(event.body) : event.body
    } catch (e) {
      rawBody = {}
    }
    query = event.queryStringParameters || {}
    body = typeof rawBody === "object" ? rawBody : null
    input = { ...query, ...(body || {}) }
    isMcp = input.mcp === "1" || input.mcp === 1 ||
            (event.headers && (event.headers["x-mcp"] === "1" || event.headers["X-Mcp"] === "1"))
  }

  if (isMcp) {
    const rpc = rawBody && typeof rawBody === "object" ? rawBody : {}
    // MCP 握手放行, tools/call 才校验 (见 checkAuth)
    const deny = checkAuth(event, query, body, rpc.method, true)
    if (deny) {
      return { jsonrpc: "2.0", id: rpc.id != null ? rpc.id : null,
        error: { code: -32001, message: deny.message } }
    }
    const result = await mcpDispatch(rpc.method, rpc.params || {})
    // 通知没有响应体 (MCP 规范): 回空 result, 不构造内容。
    // 注意: MCP 通道的返回体是纯 JSON-RPC (客户端按 JSON-RPC 解析),
    // 历史上一直是 200, 这里保持行为不变。
    if (result === MCP_NO_CONTENT) {
      return { jsonrpc: "2.0", id: null, result: null }
    }
    // dispatch 要求回标准 JSON-RPC error (如 -32601 Method not found)
    if (result && typeof result === "object" && result.__jsonrpcError) {
      return { jsonrpc: "2.0", id: rpc.id != null ? rpc.id : null, error: result.__jsonrpcError }
    }
    return { jsonrpc: "2.0", id: rpc.id != null ? rpc.id : null, result }
  }

  // 普通 HTTP —— 先过鉴权 (isMcpContent=false: method 传 null 不影响判定)
  const deny = checkAuth(event, query, body, null, false)
  if (deny) return unauthorizedResponse(deny.message)

  // ★ 业务错误也要透传 HTTP 状态码, 否则调用方看到 200 会误判成功 (见 httpify)
  return httpify(await doGenerate(input))
}
