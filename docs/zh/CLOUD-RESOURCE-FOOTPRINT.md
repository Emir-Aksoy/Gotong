# 云端资源占用与容量估算 (飞书 + MiMo 单 hub)

> 面向把 Gotong 当生产后端跑在一台云主机上的运维。回答「现在吃多少、
> 跑起来要多少、该配多大的机」。
>
> 数据来源：2026-06-21 生产云主机实测（2 vCPU / 1.9 GiB RAM / 50 GB 盘，
> systemd 守护，飞书出站长连接 + 小米 MiMo `mimo-v2.5-pro` chat agent，
> 个人模式单 hub）。实测时服务已稳态运行 17.5 分钟，期间经历 1 次真实
> 飞书消息 dispatch + 1 次崩溃自愈重启。

---

## 一、一句话结论

**纯「IM 聊天 → LLM 回复」用法下，Gotong 自身极轻：稳态约 110–160 MiB
内存、近乎 0 CPU。一台 2 vCPU / 2 GiB 的最小云主机对个人到小团队绰绰有余。**
真正的扩展瓶颈不是这台机的算力，而是 **MiMo API 的并发/配额**——因为推理
跑在小米的服务器上，本机只做路由 + 网络 IO + 写文件。

---

## 二、实测基线（稳态，无并发压力）

| 维度 | 实测原始值 | 换算 | 说明 |
|---|---|---|---|
| 服务内存（systemd cgroup, `MemoryCurrent`） | 111 206 400 B | **106.0 MiB** | 含所有子进程的真实占用，最贴近「这个服务占了系统多少」 |
| 服务内存峰值（`MemoryPeak`） | 115 134 464 B | **109.8 MiB** | 自启动以来峰值（已包含一次 dispatch 期间） |
| 进程 RSS | 162 860 kB | 159.0 MiB | 含共享库映射，偏高口径 |
| 进程峰值 RSS（`VmHWM`） | 164 708 kB | 160.9 MiB | — |
| CPU 累计时间（`CPUUsageNSec`） | 1.511 s | — | 运行 1050 s 内 → **0.14% 平均占用** |
| 线程数（`TasksCurrent`） | 11 | — | Node 主线程 + libuv 线程池 + V8 |
| 打开的文件描述符 | 27 | — | 飞书长连接 + sqlite WAL/SHM + 监听 socket :3000/:4000 + 日志 |
| 系统 load average | 0.06 / 0.03 / 0.03 | — | 整机基本闲置 |
| 磁盘 — 代码+依赖（`app/`） | 223 MB | — | **固定**，不随使用增长 |
| 磁盘 — 数据（`data/`） | < 1 MB | — | transcript 24K / identity.sqlite 376K，随对话缓慢累积 |

**工程预算取值**：单 hub 实例按 **内存 ~160 MiB（留到 256 MiB headroom）**、
**CPU ≈ 0**、**数据盘起步 < 1 MB** 计。

---

## 三、为什么「跑任务」几乎不增本机资源

实测里 `MemoryPeak(109.8M)` 与 `Current(106.0M)` 只差 ~4M，而这段时间
**已经跑过一次真实 dispatch**。这不是巧合，是架构决定的：

```
飞书消息 ──▶ host(本机)
              │  ① 构造一个 task 对象（几 KB）
              │  ② 出站 HTTPS 调 MiMo  ◀─── 推理在小米服务器上，不在本机
              │     （本机在这里只是「等」——network wait，不占 CPU）
              │  ③ 流式收文本（几 KB ~ 几十 KB）写进缓冲
              │  ④ 写 transcript.jsonl + identity.sqlite 账本
              ▼
           回飞书
```

- **内存**：每个并发任务的增量 = 一个 task 对象 + 请求/响应文本缓冲 + V8
  临时对象 ≈ 单位 MB。10 个并发也就 +几十 MB。
- **CPU**：主要时间花在等 MiMo 返回（IO wait），不消耗 CPU。1.5 s CPU /
  17.5 min 运行 = 0.14%。
- **磁盘**：唯一**随时间单调累积**的维度（见 §五）。

> 换句话说：本机是「调度员 + 记账员」，不是「计算者」。计算外包给了 MiMo。

---

## 四、容量估算（按负载分档）

