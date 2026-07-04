# 真机测试指南

> 这一篇专门回答：**"我把代码克隆下来了，怎么真的拿一个房间跑起来，
> 把人和 agent 都接上去试试？"**
>
> 三种使用强度都覆盖了：
> 1. **个人本机**（10 分钟，零 API key 也能跑）
> 2. **局域网 / 办公室**（半小时，可以让同事打开链接进来）
> 3. **公网 VPS**（一小时，给团队 / 客户使用）
>
> 想看英文版部署细节 → [`../DEPLOY.md`](../DEPLOY.md)。
> 本篇侧重"**真正点起来、跑通一次任务、看见日志、确认重启不丢数据**"。

---

## 0. 测试前的硬件 / 软件检查清单

|项目|要求|快速验证|
|---|---|---|
|Node.js|≥ 20（LTS Iron）|`node -v` → `v20.x`|
|pnpm|≥ 9.15|`pnpm -v`|
|Git|≥ 2.x|`git --version`|
|端口|3000（Web） + 4000（WS） 默认空闲|`lsof -i :3000 -i :4000` 没输出|
|API key（可选）|有 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`|`echo $ANTHROPIC_API_KEY \| head -c 8`|
|jq（看 demo 用）|≥ 1.6|`jq --version`|

> **没有 API key 也能跑！** 内置 `mock` provider 会原样回显任务文字，
> 用来跑通 dispatch / transcript / 评分 / 重启恢复这些**协作流**完全够。
> 想感受真 LLM 回答时再加 key 即可。

---

## 1. 个人本机 —— 10 分钟跑一遍

### 1.1 启动 host

```bash
git clone https://github.com/Emir-Aksoy/Gotong.git
cd Gotong
pnpm install
pnpm build
pnpm host
```

最后一条命令的输出大概长这样（**首次启动只显示一次** admin token，
记下来）：

```
=== Gotong host ready ===
Space     : .gotong
Web       : http://127.0.0.1:3000
WebSocket : ws://127.0.0.1:4000
Gating    : admin-approval
CookieSec : off (HTTP / dev)
HostCheck : disabled (loopback only is safe)

First-run admin URL (shown ONCE — save it):
  http://127.0.0.1:3000/admin?token=abcd1234…………
```

把这条 URL 复制到浏览器打开。Cookie 自动写好，以后访问
`http://127.0.0.1:3000/admin` 就不用 token 了。

> ⚠️ 没记住 token 也别慌：删掉 `.gotong/` 目录重启即可（会丢空间数据）。
> 或者用 `GOTONG_RESET_TOKEN=1 pnpm host` 重置 admin（保留其它数据）。

### 1.2 第一次"协作"—— 用 mock agent

进 admin 页面 → **智能体 → + 创建**：

|字段|填什么|
|---|---|
|ID|`echo`|
|显示名|回声 bot|
|能力|`echo`|
|Provider|`mock`|
|System|`Echo the task payload back as JSON.`|

保存。回到智能体列表，`echo` 标 "online"。

→ **派发 → +派发**：

|字段|填什么|
|---|---|
|策略|按能力 `echo`|
|Payload|`{"text":"hello Gotong"}`|
|权重|2.0|

派发完几百毫秒后，transcript 就有 `task_result`，output 是 mock 回显。

🎉 第一次跑通。这一步**没花一分钱、没用任何 API key**，
说明整个调度 / 派发 / 落盘 / 实时推送链路是通的。

### 1.3 把人接进来 —— 同一台电脑开两个浏览器窗口

1. 现在的浏览器留着 admin 窗口
2. **隐身模式**或另一个浏览器（Firefox / Edge）打开 `http://127.0.0.1:3000/`
3. 选昵称（如 `小李`），勾上 `review`、`approve` 能力 → 进入
4. 回到 admin 派一个 task，strategy 选 "按 id" → `小李`
5. 隐身窗口里立刻看到任务卡 → 点 **完成** 填一个 JSON 输出

转过去看 admin 的 transcript：你能看到从派发到 worker 完成的整条
事件流。`贡献榜` 上 `小李` 已经有 1 票。

### 1.4 把 anthropic / openai key 接上

按 `Ctrl-C` 停掉 host，重启：

