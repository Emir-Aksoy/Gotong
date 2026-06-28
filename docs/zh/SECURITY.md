# 安全策略

<!-- doc-version: 1.0 -->
> **文档版本 1.0** · 中文译本 · 最后更新 2026-06-27 · 权威源：[English](../../SECURITY.md)。如译文与英文版冲突，以英文版为准。

## 如何报告漏洞

**请不要为安全问题开公开的 GitHub issue、discussion 或 PR。** 请走私密渠道：

### 首选——GitHub 私密漏洞报告

在以下地址开一个私密 advisory：

> **<https://github.com/Emir-Aksoy/AipeHub/security/advisories/new>**

GitHub 内置的表单给你：

- 与维护者之间端到端私密的会话线程（无邮件泄漏）
- 附件 + 复现步骤集中在一处
- 一条从报告 → 修复 → 公开 CVE 分配的可跟踪时间线

这是我们最先看、回复最快的渠道。你需要一个免费的 GitHub 账号，这是唯一的前提。

### 没有邮件渠道（1.0 之前）

在 v0.x 期间，**刻意没有安全邮箱**。`security@aipehub.dev` 在本仓库较旧的修订里出现过，那是一个*设想中的*地址——域名未注册、邮箱未激活，发给它的邮件无处可达。我们已经停止把它宣传为备用渠道，而不是吊着一个可能有人会拿真实报告去信任的死联系方式。

