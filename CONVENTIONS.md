# 文档与密钥约定（CONVENTIONS）

本仓库是**公开仓库**。以下约定用于防止敏感信息再次泄露，请在任何一次编辑前先读这一页。

---

## 1. 占位符约定

**所有文档、示例、注释中出现的环境相关标识，一律使用占位符，不写真实值。**

| 位置 | 占位符 | 真实值格式 |
|---|---|---|
| 环境 ID | `YOUR_ENV_ID` | `pc-` + 16 位小写字母数字 |
| AppID | `YOUR_APPID` | 10 位数字 |
| 云函数 ID | `YOUR_FUNCTION_ID` | `lam-` + 8 位小写字母数字 |
| 密钥 | `xxx` / `your-api-key` / `${ENV_VAR}` | — |

### 组合写法

```
# 不带 appid 的默认域名
https://YOUR_ENV_ID.ap-shanghai.app.tcloudbase.com/api/gen-image

# 带 appid 的域名
https://YOUR_ENV_ID-YOUR_APPID.ap-shanghai.app.tcloudbase.com/api/gen-image
```

### ★ 为什么必须这样做

本仓库早期版本曾把真实的 `envId` / `FunctionId` / `appid` 写进文档，脱敏时替换了 **17 处**。
更麻烦的是**替换顺序**：`YOUR_ENV_ID-<appid>` 若先被短规则命中，会切成
`YOUR_ENV_ID-<真实appid>`（半脱敏），**必须长的先替**。所以约定是——

> **从一开始就写占位符，不要依赖事后脱敏。**
>
> 本文档自身也遵守这条：连举例都只用 `YOUR_ENV_ID` / `<appid>` 这种写法，
> 绝不再写一次真实值 —— 否则敏感扫描会连文档一起拦下（已实测踩到）。

真值请查腾讯云控制台（云函数 → 函数详情 → 基础信息），或看本地未脱敏的备份。

---

## 2. 密钥约定

| 规则 | 说明 |
|---|---|
| **不写进代码** | 一律从 `process.env` 读，绝不硬编码 |
| **不写进文档** | 示例里写 `xxx`，或写 `$API_KEY` 这种环境变量引用 |
| **不提交 `.env`** | 已在 `.gitignore`（`.env*`），本地要测就放 `.env.local` |
| **临时密钥必须带 `sessionToken`** | 否则 401。长期密钥（CAM 生成）不需要 |

### 环境变量清单

| 变量 | 必填 | 说明 |
|---|---|---|
| `API_KEY` | ✅ | 对外鉴权 key。**fail-closed**：不配则拒绝所有 HTTP 访问 |
| `DEFAULT_MODEL` | ❌ | 覆盖默认文生图模型 |
| `CLOUDBASE_ENV` | 自建版必填 | 环境 ID |
| `TENCENTCLOUD_SECRETID` / `_SECRETKEY` | 自建版必填 | 密钥对 |
| `TENCENTCLOUD_SESSIONTOKEN` | 临时密钥必填 | 漏了会 401 |

---

## 3. 目录约定

```
.
├── index.js              # 云函数主逻辑（唯一入口，单文件）
├── package.json          # 云函数依赖
├── docs/                 # 技术文档
│   └── 实测报告.md        # ★ 完整文档：能力 / 实测 / 踩坑 / 调用示例
├── selfhosted/           # 脱离云函数的自建版
└── .github/workflows/    # CI
```

- **本地产出的图片不随仓库分发**（`generated-images/` 已在 `.gitignore`）。
- 新增文档放 `docs/`；仓库根目录的 `README.md` 只做**入口简介**，不堆细节。
- 改了目录布局后，**必须检查跨文件的相对链接**（本仓库曾因移动文件产生 6 处死链）。

---

## 4. 提交前自检

CI 会跑，但本地先跑更快：

```bash
node --check index.js
node --check selfhosted/server.js
```

手工确认三件事：

1. **没有真实标识** —— 全文搜 `pc-`、`lam-`、`<appid>` 形态的真实值（本文档不写具体数字，避免自命中）。
2. **没有密钥** —— 搜 `AKID`、`sk-`、`secretKey =`。
3. **链接可点** —— 文档里引用的文件路径都存在。

> CI 的 `secret-scan` 已覆盖 1、2 两项，但**它是防回归的，不是替代人工审计**。
> 而且它**只扫 `*.js` / `*.json` / `*.md`**（不含 `.yml`，否则 workflow 里的正则字面量会自命中）。
> 所以往新类型文件里写内容时，别指望 CI 兜住。
