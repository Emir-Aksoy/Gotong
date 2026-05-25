# Reputation Routing(v4 Phase 5 E2)

跨 hub 任务派发时,本地 scheduler 怎么决定"在两个都能干活的 peer 中
优先选哪个" —— 答案是 reputation:**做过的 task 满意度高的 peer 排前
面**。

## 现状一句话

**E2 已经 done by composition,不需要新代码。**

- **M5b**(`@aipehub/core` 的 `ReputationStore`)做了
  feedback ledger 派生 + EWMA 累计 + `DefaultScheduler.dispatchCapability`
  按 score 降序排序。
- **D1**(`@aipehub/host` 的 `PeerRegistry`)做了 peer 表 → 活的 `HubLink`
  动态拓扑。

D1 的 `installPeerLink` 注册一个本地 wrapper participant,所有跨 hub
task 都从 hub.dispatch 进来,自动走 reputation-ranked 路径。
**两件事在 compose 时就生效了,不需要 E2 写新粘合代码**(原 v4
Phase 5 规划里 E2 是 "feedback ledger 派生 + dispatch 加权",这两半
M5b 都涵盖了)。

## 核心数据流

```
┌─ writeAuditLog / 自动写入 ─────────────────────────┐
│                                                       │
▼                                                       │
hub.feedback (FeedbackLedger,append-only)              │
│                                                       │
▼ onAppend / onRejected                                 │
hub.reputation (ReputationStore)                        │
│                                                       │
▼ scoreOf(peerId) ∈ [-1, +1]                           │
DefaultScheduler.dispatchCapability                     │
- 1. 按 capability 筛 candidates                       │
- 2. 按 reputation 降序排                              │
- 3. 同分按 least-loaded                               │
│                                                       │
▼                                                       │
runOne(task, chosen)                                    │
└── result 进入 transcript ─────────────────────────────┘
```

## EWMA 半衰

`ReputationStore` 用 exponentially weighted moving average:

```
score' = alpha * normalized_rating + (1 - alpha) * score
        where alpha = 0.3 (默认)
        normalized_rating = (rating - 3) / 2  ∈ [-1, +1]
```

含义:
- 一次满分 5 把 +1 加进来,但只有 30% 权重 → 单次评分不能把分数刷满
- 历史的 70% 拖底 → 一个稳定良好的 peer 抗 1~2 次低分的偶尔抖动
- "rejected" receipt(M7)走 `recordRejection` 路径,影响更重

## 跨 PeerRegistry 链路实验

**问:** D1 的动态 reconnect 会不会让 reputation 丢分?

**答:** 不会。reputation 是按 `peerId`(remote hub 的 wire selfId)
key,跟 `HubLink` 实例无关。一个 peer 断线 + redial,reputation 继续
累计。reputation 的状态落盘在 `<space>/feedback/reputation/<peerId>.json`,
host 重启后 `ReputationStore.rebuild` 从 ledger 重建一遍以防文件漂
移。

## 测试覆盖

`packages/core/tests/reputation.test.ts` 的 15 个 case:
- `ReputationStore` math (EWMA 半衰,unknown=0,rebuild)
- 持久化(`writeAfterEntry` / `rebuild` after restart)
- 集成:hub.feedback 写入 → scheduler 选 high-rep peer

E2 不再加新测试 —— reputation routing 在 M5b 时已经端到端跑通了,
D1 接入只是拓扑变化,reputation 调用面没动。

## 怎么验证我的部署在用 reputation

```bash
# 1. 看看 reputation 持久化目录
ls .aipehub/feedback/reputation/
#   hub_remote1.json
#   hub_remote2.json

# 2. 看看 ledger
tail .aipehub/feedback/outbound.jsonl

# 3. 跑一次跨 hub capability dispatch,查 hub log:
#   会有 "scheduler: dispatchCapability chose ..." 的 ranking 输出
```

低 reputation peer 不会被永久排除 —— scheduler 只是把它排在
"least preferred"的位置。在所有高分 peer 都断线 / 拒绝时,低分 peer
仍然会被尝试。这是个 graceful 退化策略,不是黑名单。

## 与 quota / federation 的边界

- **reputation**(本文件):**routing 偏好**,谁先被尝试。M5b/E2。
- **org-quota**(C2 + E1):**全局软上限**,跨阈值告警。
- **per-user quota**(B2):**用户硬上限**,超过就 deny。
- **federation ACL**(FED-M3):**安全策略**,谁不能调。

四个维度互不重叠:
- ACL 0/1 否决 → 决定 candidate set
- per-user quota 0/1 否决 → 决定 单 call 能否落
- org-quota 软上限 → 决定 audit 告警
- reputation 排序 → 决定 在多个 OK candidate 中先选谁

E2 关心的是最后一条 —— 已 done。

## 后续展望(暂不在 Phase 5)

- 把 reputation 暴露在 admin UI(只读 dashboard,谁分高谁分低)。
  目前只能 cat `<space>/feedback/reputation/*.json` 看。这是个
  C2 同类型的 UI,不阻塞核心逻辑,挪到 Phase 6。
- 区分 capability 维度的 reputation —— 现在是 per-peer 一个总分。
  实际上 peer 可能"写作擅长 / 总结烂",per-capability 分会更准。
  但 EWMA 切碎了,统计样本量更小,反而抖动 → 暂保持现状。
