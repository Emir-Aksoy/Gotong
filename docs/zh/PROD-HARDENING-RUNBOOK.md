# 上线后加固 runbook（红/黄灯收口）

> 给**已经上线**的 Gotong 实例补齐 go-live 检查里剩下的红灯 + 黄灯。
> 这些都是**机器上的运维动作**——在你自己的服务器里执行，不是改代码。
> 本文用占位符（`<your-server>` / `~/gotong/...`），不写任何 IP / 密钥。
>
> 先决条件：实例已按 [`GO-LIVE.md`](GO-LIVE.md) 的 **T2（云 + IM 桥）** 跑起来，
> host 绑 loopback、admin 走 SSH 隧道、IM 桥出站长连接（飞书）、systemd
> `Restart=always` 守着。本文不改这套拓扑——loopback-only 不动、零公网暴露不动。
>
> Last updated: 2026-06-25

---

## 0. 安全总则（每步开工前读）

1. **先备份再动手。** 任何碰 master key / identity DB 的步骤（§3）开工前先跑一次
   全量备份并确认产物存在。备份脚本见 [`scripts/backup/README.md`](../../scripts/backup/README.md)。
2. **一次一步、每步验证。** 每个小节末尾都有「验证」——绿了再做下一步。
3. **master key 永不进 stdout / 日志 / git。** 下面凡是 dump key 的命令，输出只许进
   0600 文件或 systemd 环境，绝不 `echo` 到屏幕截图、不贴进聊天、不 commit。
4. **拓扑不变。** host 继续绑 `127.0.0.1`；这些步骤都不需要把任何端口暴露到公网。
5. 用到的占位符：
   | 占位符 | 含义（按你的部署替换） |
   |---|---|
   | `<your-server>` | 你 SSH 进去的主机（`ssh ubuntu@<your-server>`） |
   | `~/gotong/data` | `GOTONG_SPACE` 工作区目录 |
   | `~/gotong/gotong.env` | systemd `EnvironmentFile`（0600） |
   | `~/gotong/app/packages/host/dist/main.js` | host 入口 |
   | `NODE` | 机器上的 node 二进制（如 `/usr/local/bin/node`） |
   | `gotong.service` | systemd 服务名 |

   下面所有命令假定你已 `ssh ubuntu@<your-server>` 进了盒子。先把入口固定成变量，
   后续命令直接复用（**按你的真实路径替换一次**）：

   ```bash
   export GOTONG_SPACE="$HOME/gotong/data"
   export NODE="/usr/local/bin/node"              # 你的 node 路径
   export HOST_MAIN="$HOME/gotong/app/packages/host/dist/main.js"
   set -a; . "$HOME/gotong/gotong.env"; set +a  # 载入与 host 同款 env
   ```

   > 最后一行很关键：`mint-admin-token` / `rotate` 这类子命令必须读到和**运行中的
   > host 完全一致**的 `GOTONG_SPACE` / `GOTONG_HOST` / `GOTONG_WEB_PORT` / `GOTONG_COOKIE_SECURE`，
   > 否则印出来的 admin URL 指向错地方、或者打不开正确的工作区。

---

## 🔴 红2 — 第二管理员 + 恢复路径

**缺口**：首启那条 admin URL 只生成一次。如果它丢了（窗口关了、scrollback 没了、
那台机重装），而你又没有第二条入口，就再也进不去 admin 控制台了。

**机制**：host 自带 `mint-admin-token` 子命令——**不启动 Hub、不开监听**，只在
`admins.json` 里加一条新 admin、把一次性登录 URL 写进
`<space>/runtime/admin-link.txt`（0600，**不进 stdout**）。这既是「再开一个管理员」
也是「丢了链接怎么找回」的同一条路径。

### 步骤

```bash
# 在盒子里，已 source 过 env（见 §0）
"$NODE" "$HOST_MAIN" mint-admin-token "Recovery Operator"
```

输出会告诉你链接写到了哪：

```
  New admin 'Recovery Operator' (adm_xxx) added to ~/gotong/data/admins.json.
  Admin URL saved to (mode 0o600 — read once and delete):
    ~/gotong/data/runtime/admin-link.txt
```

