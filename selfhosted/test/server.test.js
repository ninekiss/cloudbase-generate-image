/**
 * 自建版（selfhosted/server.js）离线单测。
 *
 * 只测纯函数部分（鉴权、限流、协议层判定、状态码映射），
 * 不启 HTTP 服务、不需要真实凭证 —— 端到端验证请见仓库 README 的部署后冒烟步骤。
 *
 * 运行: node test/server.test.js
 */
const Module = require("module")
const path = require("path")

// SDK 替身：自建版在模块顶层就会 init，所以必须在 require 前装好
const mockSdk = {
  SYMBOL_CURRENT_ENV: "S",
  init: () => ({ ai: () => ({ createImageModel: () => ({ generateImage: async () => ({ data: [{ url: "u" }] }) }) }) }),
}
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === "@cloudbase/node-sdk") return "MOCK_SDK"
  return origResolve.call(this, request, ...rest)
}
require.cache["MOCK_SDK"] = { id: "MOCK_SDK", filename: "MOCK_SDK", loaded: true, exports: mockSdk }

process.env.API_KEY = "test-key"
process.env.RATE_LIMIT_PER_MIN = "2"
process.env.RATE_LIMIT_PER_HOUR = "3"

const srv = require(path.join(__dirname, "..", "server.js"))

let pass = 0, fail = 0
const failures = []
function section(t) { console.log("\n" + "=".repeat(66) + "\n" + t + "\n" + "=".repeat(66)) }
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name) }
  else { fail++; failures.push(name); console.log("  FAIL  " + name + (extra !== undefined ? "\n        got: " + JSON.stringify(extra) : "")) }
}

// ---- 鉴权 ----
section("checkAuth（自建版：所有请求都走 HTTP）")
const H = { "x-api-key": "test-key" }
ok("无 key -> 拒绝", srv.checkAuth({}, {}, null, null, false) != null)
ok("错 key -> 拒绝", srv.checkAuth({ "x-api-key": "bad" }, {}, null, null, false) != null)
ok("对 key -> 通过", srv.checkAuth(H, {}, null, null, false) === null)
ok("Bearer 形式 -> 通过", srv.checkAuth({ authorization: "Bearer test-key" }, {}, null, null, false) === null)
ok("query 形式 -> 通过", srv.checkAuth({}, { api_key: "test-key" }, null, null, false) === null)
ok("body 形式 -> 通过", srv.checkAuth({}, {}, { api_key: "test-key" }, null, false) === null)
ok("protocol 方法免 key", srv.checkAuth({}, {}, null, "initialize", true) === null)
ok("MCP 非 tools/call 免 key", srv.checkAuth({}, {}, null, "some/method", true) === null)
ok("★ MCP tools/call 必须校验(无 key -> 拒绝)", srv.checkAuth({}, {}, null, "tools/call", true) != null)
ok("★ 普通 HTTP 不被 isMcpContent 逻辑误放行",
  srv.checkAuth({}, {}, null, null, false) != null)

// ---- 协议层判定 ----
section("协议层方法判定")
ok("initialize 是协议层", srv.isProtocolMethod("initialize") === true)
ok("ping 是协议层", srv.isProtocolMethod("ping") === true)
ok("tools/list 是协议层", srv.isProtocolMethod("tools/list") === true)
ok("notifications/initialized 是协议层", srv.isProtocolMethod("notifications/initialized") === true)
ok("resources/list 是协议层", srv.isProtocolMethod("resources/list") === true)
ok("★ tools/call 不是协议层(要计数)", srv.isProtocolMethod("tools/call") === false)
ok("未知方法不是协议层", srv.isProtocolMethod("no/such") === false)
ok("notifications/* 识别正确", srv.isNotificationMethod("notifications/x") === true)

// ---- 限流 ----
section("滑动窗口限流 (2/min, 3/h)")
let t = 1_700_000_000_000
const key = srv.rateKeyFromKey("test-key")
ok("限流键是 16 位指纹(非明文)", /^[0-9a-f]{16}$/.test(key) && key !== "test-key", key)

ok("第1次放行", srv.rateCheck(key, t).limited === false)
ok("第2次放行", srv.rateCheck(key, t).limited === false)
const r3 = srv.rateCheck(key, t)
ok("第3次 -> 限流", r3.limited === true, r3)
ok("scope=minute", r3.scope === "minute", r3)
ok("limit=2", r3.limit === 2, r3)
ok("retryAfter ∈ (0,60]", r3.retryAfter > 0 && r3.retryAfter <= 60, r3)

ok("t+61s 分钟窗口滑出 -> 放行", srv.rateCheck(key, t + 61_000).limited === false)
const rHour = srv.rateCheck(key, t + 61_000)
ok("t+61s 第2次 -> 小时层限流", rHour.limited === true, rHour)
ok("scope=hour", rHour.scope === "hour", rHour)
ok("limit=3", rHour.limit === 3, rHour)

ok("t+3601s 小时窗口滑出 -> 恢复", srv.rateCheck(key, t + 3_601_000).limited === false)

section("不同 key 各自独立配额")
const keyB = srv.rateKeyFromKey("another-key")
ok("新 key 首两次放行",
  srv.rateCheck(keyB, t).limited === false && srv.rateCheck(keyB, t).limited === false)

// ---- 状态码映射 ----
section("业务码 -> HTTP 状态码")
ok("invalid_param -> 400", srv.ERROR_HTTP_STATUS.invalid_param === 400)
ok("url_in_images_field -> 422", srv.ERROR_HTTP_STATUS.url_in_images_field === 422)
ok("download_failed -> 422", srv.ERROR_HTTP_STATUS.download_failed === 422)
ok("rate_limited -> 429", srv.ERROR_HTTP_STATUS.rate_limited === 429)
ok("server_misconfigured -> 500", srv.ERROR_HTTP_STATUS.server_misconfigured === 500)

section("resolveStatus")
ok("带 business error code 时映射到对应状态码",
  srv.resolveStatus({ success: false, code: "rate_limited" }) === 429,
  srv.resolveStatus({ success: false, code: "rate_limited" }))
ok("成功结果不带 statusCode(默认 200)",
  srv.resolveStatus({ success: true, imageUrl: "u" }) === undefined ||
  srv.resolveStatus({ success: true, imageUrl: "u" }) === 200)

section("结果")
console.log(`  ${pass} passed, ${fail} failed`)
if (failures.length) console.log("  失败项:\n" + failures.map((f) => "    - " + f).join("\n"))
console.log()
process.exit(fail === 0 ? 0 : 1)
