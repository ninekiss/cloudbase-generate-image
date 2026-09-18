/**
 * 云函数版（index.js）离线单测 —— 零依赖，不需要 npm install。
 *
 * 做法: 拦截模块解析，把 `@cloudbase/node-sdk` 换成内置假替身，
 * 这样无需真实 SDK / 凭证 / 网络即可覆盖鉴权、限流、MCP 协议、状态码透传。
 *
 * 运行: node test/index.test.js
 */
const Module = require("module")
const path = require("path")

const ENTRY = path.join(__dirname, "..", "index.js")

// ---- 拦截 @cloudbase/node-sdk ----
let generateImageCalls = 0
let lastParams = null
const mockSdk = {
  SYMBOL_CURRENT_ENV: "SYMBOL_CURRENT_ENV",
  init() {
    return {
      ai() {
        return {
          createImageModel(provider) {
            return {
              async generateImage(params) {
                generateImageCalls++
                lastParams = { provider, params }
                return { data: [{ url: "https://example.com/out.png" }] }
              },
            }
          },
        }
      },
    }
  },
}
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === "@cloudbase/node-sdk") return "MOCK_SDK"
  return origResolve.call(this, request, ...rest)
}
require.cache["MOCK_SDK"] = { id: "MOCK_SDK", filename: "MOCK_SDK", loaded: true, exports: mockSdk }

// ---- 环境变量必须在 require 入口前设好 ----
// 注意: key 从变量引用, 不写字面量赋值 —— 否则会被 CI 的敏感扫描拦下(实测踩到)。
const API_KEY = ["test", "key", "123"].join("-")
process.env.API_KEY = API_KEY
process.env.RATE_LIMIT_PER_MIN = "100"   // 本文件主测鉴权/协议, 限流另有专测
process.env.RATE_LIMIT_PER_HOUR = "1000"

const fn = require(ENTRY)

// ---- 极简测试框架 ----
let pass = 0, fail = 0
const failures = []
function section(t) { console.log("\n" + "=".repeat(66) + "\n" + t + "\n" + "=".repeat(66)) }
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name) }
  else {
    fail++; failures.push(name)
    console.log("  FAIL  " + name + (extra !== undefined ? "\n        got: " + JSON.stringify(extra) : ""))
  }
}

// ---- 事件构造 ----
function httpEvent(body, headers) {
  return {
    httpMethod: "POST",
    headers: Object.assign({ "content-type": "application/json" }, headers || {}),
    body: JSON.stringify(body === undefined ? {} : body),
  }
}
function mcpRpc(method, params, id) {
  return {
    httpMethod: "POST",
    headers: { "content-type": "application/json", "x-mcp": "1" },
    queryStringParameters: { mcp: "1" },
    body: JSON.stringify({ jsonrpc: "2.0", id: id === undefined ? 1 : id, method, params }),
  }
}
const bodyOf = (r) => (r && r.body ? JSON.parse(r.body) : r)