取出链接（**只在 SSH 会话里看，别截图**）：

```bash
cat "$GOTONG_SPACE/runtime/admin-link.txt"
```

它形如 `http://127.0.0.1:3000/admin?token=...`。因为 host 绑 loopback，你在**本地**
开一条 SSH 隧道再用浏览器打开：

```bash
# 在你自己的电脑上（不是盒子里）
ssh -N -L 3000:127.0.0.1:3000 ubuntu@<your-server>
# 然后本地浏览器开 http://127.0.0.1:3000/admin?token=...
```

打开一次后，浏览器拿到的 **cookie** 才是后续登录用的凭证；URL 里的 token 在
`admins.json` 里只存哈希，链接文件删掉后无法从磁盘还原明文。

### 把「恢复路径」变成可重复的本子

把这条命令记进你的运维笔记（或盒子上一个 `~/gotong/RECOVERY.md`，**只在盒子里**）：

> 丢了 admin 入口 → SSH 进盒子 → source env → `mint-admin-token` → 读
> `runtime/admin-link.txt` → 隧道 + 浏览器打开 → **读完即删** `admin-link.txt`。

读完即删，保持工作区干净：

```bash
shred -u "$GOTONG_SPACE/runtime/admin-link.txt" 2>/dev/null || rm -f "$GOTONG_SPACE/runtime/admin-link.txt"
```

### 验证

- `admins.json` 里多了一条记录：`grep -c '"id"' "$GOTONG_SPACE/admins.json"`（数变多）。
- 用新链接 + 隧道能进 admin 控制台。
- 进去后**保留这第二个 admin**——它就是你下次丢链接时的备用入口。

> 反向代理 / 公网域名后面：印出来的 URL 里的 `127.0.0.1:3000` 要换成你的外部域名
> 再打开（token 部分照搬）。本 T2 拓扑是 SSH 隧道，直接用 `127.0.0.1` 即可。

---

## 🟡 黄4 — master key 移出数据盘（local-file → env provider）

**缺口**：identity vault 用信封加密——DB 里存的是被 master key（KEK）包裹的数据密钥，
secret 行用数据密钥加密。默认 KEK 是 `<space>/identity-master.key`（0600），**就躺在
数据目录里**。每日备份脚本已经排除了它（[`backup.sh`](../../scripts/backup/backup.sh)
明确不打包 master key），所以定时备份是安全的。**残余风险**是任何「整个数据目录的临时
拷贝」——一次手抖的 `tar czf data.tgz ~/gotong/data`、一条 `scp -r data/`、一个将来
忘了加排除的备份脚本——会把 KEK 和密文**一起**带走，信封加密就被抵消了。

**修法**：切到 `env` provider，让 KEK 住在数据目录**之外**（systemd 环境 / 凭证），
然后删掉 `data/identity-master.key`。这样工作区里只剩密文。

### ⚠️ 致命陷阱（务必看懂再动）

`env` provider 要的是把**现有这把 key 的 32 字节**重新喂回去（hex 编码），**不是**生成
一把新的随机 key。喂错——比如灌一把 `openssl rand` 的新 key——会让 vault 永远解不开
（DB 里的数据密钥是被**旧** KEK 包裹的）。

> `rotate-master-key` 子命令**救不了这一步**：它只支持 local-file→local-file，遇到
> env provider 直接 fail-closed 退出。把 local-file 迁到 env 是 provider 切换，不是轮换。

### 步骤

**① 先做一次全量备份**（§0 总则 1），确认产物存在再继续。

**② 把现有 key 文件 dump 成 64 位 hex**——用机器上**同一个 node** 读原始字节、输出 hex，
零编码歧义（这正是 env provider 解码时做的逆操作）：

```bash
KEYHEX="$("$NODE" -e 'process.stdout.write(require("fs").readFileSync(process.argv[1]).toString("hex"))' "$GOTONG_SPACE/identity-master.key")"
# 自检：必须正好 64 个 hex 字符（= 32 字节）。不对就停手。
printf '%s' "$KEYHEX" | wc -c    # 期望输出 64
```

