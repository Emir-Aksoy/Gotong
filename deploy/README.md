# deploy/ — 上线配置模板

这里是「准备上线」时直接复制改值的配置模板。**完整的拓扑决策、成员 IM
绑定流程、云服务器 IP 暴露风险**，看 [`docs/zh/GO-LIVE.md`](../docs/zh/GO-LIVE.md)。
通用环境变量表 + Caddy/systemd/防火墙逐行讲解，看 [`docs/zh/DEPLOY.md`](../docs/zh/DEPLOY.md)。

## 文件

| 文件 | 拓扑 | 一句话 |
|---|---|---|
| [`.env.home`](.env.home) | **T1** 家用主机 + IM | 主机绑 loopback、零公网暴露；成员私信 Telegram 机器人接入（IM 桥出站长轮询，**不需要内网穿透**）。 |
| [`.env.cloud`](.env.cloud) | **T2/T3** 云服务器 | 主机绑 loopback，Caddy 在 :443 终结 TLS 反代进来；过线防御三件套 + master key 挪出数据盘。IM 可选，与直连 IP 并存。 |

Caddy 模板已有两份现成的，**不在这里重复**：
- [`caddy/Caddyfile`](../caddy/Caddyfile) — docker-compose 蓝图用（域名走 `{$AIPE_DOMAIN}` 环境变量）。
- [`docs/zh/DEPLOY.md`](../docs/zh/DEPLOY.md) §C.5 — VPS 裸机用（带逐行注释 + WS 子域名）。

systemd unit + 防火墙规则 + 首启仪式（`mint-admin-token`）：[`docs/zh/DEPLOY.md`](../docs/zh/DEPLOY.md) §C.4 / §C.6 / §C.7。

## 三步上手

```bash
# T1 家用（macOS / Linux 家里电脑）
cp deploy/.env.home .env.local        # .env.local 已被 .gitignore — 真 token 放这安全
$EDITOR .env.local                    # 至少填 AIPE_TELEGRAM_BOT_TOKEN
set -a; . ./.env.local; set +a && pnpm host

# T2/T3 云服务器（VPS）
sudo cp deploy/.env.cloud /etc/aipehub.env
sudo $EDITOR /etc/aipehub.env         # 域名 + master key（从 secret 注入）
# 然后照 docs/zh/DEPLOY.md §C.4 起 systemd，§C.7 首启取 admin URL
```

> 安全提醒：这两个 `.env.*` 是**模板**，token / master key 字段留空。
> 真凭证放 `.env.local`（已 gitignore）或 systemd secret，**绝不**提交进 git。
