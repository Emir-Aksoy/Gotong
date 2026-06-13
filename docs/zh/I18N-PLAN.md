# i18n Retrofit Plan (REL-6 → REL-9)

> 公开发布 1.0 前的完整中英双语 retrofit 盘点 + 方案拍板。
> 用户决策（2026-06-12）：**本轮做完整 i18n retrofit**（中英双语，`/me` + admin 全覆盖）。
>
> Last updated: 2026-06-13

---

## 一、现状（已有机制，不重造）

i18n 引擎已经存在，住在 [`packages/web/static/app-core.js`](../../packages/web/static/app-core.js)：

| 件 | 位置 | 作用 |
|---|---|---|
| `I18N.zh` / `I18N.en` | app-core.js:14 / app-core.js | **363 个 key，两边完全平齐**（无缺口） |
| `lang` | app-core.js:889 | 默认 `'zh'`；**无 localStorage / sessionStorage**（刻意「file-first」） |
| `setLang(next)` | app-core.js:892 | 切 `t` → 写 `<html lang>` → `applyStaticI18n()` → 通知订阅者 |
| `applyStaticI18n()` | app-core.js:906 | 走 `[data-i18n]`（textContent）+ `[data-i18n-placeholder]`（placeholder）+ 刷 lang-toggle 按钮 |
| `onLangChange(fn)` | app-core.js:904 | 动态面板订阅，切语言时重渲染 |
| `syncLangFromConfig(d)` | app-core.js:1345 | 页面 boot 后按服务器 `config.defaultLang` 同步一次 |
| lang-toggle 按钮 | app.html:46 + app-core.js:1355 | DOMContentLoaded 接 click → `setLang` 翻转 |
| `window.AipeHub` | app-core.js:1314 | 暴露 `t` / `setLang` / `onLangChange` / `applyStaticI18n` / `escapeHtml`… |

**结论**：retrofit 不是造新系统，是把**硬编码中文**接到这套现成机制上。

## 二、缺口盘点（硬编码中文 CJK 行数）

全部住 `packages/web/static/`，全部在 unified SPA `app.html` 里加载，全部能访问 `window.AipeHub`。

### REL-7 — 成员 `/me` SPA
| 文件 | CJK 行 | 性质 |
|---|---|---|
| `app.js` | 218 | 成员工作台动态 JS 渲染的 HTML（Home / Inbox / 工作流编辑 / runs / agents）|
| `app.html` 动态片段 | 少量 | 静态 markup 已用 `data-i18n`；剩动态注入处 |

### REL-8 — admin UI 剩余硬编码
**admin.js 构建源**（[`packages/web/admin-src/`](../../packages/web/admin-src/)，改源后 `pnpm -C packages/web build:admin`）：
| 文件 | CJK 行 |
|---|---|
| `admin-src/main.js` | 53 |
| `admin-src/workflows.js` | 13 |
| `admin-src/managed-agents.js` | 7 |

**独立 IIFE 面板**（`<script>` 直挂，多数还没碰 `window.AipeHub`）：
| 文件 | CJK 行 | 面向 |
|---|---|---|
| `peer-summary-ui.js` | 162 | 控制面摘要/趋势/告警 |
| `identity-ui.js` | 83 | 用户/会话/审计 |
| `a2a-ui.js` | 59 | 出站 A2A agent |
| `peer-admin-ui.js` | 55 | 联邦 peer onboarding |
| `acp-ui.js` | 51 | 出站 ACP agent |
| `saml-ui.js` | 48 | SAML IdP |
| `oidc-ui.js` | 44 | OIDC IdP |
| `admin-wf-assist.js` | 34 | 工作流 AI 助手（已用 AipeHub×4）|
| `peer-manifest-ui.js` | 28 | peer 能力 manifest |
| `usage-ui.js` | 25 | 用量/成本看板 |
| `quotas-ui.js` | 25 | 配额 |
| `reputation-ui.js` | 12 | peer 声誉 |

合计 admin 侧约 ~700 CJK 行 + 成员侧约 ~220 行 ≈ **~920 行**待接线。

## 三、方案拍板（统一 retrofit 模式）

**每个文件同一套手法**，不发明第二套：

1. **加 key**：在 app-core.js `I18N.zh` **和** `I18N.en` 各加对应 key（两边必须平齐——CI 无校验，靠 `pnpm -C packages/web build:assets` 后人工核 + 已有 363-key parity 习惯）。命名沿用既有前缀风格（`tabHome` / `wfRunStatus` / `peerPolicy…`）。
2. **动态 JS 渲染** → 硬编码中文换 `window.AipeHub.t.<key>`（IIFE 面板取 `const AH = window.AipeHub; const t = () => AH.t`，渲染时读 `t().<key>` 拿当前语言）。
3. **切语言重渲染** → 每个有动态内容的面板加 `window.AipeHub.onLangChange(() => rerender())`。
4. **静态 HTML markup** → `data-i18n` / `data-i18n-placeholder` 属性（app.html 已是这模式）。
5. **admin.js** 改 `admin-src/*.js` 源 → `pnpm -C packages/web build:admin` 重建（**绝不**手改生成的 admin.js）。

**带占位符的串**（如「已发布 rev N」）：key 存模板，JS 端 `.replace('{n}', n)` 或函数式 key（沿用既有 `workflowRunCrossHub(dest,kind)` 等函数式 key 先例）。

## 四、语言检测/切换决策（REL-9）

现状：`lang` 默认 `'zh'`，仅服务器 `config.defaultLang` 能覆盖，toggle 是 per-tab 非持久，**刻意无 localStorage**。

**1.0 决策**（保「file-first」立场不破）：

- **首访检测**：app-core.js 在 `syncLangFromConfig` 之前加 `navigator.language` 探测——服务器没显式钉 `defaultLang` 时，`navigator.language.startsWith('zh')?'zh':'en'` 当种子。**纯检测无存储**，不违反 file-first。
- **持久化**：toggle 选择写一个**非 HttpOnly `lang` cookie**（round-trip 服务器，符合「浏览器只留服务器可读 cookie」原则，区别于被刻意排除的 localStorage）。服务器 boot 时读该 cookie 优先于 `config.defaultLang`。→ 返客用户语言选择会粘住。
- toggle 行为不变（按钮翻转 zh↔en），只是多落一个 cookie。

> 这是对 app-core.js 头注释「NO localStorage」立场的**最小让步**：cookie ≠ localStorage，且文档已声明「浏览器只保留服务器设的 cookie」。若用户更想保持「纯 per-tab 无任何持久」，REL-9 时去掉 cookie 那一步即可，其余 retrofit 不受影响。

## 五、验证 + 收口

- 每个文件改完：`pnpm -C packages/web build:assets`（重建 static-assets.ts 嵌入）+ 涉及 admin.js 时 `build:admin`。
- 预览验证：按记忆笔记 **先爆 PWA service worker（scope `/`）** 再信任 served 静态变更（member SPA + admin.js/app-core.js 都受 SW 缓存影响）。
- REL-9 收口：toggle 跑一遍 zh↔en，抽查 `/me` + 各 admin tab 无残留中文（英文模式下）；`pnpm -r test` 全绿（web 防腐测试不应回归）。
- 文档：本文件即 REL-6 交付物；REL-9 收口在 CLAUDE.md 文档地图登记。

## 六、顺序

REL-7（成员 SPA，用户首屏，优先）→ REL-8（admin，按用户面优先级：登录/核心 chrome → 企业/联邦深面板）→ REL-9（检测 + cookie + 收口验证）→ REL-10（发布动作清单）。一文件一小 commit。