GitHub 私密漏洞报告（见上）是今天**唯一**的渠道：免费、私密、我们最先看的那个。是否值得搭建一个真正的邮箱，是一个被推迟到 1.0 冲刺期的[发布清单](../../.github/RELEASE-CHECKLIST.md#security-contact)决策；在此之前，请使用 advisory 表单。

如果你确实无法使用 GitHub，请开一个**非安全**的 GitHub Discussion，请一位维护者主动联系你——不要带任何漏洞细节——我们会为那一个报告安排一条私密渠道。

在你的 advisory 里包含：

- 问题描述
- 精确的复现步骤
- 你测试所基于的 commit hash（`git rev-parse HEAD`）
- （可选）一个建议的修复或补丁
- （可选）你希望在 advisory 里被署名的姓名 / handle

### PGP 呢？

我们今天**不**发布 PGP 公钥。原因：

- GitHub 的私密 advisory 渠道在你和维护者通知之间已经是端到端 TLS 加密的，所以 PGP 增益不大。
- 为一个早期项目维护 PGP 公钥带来的是更多失败模式（丢钥、过期、签名仪式），而非收益。

如果你所在组织的策略要求 PGP 加密披露，请先通过 GitHub 渠道联系我们，我们会为那一个报告安排一次带外 PGP 交换。

---

## 响应时间线

| 阶段 | 目标 |
|---|---|
| 确认收到 | 报告后 **72 小时**内 |
| 首次分诊 + 严重度评估 | **7 天**内 |
| 在 `main` 上修复或缓解 | 高危：**7 天**，中危：**30 天**，低危：尽力而为 |
| 公开披露 | 修复落地后 **7–14 天**（或经双方同意） |

每次状态转换你都会收到更新。如果你在 72 小时确认窗口内没有收到我们的回复，那本身就是一个 bug——请通过 GitHub Discussion（一般内容，不含安全细节）升级，并 @ 一位维护者。

---

## 受支持的版本

AipeHub 在内部仍处于 1.0 之前（你在 `CHANGELOG.md` 里看到的 v2.0 / v2.1 标签指的是 file-first 重写的代际，而非 SemVer 1.0 门槛）。我们只在当前 `main` 分支上修补安全问题。**没有 LTS 分支。**

如果你需要长期稳定，请锁定一个你已审计过的 commit，并为就地打补丁预留预算；我们无法无限期 backport。

---

## 威胁模型

AipeHub 是为**小型、可信、单租户**部署设计的——一个研究实验室、一个项目团队、一个小型公开预览群体。默认值假设这个房间由互相信任的人运营。

在范围内（我们接受关于以下问题的报告）：

- ✅ 对 admin 端点的未鉴权访问
- ✅ Token / cookie 泄露（跨用户、跨房间、跨进程）
- ✅ `secrets.enc.json` 和 master-key 文件中的加密 / 解密缺陷
- ✅ 授权绕过——例如一个 worker 触达仅 admin 的路由
- ✅ 内置 admin UI 中的 CSRF / 点击劫持 / XSS
- ✅ **无需**任何鉴权的资源耗尽（匿名 DOS）
- ✅ 导致 host 崩溃或损坏 transcript 的 wire 协议解析缺陷
- ✅ `TeamBridgeAgent` 中的提权（例如本地团队获得对上游意料之外的可见性）
- ✅ LocalAgentPool / 托管 agent spawn 路径中的混淆代理（confused-deputy）问题

超出范围（低优先级——欢迎补丁，但不作为安全问题处理）：

- ❌ **不可信的 admin。** 一旦一个账号持有 admin 角色，它就能做 admin 角色暴露的任何事。如果你需要内部 admin 隔离，请开一个功能请求。
- ❌ **已鉴权**用户发起的**应用层 DDoS**。限流是按 IP 的，重启即重置；不是对蓄意内部滥用的防御。
- ❌ **超大任务载荷**导致内存压力。目前尚无配额。
- ❌ token 比较之外的**侧信道时序攻击**（token 比较本身是常量时间的）。
- ❌ 需要对 host 机器进行物理 / shell 访问的问题。
- ❌ 针对 `templates/community/` 上游源的发现——那些是第三方 prompt 仓库，受其自身 license 和治理约束；请直接向它们报告。

如果你的发现处在边界上，请通过 GitHub advisory 渠道发来，我们会分诊。

---

## 已有的就地缓解（让你知道现成的防御有哪些）

评估一个问题时，先看看以下某项是否已经覆盖它：

- **Token 存储**：admin / worker token 在写入磁盘前用 SHA-256 哈希。明文只在铸造时显示一次。验证使用常量时间比较。
- **Cookie 存储**：始终 HttpOnly；当 `AIPE_COOKIE_SECURE=1` 时（在 HTTPS 后必需）加 `SameSite=Strict` + `Secure`。
- **CSRF**：`AIPE_ALLOWED_HOSTS` 对每个改变状态的方法强制 `Host:` 和 `Origin:` 双重检查。**每个生产部署都要设置它。** 不设置意味着「仅环回安全」。
- **限流**：`AIPE_ADMIN_RATE_MAX` / `_SEC` 在每个滑动窗口内按 IP 限制 admin-token 验证尝试次数。默认 10 / 60s。
- **安全响应头**：每个响应都带 `X-Frame-Options: DENY`、严格的 CSP、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`。
- **准入闸**：`AIPE_GATING=admin-approval`（默认）要求每个远程 agent 在加入前经人工批准。`gating=open` **仅限开发**，在生产中会被拒绝并带启动警告。
- **API-key 加密**：workspace 和 per-agent API key 存在 `<space>/secrets.enc.json`，AES-256-GCM，master key 在 `<space>/runtime/secret.key`（0600）或 `AIPE_SECRET_KEY` 环境变量。仅有加密文件本身不足以恢复密钥。
- **Per-agent 身份绑定（v0.4）**：`authenticate()` 可返回 `{ ok: true, allowedAgents: [...] }`，使得一个泄露的 API key 无法冒充任意 agent id——只能冒充它被绑定的那些。
- **Transcript 仅追加**：运行时没有任何 API 可以删除或重写 transcript 条目。篡改需要文件系统访问（这超出范围；见上文「超出范围」）。

---

## 协调披露

我们遵循标准的协调披露：

1. 你私密地发来细节（首选 GitHub advisory 渠道）。
2. 维护者确认、界定范围、开发并测试修复。
3. 修复落地到 `main`（如果做出过任何 LTS 承诺，则还有 backport 分支）。
4. 7–14 天后公开披露，带：
   - 一个 CVE id（如合适我们会申请）
   - 在 advisory 里对你的署名，除非你要求保持匿名
   - 在 `CHANGELOG.md` 里的影响 + 缓解摘要

如果你在我们发布修复之前公开披露，我们仍会发布修复，但 advisory 的署名字段会标注「未协调」。

---

## 运营者安全清单

如果你是在**运行**一个 hub，而非报告针对它的缺陷，部署侧的加固清单在 [`docs/DEPLOY.md` § "Production checklist"](DEPLOY.md#production-checklist)。

简而言之：

- [ ] 在 HTTPS 前面时设 `AIPE_COOKIE_SECURE=1`
- [ ] `AIPE_ALLOWED_HOSTS` 设为你真实的主机名
- [ ] `AIPE_GATING=admin-approval`（在公网上绝不用 `open`）
- [ ] Caddy / nginx 终结 TLS；后端绑定到 `127.0.0.1`
- [ ] 设置 `runtime/secret.key`（chmod 600）或 `AIPE_SECRET_KEY` 环境变量
- [ ] `<space>/` 目录有备份
- [ ] 至少 2 个 admin 账号，以便从锁死中恢复
- [ ] 监控 `/healthz`

---

感谢你让这个项目保持诚实。多数报告者永远看不到一个私密 advisory 另一侧的样子——但我们收到的每一个，都让下一次部署更安全一点。