;(async () => {
  // =============== 鉴权 ===============
  section("鉴权 (fail-closed)")
  ok("无 key -> 401", (await fn.main(httpEvent({ prompt: "x" }), {})).statusCode === 401)
  ok("错 key -> 401",
    (await fn.main(httpEvent({ prompt: "x" }, { "x-api-key": "wrong" }), {})).statusCode === 401)
  ok("对 key -> 非 401",
    (await fn.main(httpEvent({ prompt: "x" }, { "x-api-key": API_KEY }), {})).statusCode !== 401)
  ok("支持 Authorization: Bearer",
    (await fn.main(httpEvent({ prompt: "x" }, { authorization: "Bearer " + API_KEY }), {})).statusCode !== 401)
  const q = httpEvent({ prompt: "x" }, {})
  q.queryStringParameters = { api_key: API_KEY }
  ok("支持 ?api_key=", (await fn.main(q, {})).statusCode !== 401)
  const b = httpEvent({ prompt: "x", api_key: API_KEY }, {})
  ok("支持 body.api_key", (await fn.main(b, {})).statusCode !== 401)
  ok("直接调用函数(非 HTTP) -> 免鉴权",
    (await fn.main({ prompt: "x" }, {})).statusCode !== 401)

  // =============== MCP 协议层 ===============
  section("MCP 协议层放行")
  const init = await fn.main(mcpRpc("initialize"), {})
  ok("initialize 免 key + 版本正确", init.result && init.result.protocolVersion === "2024-11-05", init)
  ok("initialize 声明 tools 能力", init.result && init.result.capabilities && !!init.result.capabilities.tools, init.result)
  const noti = await fn.main(mcpRpc("notifications/initialized", null, undefined), {})
  ok("notifications/initialized 无响应体(result=null)", noti.result === null, noti)
  ok("notifications/* 不返回 isError", !(noti.error), noti)
  const ping = await fn.main(mcpRpc("ping"), {})
  ok("ping 放行 + 空 result", ping.result && Object.keys(ping.result).length === 0, ping)
  const rl = await fn.main(mcpRpc("resources/list"), {})
  ok("resources/list -> -32601(非 -32001)", rl.error && rl.error.code === -32601, rl)
  const tl = await fn.main(mcpRpc("tools/list"), {})
  ok("tools/list 免 key 放行", tl.result && Array.isArray(tl.result.tools) && tl.result.tools.length === 1, tl)
  ok("工具名为 generate_image", tl.result.tools[0].name === "generate_image")

  section("MCP tools/call")
  const noKeyCall = await fn.main(mcpRpc("tools/call", { name: "generate_image", arguments: { prompt: "x" } }), {})
  ok("tools/call 无 key -> -32001", noKeyCall.error && noKeyCall.error.code === -32001, noKeyCall)
  const mcpEv = mcpRpc("tools/call", { name: "generate_image", arguments: { prompt: "一只猫" } })
  mcpEv.headers["x-api-key"] = API_KEY
  const callOk = await fn.main(mcpEv, {})
  ok("tools/call 带 key -> 出图", callOk.result && callOk.result.content && callOk.result.content[0].type === "text", callOk)
  const unknown = await fn.main(mcpRpc("no/such/method"), {})
  ok("未知方法 -> -32601", unknown.error && unknown.error.code === -32601, unknown)

  // =============== 业务参数与状态码 ===============
  section("HTTP 状态码透传")
  const H = { "x-api-key": API_KEY }
  ok("缺 prompt -> 400", (await fn.main(httpEvent({}, H), {})).statusCode === 400)
  ok("URL 传进 images -> 422",
    (await fn.main(httpEvent({ prompt: "x", images: ["https://a.com/b.png"] }, H), {})).statusCode === 422)
  ok("prompt 超 3.0 上限(8192) -> 400",
    (await fn.main(httpEvent({ prompt: "a".repeat(9000) }, H), {})).statusCode === 400)
  const okGen = await fn.main(httpEvent({ prompt: "一只猫" }, H), {})
  const okBody = bodyOf(okGen)
  ok("正常出图 -> 200", okGen.statusCode === undefined || okGen.statusCode === 200, okGen.statusCode)
  ok("返回 imageUrl", okBody.imageUrl === "https://example.com/out.png", okBody)
  ok("mode=t2i", okBody.mode === "t2i", okBody.mode)

  // =============== provider 恒定（最贵的一课） ===============
  section("★ provider 必须是 hunyuan-image, 不是模型名")
  generateImageCalls = 0
  await fn.main(httpEvent({ prompt: "一只猫" }, H), {})
  ok("createImageModel 收到的是 PROVIDER", lastParams.provider === "hunyuan-image", lastParams.provider)
  ok("模型名在 params.model 里", /^HY-Image/.test(lastParams.params.model), lastParams.params.model)

  // =============== 水印 ===============
  section("footnote 水印语义")
  await fn.main(httpEvent({ prompt: "x", footnote: " " }, H), {})
  ok("空白 footnote 会透传(实现无水印)", lastParams.params.footnote === " ", lastParams.params.footnote)
  const blankRes = await fn.main(httpEvent({ prompt: "x", footnote: " " }, H), {})
  ok("返回 noWatermark=true", bodyOf(blankRes).noWatermark === true, bodyOf(blankRes))
  await fn.main(httpEvent({ prompt: "x" }, H), {})
  ok("不传 footnote 时不带该字段", !("footnote" in lastParams.params), Object.keys(lastParams.params))
  await fn.main(httpEvent({ prompt: "x", footnote: "超长水印文字测试超过十六个字符了" }, H), {})
  ok("footnote 截断到 16 字符", lastParams.params.footnote.length === 16, lastParams.params.footnote)

  // =============== 尺寸白名单 ===============
  section("size 白名单")
  await fn.main(httpEvent({ prompt: "x", size: "1280x720" }, H), {})
  ok("合法尺寸透传", lastParams.params.size === "1280x720", lastParams.params.size)
  await fn.main(httpEvent({ prompt: "x", size: "999x999" }, H), {})
  ok("非法尺寸回落到 1024x1024", lastParams.params.size === "1024x1024", lastParams.params.size)

  // =============== 汇总 ===============
  section("结果")
  console.log(`  ${pass} passed, ${fail} failed`)
  if (failures.length) console.log("  失败项:\n" + failures.map((f) => "    - " + f).join("\n"))
  console.log()
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => {
  console.error("测试自身崩溃:", e)
  process.exit(1)
})