> 别用 `cat`/`echo` 看 `$KEYHEX` 的值——它是 KEK 明文。上面只校验**长度**。

**③ 写进 systemd EnvironmentFile**（已经是 0600，和原 key 文件同一防护等级）：

```bash
# 追加两行到 env 文件；用 printf 避免把值回显到终端
{
  printf 'GOTONG_MASTER_KEY_PROVIDER=env\n'
  printf 'GOTONG_MASTER_KEY=%s\n' "$KEYHEX"
} >> "$HOME/gotong/gotong.env"
unset KEYHEX                      # 立刻从当前 shell 抹掉
chmod 600 "$HOME/gotong/gotong.env"
```

**④ 重启并验证 vault 仍能解密**（**先别删 key 文件**）：

```bash
sudo systemctl restart gotong
journalctl -u gotong -n 30 --no-pager | grep -i 'master key provider'
# 期望看到 source 为 env（而非 local-file）
curl -fsS http://127.0.0.1:${GOTONG_WEB_PORT:-3000}/healthz   # 期望 200 ok
```

进一步确认 secret 真能解开：进 admin 控制台，打开任意一个挂了 LLM key 的 agent，做一次
「测试连接」（体检面板 / agent 表单上的按钮）。**绿 = env provider 拿到的就是同一把
key、vault 完好。** 红或 boot 日志出现 `vault_decrypt_failed` = key 喂错了，**别删文件**，
回滚（见下）。

**⑤ 确认无误后，删掉数据盘上的 key 文件**：

```bash
shred -u "$GOTONG_SPACE/identity-master.key" 2>/dev/null || rm -f "$GOTONG_SPACE/identity-master.key"
```

现在工作区只剩密文；KEK 在 systemd env 里。

### 回滚（第 ④ 步验证不过时）

```bash
# 把刚加的两行从 env 文件去掉，退回 local-file（key 文件还在，没删）
sed -i '/^GOTONG_MASTER_KEY_PROVIDER=env$/d; /^GOTONG_MASTER_KEY=/d' "$HOME/gotong/gotong.env"
sudo systemctl restart gotong
```

因为第 ④ 步**没删** `identity-master.key`，回滚后 host 照旧用它启动，零损失。

### 诚实边界（单盘 VPS 的收益上限）

- 这一步的**确定收益**：工作区目录的任何临时拷贝（`tar`/`scp -r data/`/忘加排除的备份）
  从此只含密文，不再连 KEK 一起泄。
- 单盘 VPS 上，如果 KEK 就放在同盘的 `gotong.env`，一个**整盘快照**仍会同时抓到
  env 文件和密文。要做到「at-rest 也分离」，用 `systemd-creds`（下）把 KEK 加密落盘、
  运行时才解进 tmpfs。
- 真正的终局（KEK 完全不在这台盘上——KMS / 外部注入）属于显式推迟项，不在本轮。

### 可选增强：systemd-creds（at-rest 加密）

不想让 KEK 以明文躺在 `gotong.env` 里，可改用 systemd 加密凭证（用主机/TPM key 加密落盘，
启动时解进 `$CREDENTIALS_DIRECTORY` tmpfs）：

```bash
# 把 hex key 存成加密凭证（同样别回显值）
printf '%s' "$KEYHEX" | sudo systemd-creds encrypt --name=gotong_master_key - /etc/gotong/gotong_master_key.cred
```

然后在 service 的 drop-in 里 `LoadCredentialEncrypted=gotong_master_key:/etc/gotong/gotong_master_key.cred`，
并让 env 文件改成从凭证文件读（启动脚本里 `export GOTONG_MASTER_KEY="$(cat "$CREDENTIALS_DIRECTORY/gotong_master_key")"`）。
这步比直接写 env 复杂，按需采用；本轮把「写进 0600 env 文件」当默认达标线。

---

## 🟡 黄5 — 真实成员 IM 冒烟（飞书往返一条）