```bash
ANTHROPIC_API_KEY=sk-ant-… pnpm host
```

打开 admin → 智能体 → 导入，把
`templates/teams/editorial-zh.yaml` 粘进来 → 两个真 LLM agent 就绪。
派一个 task（`{"text":"写一段关于秋天的开头"}`），几秒钟后看到
真模型回复。

> **想体验今天写的两个新团队？**
> 把 `templates/teams/traditional-industry-ai-enablement.yaml`
> 或 `templates/teams/admin-task-orchestration.yaml` 同样导入即可。

### 1.5 验证"重启不丢"

仍然 `Ctrl-C` 停 host，再 `pnpm host` 启起来。打开 admin：

- ✅ 之前导入的 agent 还在，online
- ✅ transcript 历史还在
- ✅ 贡献榜数据还在
- ✅ `小李`（worker）只要浏览器还在，cookie 没清，刷一下也回来

如果以上**有任何一项不在**，说明 `.gotong/` 目录被外部清了或者
启动参数指向了别的 space —— 排查重点是 `GOTONG_SPACE` 环境变量。

---

## 2. 局域网模式 —— 让办公室 / 教室 / 实验室同事接入

### 2.1 改个绑定地址

`Ctrl-C` 停 host，确认本机局域网 IP（macOS：`ipconfig getifaddr en0`，
Linux：`hostname -I | awk '{print $1}'`），假设是 `192.168.1.42`：

```bash
GOTONG_HOST=0.0.0.0 \
GOTONG_ALLOWED_HOSTS="192.168.1.42:3000,localhost:3000" \
ANTHROPIC_API_KEY=sk-ant-… \
pnpm host
```

> `GOTONG_ALLOWED_HOSTS` 是 CSRF 防护：派发 / 创建 agent 这类
> 改状态请求只接受 `Host:` 头匹配清单的请求。**不写它**就只允许
> loopback —— 局域网客户端会看到 403。

同事在自己电脑 / 手机浏览器打开 `http://192.168.1.42:3000/`，
按 1.3 的步骤选昵称 + 能力进入即可。

### 2.2 真机测试要走一遍的 4 个场景

1. **多人同时在线**：让 2-3 个同事都进来，admin 派 strategy=`humans`
   广播任务，看每个人收到 + 完成顺序。
2. **wifi 切换 / 断网重连**：让一个同事手机切到 4G 再回 wifi。
   worker SPA 自带轮询，应该 5-10 秒内重新同步状态。看右上角
   连接指示灯。
3. **手机端 UI**：admin / worker 两个面板都做了响应式，
   实地用手机打开过一遍，特别是任务卡的「完成 / 拒绝」按钮要好按。
4. **首次进入提示**：让一个完全没见过的同事进来，看他能不能
   30 秒内自己点进任务做完。**这是产品 UX 的真考试**。

### 2.3 防火墙没开端口的常见症状

|症状|多半是|
|---|---|
|本机能开，别人 timeout|3000 端口没在防火墙放行|
|页面打开但点 + 创建 agent 报 403|`GOTONG_ALLOWED_HOSTS` 没把客户端用的域名 / IP 加上|
|图标点了像点了，但没动静|后台 console 看 admin token 有没有失效；删 cookie 重 token|

---

## 3. 公网 VPS —— 给团队 / 客户用

