# reallife-oauth — 用 Google 登录,令牌自动保鲜(接入现实生活 C-M2 capstone）

北极星第 1 层「我的 AI 桌面」要 agent 能碰你**真实的**日历 / 邮件。出站
OAuth(C-M2)整条路——注册连接器 → 授权 → 换码存 vault → 注入 MCP 头 →
到期自动刷——在一个确定性脚本里跑通:

```
[0] 装一条 Google 日历连接器          （装之前:注入层透明,字节不变 = opt-in）
[1] begin → 授权 URL                  （原生日历 scope、无 openid、S256 PKCE、access_type=offline）
[2] callback → 换码 → 令牌进 vault    （信封加密:末尾抓原始 DB 字节,明文一个都不在盘上）
[3] 注入 → ${OAUTH_ACCESS_TOKEN}      （解析成 google_calendar 的活令牌 = 流进 MCP Authorization 头的那串）
[4] 时钟跳过到期 → refresh_token grant （换新令牌存回,旧 refresh_token 前推）
[5] 同一条缝现在吐新令牌               （连一次、永续、重生即新鲜）
```

底下是**真的** `@gotong/identity`:M1 纯核(PKCE / 授权 URL / 换码体 / 刷新体 /
响应解析)+ M2 vault 存储(信封加密)。零网络、零 API key——唯一被 mock 的是那
一个网络跳(一个假的 Google 令牌端点)。

```bash
pnpm demo:reallife-oauth
```

## 它证明什么

1. **授权 URL 是出站的形状**:用 provider **原生**日历 scope、**不塞 openid**
   (出站不是登录,没有 id_token)、S256 PKCE、`access_type=offline`——没最后
   这个 Google 不发 refresh_token,M4b 就没法保鲜。
2. **令牌进 vault、明文不落盘**:换码拿到的令牌集在进 SQLite 前就在 JS 里信封
   加密了。demo 末尾把原始 DB 字节(含 WAL 旁文件)全抓出来,硬断言首发 /
   刷新后的 access_token、refresh_token、client_secret **一个字节都不在盘上明文**。
3. **注入是 per-server 的固定占位**:M4a 缝把 `${OAUTH_ACCESS_TOKEN}` 解析成
   「喂 `google_calendar` 这个 MCP server」的活令牌。别的 server 名 / 别的 ref
   一律穿透到 base——所以两条 oauth 连接器不撞名,没连接器时注入层**字节不变**。
4. **连一次、永续、重生即新鲜**:时钟跳过到期,refresh grant 把新令牌存回,同一
   条注入缝现在吐的是**新**令牌——会话重生(agent 下次 spawn)即拿到新鲜 bearer。

## 三条不可破边界(在这里都看得见)

- **① 全走 MCP 不存数据**:hub 存的是一把令牌(钥匙),**不是你的日程**;日历
  数据全在 Google / MCP 那端。搬走 `.gotong/` = 搬走全部,连接器不留数据尾巴。
- **② 凭证纪律**:令牌进 vault 信封加密(原始字节已证),注入用固定占位
  `${OAUTH_ACCESS_TOKEN}` 而非明文令牌。
- **③ 接入 ≠ 授权行动**:活令牌给的是「读 / 调」你日历的**触达**;真发邀请 /
  删事件这类高风险动作仍过 [`personal-butler`](../personal-butler) 的 governed
  审批闸(**自主**)。这条缝给的是 reach,不是 autonomy。

## 对照生产件

本 demo 刻意只引**公共包** `@gotong/identity`(host 内件不是公共 API,同
[`butler-cross-hub`](../butler-cross-hub) 镜像 `personal-butler-ask-peer.ts` 的
先例):真 M1 核 + 真 M2 vault 在底下跑,只把三段薄编排摊平在一个文件里。它们薄
到不可能和 host 真件跑偏;host 真件另有自己的单测把关。

| demo 内联件 | 生产真件 |
|---|---|
| `exchangeAndStore`(换码 → parse → 存) | `packages/host/src/oauth-connect-service.ts`(完整 M3:state 单次用校验、TTL、各种 throw、web 路由 admin 门控) |
| `oauthSecretSource`(固定 ref → 活令牌) | `packages/host/src/oauth-secret-source.ts`(M4a:pool 无感注入 `mcpSecretSource`、fail-soft 坏 blob 不连累 spawn) |
| `refreshIfDue`(非密投影判到期 → 刷) | `packages/host/src/oauth-token-refresh.ts`(M4b:60s tick、start() 补 tick、逐连接器 fail-soft、缺 refresh 只 warn 一次) |
| 常量 `CONNECTOR` | M5b 内置预设 `packages/web/src/builtin-oauth-connectors.ts`(端点 / scope / access_type=offline 烤在预设,成员只填三件套) |

真机:在 admin「连接现实生活」面板(M5c)挑 Google 日历卡、填自己在 Google
Cloud Console 注册的 OAuth 三件套、点「连接」跳授权即可——同一条链路,真 Google
端点。见 [`docs/zh/REAL-LIFE-CONNECTORS.md`](../../docs/zh/REAL-LIFE-CONNECTORS.md)。
