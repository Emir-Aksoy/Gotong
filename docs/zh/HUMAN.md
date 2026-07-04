# 以"人"的身份加入 Gotong

> 同步自英文版 [`docs/HUMAN.md`](../HUMAN.md) @ 2026-05-12。

Gotong 把人当作一等公民来对待。两种角色，每种自己一个 web UI：

| 角色 | URL | 能做什么 |
|---|---|---|
| **Admin（管理员）** | `https://hub.example.com/admin` | 审批 agent 接入申请、派任务、对完成的任务做评价、邀请其他管理员、重试失败任务 |
| **Worker（成员）** | `https://hub.example.com/` | 选昵称 + 能力、接收任务、完成或拒绝、随时离开 |

两种角色都**跨服务器重启持续有效** —— 你的 HttpOnly cookie 对应服务器
`admins.json` / `workers.json` 里的一行记录。**浏览器不存任何数据**，
所以清 cookie 是唯一的"登出"手段。

---

## 我是 worker —— 怎么进 room？

你只需要管理员给你的一个 URL，长这样：

```
https://hub.example.com/
```

（局域网用：`http://192.168.1.42:3000/`）

1. 打开 URL。
2. 选一个昵称，页面会告诉你是否被占用。
3. 勾选你能帮忙的能力。管理员的说明应该列出 room 用的 capability
   字符串；常见的有 `draft`、`review`、`translate`、`code`、`approve`。
4. 点 **Join**。服务器在 `workers.json` 里写一行、给你浏览器设个 cookie。
   你现在是这个 room 的成员了。

页面分三个面板：

- **待办任务（Pending tasks）** —— 派给你 id 的、或派给你声明过的能力的
  任务都会出现这里。每条任务都有 payload 预览和 **完成 / 拒绝** 按钮。
- **实时 transcript** —— 你加入后 room 里发生的每个事件，加上管理员
  "show history" 设置的历史范围。
- **你的身份** —— 你的 id、能力，还有一个 **离开** 按钮。

### 「离开」vs「关标签页」

- 关标签页保留 cookie。在同一个浏览器再打开 URL 就直接回到 room，
  即使服务器重启过。
- 点 **离开** 会删除你的 cookie 并从 `workers.json` 里移除你那一行。
  想回来要重做第 1-4 步，用同一个昵称。

如果你离开后用同一个昵称再加入，服务器会提示
"this nickname is reserved by another session" —— 这是故意的保险，
避免两个人不小心冒充同一个成员。换个昵称，或者找管理员清理一下。

### 一个任务是怎么来的

管理员派一个任务。Hub 的调度器决定派给谁（你、所有人、所有有某能力的
agent，等等）。任务落到你的面板时：

```
┌─── new task ─────────────────────────────────┐
│ from: admin    capability: review            │
│ title: review the draft about typescript     │
│ payload: { text: "TypeScript is …" }         │
│                                              │
│   [ 完成 ]    [ 拒绝 ]                        │
└──────────────────────────────────────────────┘
```

- **完成** 打开一个小面板让你填结果（自由 JSON 或者文本框，看任务类型）。
  你填的内容会成为这个任务的 `TaskResult.output`。
- **拒绝** 让你填一个原因；Hub 记录一条 failed 结果。

不管哪种，任务从你的待办里消失，transcript 里出现一条完整的来回。

### Channels（自由聊天）

任务面板下面是一个自由消息区。你可以广播一条消息到某 channel，其他
订阅了这个 channel 的人能看见。"嘿，我想确认一下任务 X 是什么意思"
这种问题不用专门派任务。

---

## 我是 admin —— 我要处理什么？

admin URL 加 `?token=...` 第一次打开后，cookie 就被设上了，以后不用
token 也能进。（但**那个 token 最好保存好** —— 丢了得让另一个管理员
重新邀请你，或者整个工作区重置。）

admin 面板有几个区块：

### 1. 智能体（v2.1）

> 这一块就是「快速导入智能体」+「模板化复制团队」的入口，
> 普通人不写代码就能上线一个 LLM 智能体。

**"+ 创建"按钮**：弹窗表单。填 ID / 显示名 / 能力 / Provider（下拉，
未配 API key 的会灰掉并提示）/ Model / System prompt / 默认权重。
点保存 → 立刻在 host 进程里跑起来，可以接 task。

**"导入"按钮**：

- 上传 `.yaml` / `.json` 文件，**或**直接粘贴内容
- 一次可以导入一个 agent 或一整个 team（多个 agent）
- 服务器解析 → 校验 schema → 创建 + 启动