| 场景 | 典型用量 | 内存 | CPU(2 核) | 数据盘/年 | 2vCPU·2GiB 够吗 |
|---|---|---|---|---|---|
| **空闲** | 没人发消息，仅飞书长连接 keepalive | ~106 MiB | ~0 | ~0 | ✅ 大量富余 |
| **个人/轻度** | 几人，几十~几百条/天 | ~120–200 MiB | <1% | < 0.5 GB | ✅ 富余 |
| **小团队/中度** | 10–30 人，1–3k 条/天，偶发并发 5–10 | ~200–400 MiB | 个位数 % | 1–3 GB | ✅ 仍有富余 |
| **重度/多 agent** | 高频 + 常驻多个 LLM agent + 工作流并发 + 大上下文 / 挂 RAG·MCP 子进程 | 0.5–1 GiB+ | 视并发 | 数 GB+ | ⚠️ 接近上限，建议升 4 GiB |

> 估算前提：仍是「IM → LLM chat」为主。若引入**本机 compute**（本地嵌入
> 模型、本地 LLM、大量并行工作流编排），CPU/内存模型完全不同，需另算。

---

## 五、磁盘长期增长（唯一需要长期关注的维度）

每条「问 + 答」对话写入：
- `data/transcript.jsonl`：~1–3 KB/对话（JSON 行）
- `data/identity.sqlite`：用量账本 + 审计 + 绑定，~几百字节/对话

粗估上界：**1000 条/天 ≈ 2–4 MB/天 ≈ 约 1 GB/年**。

已内置的收敛机制（不会无限膨胀）：
- **transcript 段轮转 + archive/prune**（归档段剔出活跃加载，旧段可压缩/清理）
- **run 保留策略**（`runs/archive/` 剔出活跃扫描）
- **usage_ledger 保留策略**（超期归档/prune，但仍可导出做账）

上传多模态文件（`uploads/`）是另一条增长线，按实际文件大小计——纯文本
聊天不触发。当前生产盘 50 GB 用了 16 GB（其余系统服务），剩 32 GB，
Gotong 数据占用在可见的将来可忽略。

---

## 六、推荐规格与升级触发条件

**起步推荐**：**2 vCPU / 2 GiB RAM / ≥20 GB 盘**。
当前生产机（2c/1.9G/50G）实测仅占系统 ~5% 内存、~0 CPU，对个人~小团队
飞书 chat 用法**完全够用且大量富余**。

| 升什么 | 触发条件 |
|---|---|
| **内存 → 4 GiB** | 常驻多个 LLM agent；跑重工作流（多步并发 dispatch）；挂吃内存的 MCP 子进程（向量库 / RAG / Elasticsearch） |
| **数据盘 → 加挂/扩容** | 长期高频累积到数 GB；或大量多模态文件上传 |
| **CPU → 升核** | 仅当本机要做 compute（本地嵌入/本地 LLM/大量并行编排）；纯路由+IO 用法 2 核够 |

---

## 七、真正的伸缩瓶颈 = MiMo API，不是本机

要扩大用户量/并发，先看的不是这台机，而是 **MiMo 端**：
- MiMo 的 QPS / 并发上限 / 单 key token 配额
- host 侧已有 `usage_ledger` + 配额 fail-closed（pre-call peek），可观测
  token/成本并在预算耗尽时拦截——用它来做限流与成本护栏，而不是靠加机器

host 进程能轻松挂住几十上百个并发出站请求（都是 IO wait，本机几乎不增
负载）；天花板落在 MiMo 接受多少并发。

---

## 八、怎么持续监控（实测命令）

```bash
# 服务级资源账本（最准）
systemctl show gotong.service -p MemoryCurrent -p MemoryPeak -p CPUUsageNSec -p TasksCurrent

# 系统内存/swap + load
free -h; uptime

# 数据增长（重点盯 transcript / sqlite）
du -sh ~/gotong/data ~/gotong/data/transcript.jsonl ~/gotong/data/identity.sqlite

# 业务指标（Prometheus 文本，含 LLM 调用/token/成本/run 计数）
curl -s http://127.0.0.1:3000/metrics | grep gotong_
```

需要关注的早期信号：`free` 的 `available` 持续走低、`du` 的 transcript
快速膨胀、`/metrics` 里 `gotong_llm_*` 增速远超预期（可能是回环或滥用）。

---

## 附：实测环境

- 云主机：2 vCPU / 1.9 GiB RAM / 50 GB 系统盘（已被其它服务占 16 GB）
- 运行方式：systemd `gotong.service`（`Restart=always`，开机自启），
  Node 22 跑 `host/dist/main.js`，host 绑 `127.0.0.1`（admin 走 SSH 隧道）
- IM：飞书官方长连接（`@larksuiteoapi/node-sdk` WSClient，出站、免穿透）
- LLM：小米 MiMo `mimo-v2.5-pro`（openai-compatible，key 在 vault）
- 形态：个人模式单 hub，1 个 chat agent

> 实测口径会随用法变化。引入工作流、多 agent、多模态、MCP 子进程后，
> 按 §四/§六 重新评估。