**缺口**：IM 桥（飞书）配好了，但没有人真的从飞书绑过号、走过一遍「发消息 → hub
派发 → 回复」。配置对不对，只有真往返一次才知道。

**机制**：成员在 `/me` 里签发一次性**绑定码**（`POST /api/me/im/binding-code`），到飞书
里把码发给 bot 完成绑定，之后发的消息就会被路由进 hub。你可以用**自己的飞书账号**当这个
冒烟成员。

### 步骤

1. **本地开 SSH 隧道**（同红2），浏览器开 `/me` 成员工作台并登录。

2. 在 `/me` 找到 **IM 绑定**区，点签发绑定码（前端会 POST `/api/me/im/binding-code`）。
   拿到一个短码（一次性、会过期）。

3. **在飞书里**，给你的 Gotong bot 发送绑定指令（按 [`IM-BRIDGES.md`](IM-BRIDGES.md)
   的约定，通常是 `/bind <码>`）。bot 回执「绑定成功」。

4. **发一条真消息**给 bot（比如对一个已发布、面向成员的工作流说句话，或直接跟你的
   助手 agent 聊一句）。确认：
   - 飞书里**收到了回复**；
   - admin 控制台 transcript 里能看到这条往返（派发 → 回复）。

5. 冒烟完，可在 `/me` 解绑（`/unbind`）或留着。

### 验证

- 飞书侧拿到非空回复 = 出站长连接 + 入站路由 + hub 派发**整条链路**通。
- transcript 有记录 = 审计侧也在。
- 任一步断了，对照 [`IM-BRIDGES.md`](IM-BRIDGES.md) 的飞书 setup（app 凭证 / 长连接订阅
  `im.message.receive_v1`）和 host 的 `startImBridges` env 闸排查。

> 这一步**必须**用真飞书账号在真盒子上做——hermetic 自测（FakeBridge）证的是路由逻辑，
> 证不了你这套飞书 app 凭证 + 网络出站是对的。

---

## 🟡 黄6 — 发布真实工作流（让 /me 目录非空）

**缺口**：盒子上可能有 agent，但没有**已发布**的工作流。`/me` 成员目录只列
`published` 状态的工作流（生命周期闸门），所以成员进去看到的是空目录、无事可做。

**机制**：两条路，挑一条。

### 路 A（最省事）：从模板画廊一键安装

模板画廊的导入走 **Model-B**——导入即发布 rev1，装完直接是 `published`。

1. admin 控制台 → **工作流** 面板 → **模板画廊** → 挑一个随框架附带的开箱模板
   （见 [`TEMPLATE-GALLERY.md`](TEMPLATE-GALLERY.md)）→ **一键安装**。
2. 装完它就是 published；`/me` 目录立刻能看到。

> 模板带的是结构 + 引用，不带知识内容 / 人员（决策 #4/#5）。KB 槽位只上报不自动接线——
> 要真用得起 RAG/笔记库，按 [`KB-CONNECTORS.md`](KB-CONNECTORS.md) 再接 MCP server。

### 路 B：手动发布一个草稿

如果你已经用「工作流架构师」或 YAML 导入造了草稿：

1. admin 控制台 → **工作流** 面板 → 找到那条草稿 → 走生命周期按钮
   **提交审核 → 发布**（后端 `POST /api/admin/workflows/:id/publish`）。
2. 想让成员能自助发起，确认工作流声明了 `surface.me.enabled`（见
   [`V4-PHASE14-FINAL.md`](./ledger/V4-PHASE14-FINAL.md)）。

### 验证

- admin 工作流面板里该工作流状态徽章是 **published**、带 `rev N`。
- `/me` 成员工作台的目录里能看到它，能发起一次跑通（结合 §黄5，从飞书发起更完整）。

---

## 🔴 红3 — 接监控告警（已就位，部署即可）

**缺口**：host 挂了 / 卡死 / 盘满时，没人收到通知。systemd `Restart=always` 能重启
**崩溃**的进程，但对**卡死**（在答又答不出）、**反复崩溃重启**、**盘满**无能为力——而且
host 内部的告警通道会**跟着 host 一起死**，恰好在你最需要被叫醒的时候哑掉。

