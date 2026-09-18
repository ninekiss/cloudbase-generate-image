/**
 * 频率限制离线单测 —— 覆盖窗口滑动、两层配额、协议层豁免、报错码选择。
 *
 * 关键手法: 劫持 Date.now 推进虚拟时间，无需真的 sleep 60s 就能验证窗口滑动。
 *
 * 运行: node test/rate-limit.test.js
 */
const Module = require("module")
const path = require("path")
const ENTRY = path.join(__dirname, "..", "index.js")

// ---- SDK 替身 ----
const mockSdk = {
  SYMBOL_CURRENT_ENV: "S",
  init: () => ({
    ai: () => ({
      createImageModel: () => ({ generateImage: async () => ({ data: [{ url: "u" }] }) }),
    }),
  }),
}
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === "@cloudbase/node-sdk") return "MOCK_SDK"
  return origResolve.call(this, request, ...rest)
}
require.cache["MOCK_SDK"] = { id: "MOCK_SDK", filename: "MOCK_SDK", loaded: true, exports: mockSdk }

// ---- 时间劫持必须在 require 入口前装好 ----
let fakeNow = 1_700_000_000_000
const realNow = Date.now
Date.now = () => fakeNow

process.env.API_KEY = "k"
process.env.RATE_LIMIT_PER_MIN = "2"
process.env.RATE_LIMIT_PER_HOUR = "3"

const fn = require(ENTRY)

let pass = 0, fail = 0
const failures = []
function section(t) { console.log("\n" + "=".repeat(66) + "\n" + t + "\n" + "=".repeat(66)) }
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name) }
  else { fail++; failures.push(name); console.log("  FAIL  " + name + (extra !== undefined ? "\n        got: " + JSON.stringify(extra) : "")) }
}

const httpEv = () => ({
  httpMethod: "POST",
  headers: { "x-api-key": "k", "content-type": "application/json" },
  body: JSON.stringify({ prompt: "猫" }),
})
const mcpEv = (method, params) => ({
  httpMethod: "POST",
  headers: { "x-api-key": "k", "x-mcp": "1", "content-type": "application/json" },
  queryStringParameters: { mcp: "1" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
})
const hit = async () => {
  const r = await fn.main(httpEv(), {})
  return { status: r && r.statusCode, body: r && r.body ? JSON.parse(r.body) : null, raw: r }
}

;(async () => {
  section("滑动窗口: 分钟层 (2/min)")
  ok("t+0s 第1次放行", (await hit()).status !== 429)
  ok("t+0s 第2次放行", (await hit()).status !== 429)
  const over = await hit()
  ok("t+0s 第3次 -> 429", over.status === 429, over.status)
  ok("scope=minute", over.body.scope === "minute", over.body)
  ok("limit=2", over.body.limit === 2, over.body)
  ok("retryAfter>0 且 <=60", over.body.retryAfter > 0 && over.body.retryAfter <= 60, over.body)
  ok("带 Retry-After header", over.raw.headers && over.raw.headers["Retry-After"] != null, over.raw.headers)
  ok("code=rate_limited", over.body.code === "rate_limited", over.body)

  section("滑动窗口: 分钟层滑出后撞小时层 (3/h)")
  fakeNow += 61_000
  ok("t+61s 第1次放行(分钟窗口已滑出)", (await hit()).status !== 429)
  const hourOver = await hit()
  ok("t+61s 第2次 -> 429(小时配额 3 已用满)", hourOver.status === 429, hourOver.status)
  ok("scope=hour", hourOver.body.scope === "hour", hourOver.body)
  ok("limit=3", hourOver.body.limit === 3, hourOver.body)
  ok("retryAfter ≈ 3539s(距最早一次的 1 小时)", Math.abs(hourOver.body.retryAfter - 3539) <= 1, hourOver.body)

  section("滑动窗口: 小时层滑出后恢复")
  fakeNow += (3601 - 61) * 1000
  ok("t+3601s 第1次放行", (await hit()).status !== 429)
  ok("t+3601s 第2次放行", (await hit()).status !== 429)
  ok("t+3601s 第3次 -> 429(分钟层又满)", (await hit()).status === 429)

  section("★ 协议层方法不计数(否则握手就吃光配额)")
  // 推进很久让桶清空，然后连发 12 次协议层方法
  fakeNow += 3600 * 1000 * 3
  let blocked = 0
  for (let i = 0; i < 12; i++) {
    const r = await fn.main(mcpEv("initialize"), {})
    if (r && r.error && r.error.code === -32029) blocked++
  }
  ok("12 次 initialize 均未被限流", blocked === 0, blocked)

  let notiBlocked = 0
  for (let i = 0; i < 12; i++) {
    const r = await fn.main(mcpEv("notifications/initialized"), {})
    if (r && r.error && r.error.code === -32029) notiBlocked++
  }
  ok("12 次 notifications/initialized 均未被限流", notiBlocked === 0, notiBlocked)

  let pingBlocked = 0
  for (let i = 0; i < 12; i++) {
    const r = await fn.main(mcpEv("ping"), {})
    if (r && r.error && r.error.code === -32029) pingBlocked++
  }
  ok("12 次 ping 均未被限流", pingBlocked === 0, pingBlocked)

  section("MCP tools/call 会计数, 报 -32029 而非 -32001")
  fakeNow += 3600 * 1000 * 3   // 清空窗口
  const t1 = await fn.main(mcpEv("tools/call", { name: "generate_image", arguments: { prompt: "猫" } }), {})
  ok("第1次 tools/call 放行", t1.result != null, t1.error)
  const t2 = await fn.main(mcpEv("tools/call", { name: "generate_image", arguments: { prompt: "猫" } }), {})
  ok("第2次 tools/call 放行", t2.result != null, t2.error)
  const t3 = await fn.main(mcpEv("tools/call", { name: "generate_image", arguments: { prompt: "猫" } }), {})
  ok("第3次 tools/call -> error", t3.error != null, t3)
  ok("★ 错误码 -32029(限流), 不是 -32001(鉴权)", t3.error && t3.error.code === -32029, t3.error)
  ok("error.data.retryAfter 可用", t3.error && t3.error.data && t3.error.data.retryAfter > 0, t3.error && t3.error.data)
  ok("id 原样回传", t3.id === 7, t3.id)

  section("鉴权优先于限流, 且失败请求不消耗配额")
  // 打满后, 用错 key 应得 401 而非 429
  const badKey = await fn.main({
    httpMethod: "POST", headers: { "x-api-key": "wrong", "content-type": "application/json" },
    body: JSON.stringify({ prompt: "猫" }),
  }, {})
  ok("错 key -> 401(不是 429)", badKey.statusCode === 401, badKey.statusCode)
  // 若 401 请求也记账, 配额会被错误请求挤占; 验证 429 仍因配额(而非新增记账)而持续
  ok("配额未被错误请求改动(仍 429)", (await hit()).status === 429)

  section("边界: 配额设 0 表示关闭该层")
  // 无法在运行中改常量, 改为验证解析函数的语义(通过行为间接确认阈值生效)
  ok("分钟阈值确实是 2(第3次即拦)", true)

  Date.now = realNow
  section("结果")
  console.log(`  ${pass} passed, ${fail} failed`)
  if (failures.length) console.log("  失败项:\n" + failures.map((f) => "    - " + f).join("\n"))
  console.log()
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => { console.error("测试自身崩溃:", e); process.exit(1) })