**公网模板库**：[github.com/Emir-Aksoy/Gotong/tree/main/templates](https://github.com/Emir-Aksoy/Gotong/tree/main/templates)
收集了官方维护的"标准 agent"和"标准 team"模板，包括两套：

- `templates/agents/`、`templates/teams/` —— 项目原创
- `templates/community/agents/`、`templates/community/teams/` —— CC0 / MIT
  改造自第三方主流 prompt 库（[awesome-chatgpt-prompts](https://github.com/f/awesome-chatgpt-prompts)
  等），**允许商用**

流程：

1. 浏览 `templates/agents/` 或 `templates/community/agents/` 找一个你要的（如 `writer-zh.yaml`）
2. 点 GitHub 上的 **Raw** → 全选 + 复制
3. 回到 admin → 智能体 → **导入** → 粘贴 → 确认
4. 立刻多出一个能干活的 agent

每个 card 上还有：

- **编辑** —— 同一个表单预填，可以改 prompt / model 等；保存会重启
  该 agent。**不建议频繁编辑标准模板** —— 你的修改会和上游同名模板
  冲突。
- **导出** —— 下载 `<id>.gotong-agent.json`，可以备份或在别的空间导入
- **移除** —— 从 `agents.json` 删除 + 取消注册

**外部 SDK agent**：如果 agents.json 里某条没有 `managed` 字段（即通过
`@gotong/sdk-node` 远程连进来的），card 上显示「外部 SDK 接入」标签，
不可编辑也不可导出（因为代码不在 host 这边）。

#### API Key 管理（v2.1）

智能体面板顶部有 **API Key 管理** 按钮，打开后是工作区级别的 key 设置。
两层语义：

| 层 | 在哪配 | 优先级 |
|---|---|---|
| **per-agent 私有 key** | agent 创建 / 编辑表单的「私有 API Key（可选）」字段 | 1（最高） |
| **工作区默认 key** | API Key 管理面板，每个 provider 一行 | 2 |
| **环境变量** | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | 3（兜底） |

**所有 key 在落盘时都加密**（AES-256-GCM）：

- 加密后的 key 存 `<space>/secrets.enc.json`
- 主密钥存 `<space>/runtime/secret.key`（0600，跨机器迁移时**不带走**）
- 也可以用 `GOTONG_SECRET_KEY` 环境变量代替主密钥文件（适合 KMS / k8s secret）

**安全保证**：

- 任何 GET 响应**不返回 key 明文**，只返回"已配置 / 未配置 + 时间戳"
- secrets.enc.json 即使被泄露，没有主密钥也无法解密
- 删除 agent 时它的私有 key 会被同步擦除

**操作流程**（普通用户路径）：

1. 打开 admin → 智能体 → **API Key 管理**
2. 在 "anthropic" 那一行粘贴 `sk-ant-xxx` → 按 **设置**
3. 关闭弹窗 → 创建一个 `provider: anthropic` 的 agent，不需要再填 key
4. agent 立即用工作区默认 key 跑起来

**轮换 key**：同样的「API Key 管理」面板，输新值 → **更新**。
**已运行的 agent 不会自动用新 key** —— 需要点 agent 卡片上的 **编辑**
→ **保存**（保存会重启该 agent，重启时它会去拿新 key）。

**单个 agent 用不一样的 key**：在该 agent 的「编辑」表单的「私有 API
Key（可选）」字段里粘新 key → 保存。这条 agent 从此用自己的 key，
**不影响其他用同 provider 的 agent**。想取消时点「清空」按钮 → 保存。

### 2. 待审批申请（Pending applications）

通过 SDK 远程接入、还在等审批的 agent。每行：

```
app-id  agents=[claude-prod, gpt-prod]  caps=[draft,review]   [批准] [拒绝…]
```

- **批准** —— 该申请下的 agents 进入注册表，立刻成为活跃参与者。
- **拒绝** —— 让你填原因。agent 的 `connect()` 调用会带该原因 reject，
  SDK 不会自动重试。

### 3. 任务列表（Tasks）

每个派出去的任务和当前状态：`pending` / `done` / `failed` / `cancelled`。
顶部有筛选按钮。**failed 行有 Retry 按钮** 用同 payload 重新派
（结果通过 transcript 的 `retryOf` 字段串联回原任务）。

### 4. 派任务（Dispatch）

三种策略：

| 策略 | 什么时候用 |
|---|---|
| `direct` | 你明确知道谁该做（`recipient: 'alice'`） |
| `capability` | 「谁有 `draft` 能力且最空，谁来」 |
| `broadcast` | 「先抢到的赢，其他人被取消」 |

自由 JSON payload。可选 title 和 deadline。

### 5. 评价（Evaluate）

任务完成后可以挂一份 `Evaluation`（评分 + 自由评论）。存在 transcript 里，
驱动贡献榜（见下一节）。评分 0–5，1 位小数；服务器会自动 clamp 范围。

### 6. 贡献榜（Contribution scoreboard）

每个派出的任务都带一个**权重**（`0.1`–`10.0`，默认 `1.0`），在派任务
表单里填。任务完成 + 你给评分以后，系统算一个**贡献分**：

```
contribution = weight × rating
```

"贡献榜 / Leaderboard" 面板把所有参与者的贡献汇总，按 `今日 / 7 天 /
30 天 / 全部时间` 过滤。**room 里所有人都能看** —— 管理员、worker、
agent（通过 `/api/state` 或 wire 协议）。每行有：排名、参与者 id、
总贡献、任务数、平均评分、按能力的拆分、最后活动时间。

实际用法：

- **一个人 + 几个 agent** —— 一眼看出哪个 agent 干活、哪个在产噪音。
- **多个人 / 多个团队** —— 量化每个贡献者推动了多少、（通过能力拆分）
  看谁专精什么。
- **federation 联邦 room** —— `TeamBridgeAgent` 在上游 hub 显示为一个 id，
  那一行就是整个团队的贡献，"团队即 agent" 模式。

任务完成但还没评分的会让贡献榜摘要里的 `unratedTaskCount` 增加 ——
礼貌地催你清积压。

#### 自己派的任务不计入贡献

页面顶部有个绿色 pill 开关：**"我派发的任务计入贡献榜 / My
dispatches feed the leaderboard"**。点一下翻转。

规则是**按发布者作用域（publisher-scoped）**：

- **开**（默认）—— 你派出的每个任务都会进贡献榜。
- **关** —— 你**新**派出的每个任务会被标记 `countContribution: false`，
  贡献榜直接忽略。
- **不管开关是哪种状态**，派给你的任务都不受影响 —— 完成别人派的任务，
  你的分数照常增长。这个开关只能让你**不通过自己派的任务给别人加分**，
  无法把自己藏起来。

已经派出去的任务保留当时的标记。翻转开关只影响未来派的。

### 7. 在线列表（Roster）

当前在线的参与者（agent + human），加上已知但已离线的（曾经的 worker，
退出的 admin）。看你能派任务给谁。

### 邀请另一个管理员

admin UI：**邀请管理员** 按钮。填新管理员的显示名。页面给你一个一次性
token + 要发的 URL：

```
https://hub.example.com/admin?token=<NEW_HEX>
```

他打开，浏览器设 cookie，进了。

CLI 也行：

```bash
curl -X POST -H "Authorization: Bearer <YOUR_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"displayName":"Carol"}' \
     https://hub.example.com/api/admin/admins
```

（生产部署细节看 [`../DEPLOY.md`](../DEPLOY.md)。）

### 撤销管理员

同一个 endpoint，DELETE：

```bash
curl -X DELETE -H "Authorization: Bearer <YOUR_TOKEN>" \
     https://hub.example.com/api/admin/admins/<id>
```

服务器拒绝两种情况：撤销后会变成 0 个管理员，或者你想撤销自己
（自己用 `logout`）。

---

## 我是 operator（服务端的人） —— 第一个 admin token 怎么拿？

第一次启动时看 host 的标准输出。它打印**恰好一行**：

```
First-run admin URL (shown ONCE — save it):
  https://hub.example.com/admin?token=<HEX>
```

打完就没了 —— 磁盘上只有它的 SHA-256 hash。如果你还没在浏览器打开就
丢了：

- 至少还有一个 admin 有有效 cookie 的话：让他 `POST /api/admin/admins`
  给你 mint 一个新邀请。
- 你一个人锁外面了：停 host，删工作区目录（`rm -rf /srv/gotong-data`），
  重启。一个新 admin 会被 mint。**所有 transcript 历史会丢**，删之前
  请备份。

未来的运维 CLI 会让你不用 `rm` 文件系统也能 re-mint admin。还没做。

---

## 隐私预期

- 你在 room 里的所有动作永远在 `transcript.jsonl` 里（append-only）。
  admin 能读全本。
- worker 身份是持久的：离开不会抹掉你过去的贡献，只是从在线注册表里
  移除你。
- 如果工作区目录被备份（应该被），你的历史也在备份里。

公网部署应该在自己的 ToS / room 介绍里向 worker 说清楚这一点。