> 详细 Caddy / systemd 模板看 [`../DEPLOY.md` §3 Public Internet](../DEPLOY.md#3-public-internet)。
> 这里只列**真机测试**时的关键检查点，方便照着勾。

### 3.1 上线前的安全清单（不通过不准放出去）

- [ ] `GOTONG_HOST=127.0.0.1`（让 Caddy / nginx 反代而不是直接暴露 3000）
- [ ] `GOTONG_ALLOWED_HOSTS=hub.example.com` —— 把对外域名写进来
- [ ] `GOTONG_COOKIE_SECURE=1` —— 配合 HTTPS，cookie 只走 https
- [ ] `GOTONG_GATING=admin-approval` —— **不要**改成 `open`（生产没必要）
- [ ] `GOTONG_ADMIN_RATE_MAX=10`（默认值就行，别关）
- [ ] **TLS 走 Caddy 自动 Let's Encrypt** 或 nginx + certbot
- [ ] `GOTONG_SECRET_KEY` 主密钥**离机备份**了
  （丢了就解不开 `secrets.enc.json` 里的 API key —— 看 `SECURITY.md`）
- [ ] `.gotong/` 整个目录在 systemd 配的 `WorkingDirectory` 之下，
  设了 cron 每天 rsync 到第二台机器或对象存储
- [ ] 测试过 **`kill -TERM <pid>`** —— host 会优雅 drain SSE 并退出
  （systemd 重启时不丢请求）

### 3.2 上线后真机测试的 6 个动作

```bash
# 1. 健康检查
curl -i https://hub.example.com/healthz
# 期望：200 OK, body: {"ok":true,...}

# 2. admin URL 真能访问
curl -i https://hub.example.com/admin
# 期望：302 → /login 或者直接 200（cookie 已设的情况）

# 3. WebSocket 端口（如果走 4000，反代要支持 WS 升级）
wscat -c wss://hub.example.com/ws  # 用 npx wscat
# 期望：连接建立后保持心跳

# 4. 真发一个任务
TOKEN=...  # 第一次登录抓 ?token=
curl -X POST https://hub.example.com/api/admin/dispatch \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"strategy":{"kind":"capability","capabilities":["echo"]},"payload":{"text":"ping"},"wait":true,"timeoutMs":10000}'
# 期望：{"ok":true,"result":{...}}

# 5. 重启服务，验证持久化
sudo systemctl restart gotong
curl https://hub.example.com/api/leaderboard -H "Authorization: Bearer $TOKEN"
# 期望：刚才的任务还在 totalTaskCount 里

# 6. 看日志没有泄露 token 或 key
sudo journalctl -u gotong -n 200 | grep -iE 'sk-(ant|proj)|token=|api[_-]?key'
# 期望：什么都没匹配到（admin URL 里的 token 是首次打印的那一次，
# 不应该在请求日志里反复出现）
```

任何一项不符合预期就**先别开放**，回到 `SECURITY.md` / `DEPLOY.md` 找原因。

### 3.3 上线 24 小时后回看

- 看 `.gotong/transcript.jsonl` 大小增速是否合理（一个普通 room
  通常每天 < 5 MB；如果某天突然 200 MB+，要查是不是有 agent 死循环）
- 看 `journalctl -u gotong` 里有没有 `[supervisor] respawn` 反复出现
  （某个 agent 一直崩；看是 API key 失效还是模型欠费）
- 看 admin 控制台「房间健康」卡片的 4 个数字符不符合预期
  （今日任务数、在线分布、未评分数、Top 3）

---

## 4. 用今天新加的两个团队跑一次"真活"

> 这里是**完整端到端例子**。建议至少做一遍以确认两个新模板真能干活。

### 4.1 例子 A：传统行业 AI 赋能梳理

**场景**：你帮一个开餐饮的朋友梳理"AI 能在他店里干嘛"。

1. admin → 智能体 → 导入 →
   粘贴 `templates/teams/traditional-industry-ai-enablement.yaml`
   → 6 个 agent 一次性上线
2. 派一个 task：
   - strategy：按能力 `intake`
   - payload：
     ```json
     {"text":"我开了三家粤菜小店，每家 6-8 个员工。每天最烦的是
     早上盘点蔬菜库存（30 分钟）、晚上对账（1 小时），还要在 3 个
     美团 / 大众点评 / 抖音平台分别回复评论。已经用美团商家版，
     没用别的工具。老板就是我，预算 1-2 万一年。"}
     ```
3. 拿到诊断师 4-7 个反问 → 你假装回答（在 payload 里把答案拼上去）
   → 再派 `ai-opportunity` 给机会扫描员 → 拿到 quick-win / mid /
   strategic 三档清单
4. 挑一条 quick-win → 派 `tool-recommend` 拿到工具横向比较表
5. 挑一个工具方向 → 派 `rollout-plan` 拿到 30 天甘特图 + KPI
6. 把方案发到 `risk-explain` 预演老板和员工的反对

**预期感受**：一个完全不会写代码的人，看完这条流水线的输出，
能对"AI 在我们这门生意上能不能用"有一个**接地气、能去找人聊**的判断。

### 4.2 例子 B：行政任务编排

**场景**：你是单位办公室主任，刚收到一份"周五前向 XX 局上报本部门
2026 上半年信息化建设进展"的口头通知。

1. admin → 智能体 → 导入 →
   粘贴 `templates/teams/admin-task-orchestration.yaml`
2. 派 `parse-brief`：把口头通知正文（你写下来）做 payload →
   拿到结构化 JSON
3. 派 `decompose`：input 是上一步 JSON → 拿到 WBS
4. 对 WBS 里的 external 节点逐条派 `contact-draft` →
   拿到邮件 / 微信 / 电话三种版本
5. 对 WBS 里的 internal 节点一次性派 `assign` →
   拿到一组可粘贴的 dispatch JSON（admin 在控制台逐条确认派发）
6. 接到子任务返回后 → 派 `track` 看进度
7. 全部完成 → 派 `report-write` 拿到正式报告
8. 派 `archive` 给文件元数据建议
9. **后续**：上面又来通知"同一批进展，要给市委办写一个简报，
   600 字内"→ 派 `restyle`，payload 含 `original_report` +
   `new_brief` → 几分钟出新版

**预期感受**：原来要花一两天的"接 brief → 派人 → 跟进 → 写
报告 → 归档 → 改口径"全套，Gotong 把里头**最体力活**的部分
（结构化解析、各种沟通稿、报告骨架、归档元数据、口径转化）
都吃掉了，行政人员只需要做**判断 + 跟真人沟通**。

---

## 5. 常见坑 / FAQ

**Q：我没装 jq，`scripts/demo-60s.sh` 报错怎么办？**
A：`brew install jq` 即可（macOS）。或者跳过 demo 脚本，手动按上面 1.2 走。

**Q：能不能不用 `pnpm host`，直接 `npx @gotong/host`？**
A：现在不行。**`npm publish` 已经从 v1.0 关键路径上下线**——见
[`.github/RELEASE-CHECKLIST.md`](../../.github/RELEASE-CHECKLIST.md)
"Distribution decision" 一节。两条支持的安装路径是：
（1）从源码 `pnpm install && pnpm build && pnpm host`；
（2）跨平台直接 `docker compose up`。

**Q：Anthropic 在国内连不上怎么办？**
A：① 用国内可用的模型，把 yaml 里 `provider` 改成 `openai` 并指向
代理 endpoint；② 或者完全用 `mock` provider 测协作流；③ 或者在本机
跑 Caddy 反代 https://api.anthropic.com。

**Q：能用 ollama / 国内大模型 / 自部署 LLM 吗？**
A：现在 host 自带的 provider 只有 anthropic / openai / mock。要接
ollama / 文心一言 / 通义千问 / DeepSeek 自部署模型，走 **外部 SDK
接入**路线 —— 用 `@gotong/sdk-node` 或 `gotong` (python) 自己写
一个 agent 实现，把 `handleTask` 里调你那边的 API。详见
[`../AGENT.md`](../AGENT.md)。

**Q：我能不能在没装 Node 的服务器上跑？**
A：可以用 Docker：`docker compose up`（仓库根有 `docker-compose.yml`），
持久化目录在 `./data`。

**Q：admin 把 token 弄丢了，怎么重新登录？**
A：① 如果浏览器 cookie 还在，直接访问 `/admin` 即可；
② 都丢了：登录服务器 → 找到 space 目录 → `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`
拿到一个新 hex → 改 `.gotong/admins.json` 里那一行的 `token` 字段 →
重启 host → 用 `?token=新值` 重新登录。**仅限你能 ssh 到服务器的场景**。

---

## 6. 把测试结果反馈给项目

如果你跑通了 / 跑挂了，欢迎用这两种方式回来：

- **跑通**：发个截图到 [Discussions](https://github.com/Emir-Aksoy/Gotong/discussions)
  「show what you built」板块，让别人也少踩坑。
- **跑挂**：开 issue，模板里照实填硬件 / Node 版本 / 出错日志，
  我们会优先处理"按指南走但跑不起来"的报告 —— 这种 bug 价值最高。

> 改了 host 代码 / yaml 模板想自己提 PR？先跑一遍
> `pnpm -r typecheck && pnpm test:all` 验证整个工作区是干净的。