**交付物已在仓库里**：一个**外部** cron 看门狗，从 host 进程**外面**探 `/healthz`，
状态翻转时推一条飞书告警。设计、部署步骤、调优全在
[`scripts/monitor/README.md`](../../scripts/monitor/README.md)。

### 在盒子上部署（摘要，细节见上面那篇 README）

1. 脚本随 repo 已经在盒子上：`~/gotong/app/scripts/monitor/healthcheck.sh`。
2. 建一个飞书**自定义机器人**（群里加），拿 webhook URL，存进 0600 文件：
   ```bash
   install -m 600 /dev/stdin ~/gotong/feishu-alert-webhook.txt <<<'https://open.feishu.cn/open-apis/bot/v2/hook/XXXX'
   ```
3. 薄包装 `~/gotong/healthcheck-cron.sh`（设 `FEISHU_WEBHOOK_FILE` + `GOTONG_WEB_PORT`，
   exec `healthcheck.sh ~/gotong/monitor-state`），`chmod +x`。
4. crontab 每 3 分钟：
   ```cron
   */3 * * * * /home/ubuntu/gotong/healthcheck-cron.sh >> /home/ubuntu/gotong/monitor-state/cron.log 2>&1
   ```

### 验证（端到端，别只装不试）

```bash
~/gotong/healthcheck-cron.sh                 # host 在跑时：静默、exit 0
sudo systemctl stop gotong
~/gotong/healthcheck-cron.sh                 # 应收到飞书「DOWN」+ exit 2
sudo systemctl start gotong
~/gotong/healthcheck-cron.sh                 # 应收到飞书「RECOVERED」+ exit 0
```

> 看门狗探的是 `/healthz`（liveness，活着就 200），不是 `/readyz`（readiness，启动
> 没完成前 503）——慢恢复中的 host 是「活着」的，不该被误报、更不该被重启。它**只告警
> 不重启**（重启是 systemd 的活，看门狗也插手会打架、掩盖抖动）。

---

## 收口检查表

| 灯 | 项 | 做法 | 验证锚点 |
|---|---|---|---|
| 🔴 红2 | 第二管理员 + 恢复路径 | `mint-admin-token` → 隧道打开 → 保留备用 admin | `admins.json` 多一条 + 能登入 |
| 🟡 黄4 | master key 移出数据盘 | dump 现有 key→hex → env provider → 删文件 | boot 日志 source=env + 测试连接绿 + 工作区无 key 文件 |
| 🟡 黄5 | 真实成员 IM 冒烟 | `/me` 签发绑定码 → 飞书 `/bind` → 往返一条 | 飞书收到回复 + transcript 有记录 |
| 🟡 黄6 | 发布真实工作流 | 模板画廊一键装（自动发布）或手动 publish | 状态徽章 published + `/me` 目录可见 |
| 🔴 红3 | 接监控告警 | 部署 `scripts/monitor/healthcheck.sh` + cron | stop/start 触发飞书 DOWN/RECOVERED |

全部点亮后，这台 T2 实例就从「能跑」升到「丢了入口能恢复、密钥不随手拷泄、IM 真往返
过、成员有事可做、挂了有人知道」。

---

## 仍显式推迟（本轮不做）

- **KEK 彻底离盘**（KMS / 外部注入）——单盘 VPS 上 env provider + systemd-creds 已达
  实用线，KMS 是 T3+/多机才划算的终局。
- **多管理员 RBAC 分级**——目前红2 给的是「再开一个等权 admin」当恢复冗余，不是细粒度
  角色；细粒度走 [`V4-PHASE19-P2-FINAL.md`](./ledger/V4-PHASE19-P2-FINAL.md) 的资源 RBAC。
- **告警分组 / 静默 / 升级链**（Alertmanager 式）——看门狗是「活/死」边沿单告警；
  业务级阈值告警走控制面 [`V5-F-FINAL.md`](./ledger/V5-F-FINAL.md) 的 peer-summary 通道。
- **自动重启 / 自愈**——本文只观察告警，重启权留给 systemd，避免和 `Restart=always` 打架。
