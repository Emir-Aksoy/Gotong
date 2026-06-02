# v5 · Stream 0 — hub 统一 + agent 即 owner（小结）

> 状态: **0-M1 完**（org→hub 心智收敛 + 统一 Principal 词汇）。0-M2（agent-as-owner
> 运行时 + `requires_human` 闸）落地后本文补「二·下」并翻 **Stream 0 完**。
>
> Last updated: 2026-06-01

---

## 一、为什么做（北极星缺口）

v4 的第一条架构决策是「**单 host = 单 org**」——对的，但它在代码里留下一个隐性包袱:
**「org」被当成一个独立实体在四处各说各话**。盘一下 v5 之前散落的「谁」枚举:

| 枚举 | 取值 | 位置 | 干嘛的 |
|---|---|---|---|
| vault `OwnerKind` | `user` / `org` / `peer` | `identity/types.ts` | 凭证归谁 |
| services-sdk `Owner.kind` | `agent` / `workflow-run` / `shared` / `user` / `org` / `peer` | `services-sdk/owner.ts` | 运行时附着域 |
| web `WorkflowActor` | `{userId, isOperator}` | `web/workflow-routes.ts` | RBAC 上下文 |
| `workflow_grants` 主体 | **仅 user_id** | identity v13 | 工作流授权 |
| protocol `ParticipantKind` | `agent` / `human` | `protocol/types.ts` | wire 层身份 |

问题不是「枚举多」，是**没有一个统一的「主体（principal）」词汇**——「谁能拥有 / 被授权
一个资源」每个子系统自己编一套。而 v5 的北极星（hub mesh 是**自由图不是层级树**，每条
link 独立 trust/policy）要求一件事:**owner 概念必须先 first-class、统一、能指向 agent**，
否则 Stream A（归属泛化）、Stream B（模板导出「谁的什么」）、Stream C（联邦按 owner scope）
全都没有共同的地基。

「org→hub 心智收敛」就是先把这块地基浇好:**承认 org 不是实体，hub 才是节点。**

---

## 二、心智收敛 — org 不是实体，hub 才是节点

事实核查（来自真代码）:**根本没有 `orgs` 表。** 「org」一直是个**隐式单例**——

- vault 里 `ownerKind='org'` 且 `ownerId IS NULL` = 「**这个 hub 自己**拥有的凭证」;
- `TaskOrigin.orgId` = 发起方 hub 的 self-id（联邦语境里「对面那个 hub」）;
- services-sdk 用 `ORG_SELF_ID = 'self'` 当「host 即隐式 org owner」的路径安全哨兵;
- `org_meta` KV 表只存一个 `org_mode = personal|team` 的 shell 模式开关。

把这些读到一起，结论很干净:**我们说的「org」从来就是「hub 自己」。** v5 不再假装它是
个独立东西——一个 hub **就是**它自己的 org，是 mesh 里的一个节点;节点之上能「拥有」东西
的主体只有四类:**hub 自己 / 它的成员（user）/ 它的 agent / 它连的 peer hub**。

> 这步是**心智 + 类型**的收敛，**零运行时改动**:vault 仍存 `('org', NULL)`，
> 只是统一词汇把它叫 `hub` 主体。没有迁移、没有 schema 变更、没有行为变化。

---

## 三、统一 Principal 词汇（0-M1 交付）

新模块 `packages/identity/src/principal.ts`——纯词汇 + 纯函数，无表无迁移:

```ts
export const PRINCIPAL_KINDS = ['hub', 'user', 'agent', 'peer'] as const
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number]
export interface Principal { kind: PrincipalKind; id: string }
```

四类主体:

- **`hub`** — hub 自己（昔日的 `'org'`）:hub 级 / 共享 owner，不绑某个成员。
  id 用具体 self-id，或 `HUB_SELF_ID = 'self'` 哨兵指「这个 hub」。
- **`user`** — hub 的人类成员。
- **`agent`** — hub 上的托管 agent。**v5 新增**——这就是让 agent 成为 first-class
  owner（0-M2）的那块拼图，agent 因此能拥有并运营一个自己的 hub。
- **`peer`** — 联邦 peer hub。

配套（全是纯函数，已测）:

- `principalKey(p) → "<kind>:<id>"` / `parsePrincipalKey(s)` — 单列存储编解码。
  Stream A 的 `resource_grants` 主体列**天生**就存这个 key，一个 TEXT 列装下任意主体。
  parse 对畸形 / 未知 kind **抛错**（fail-visible——坏 grant 行宁可炸也不能静默授权给
  错误主体）;只按**第一个** `:` 切分，id 里可含冒号（peer hub id）。
- `userPrincipal/agentPrincipal/peerPrincipal/hubPrincipal(id?)` — 可读性构造器。
- **org→hub 收敛就是这两个桥函数**:
  ```ts
  principalFromVaultOwner('org', null)  // → { kind: 'hub', id: 'self' }
  principalToVaultOwner({kind:'hub', id:'self'})  // → { ownerKind: 'org', ownerId: null }
  ```
  vault 一行不改，统一词汇通过桥进出。`agent` 主体故意在 `toVaultOwner` 抛错——vault
  今天没有 agent owner kind，把它当合法静默写进去比报错更糟（agent 凭证归属是 Stream A）。

从 `@aipehub/identity` 导出（type + 值两组）。

---

## 四、关键设计决策

1. **纯加性，零迁移**。0-M1 不碰任何表。`resource_grants`（决策点 #3 的单一通用表）是
   Stream A-M1 才建的;0-M1 只立**它将要说的词汇**。这样「心智收敛」可以独立 commit、
   独立验证，不和 schema 变更纠缠。

2. **agent 升格为 first-class 主体**。这是 v5 相对 v4 最实质的一步:v4 的 grant 主体只有
   user，agent 永远是「被调度的对象」。v5 让 `{kind:'agent', id}` 和 user 平起平坐，为
   0-M2「agent 拥有并管理 hub」铺路。但**权限边界另算**——见 0-M2 的受限子集 +
   `requires_human` 闸（决策点 #2:被 prompt 注入的 agent-owner 风险面太大，高危动作要人类二次确认）。

3. **不动 services-sdk 的 6-kind `Owner`**。那是**运行时附着域**（哪个 agent / workflow-run
   在读这个 secret），跟**主体级归属**（谁控制 / 付费）是两件事——vault 注释早就写明这点。
   Principal 是后者。两套故意不合并:合并会把「运行时作用域」和「所有权」搅在一起。

4. **`hub` 而不是 `org`**。统一词汇里这一类叫 `hub`，因为 v5 的节点就是 hub。`'org'` 这个
   字符串只活在 vault 的存储层（桥的另一侧）和 `TaskOrigin.orgId`（联邦 wire，对面 hub 的 id）。

---

## 五、测试 / 验证

- `packages/identity/tests/principal.test.ts`（13）:四 kind 枚举锁定、`isPrincipalKind`
  守卫（`'org'` 明确**不是** principal）、构造器、key 往返（含 id 内含冒号）、parse 对
  畸形 / 未知 kind 抛错、**vault-owner 桥 org↔hub 双向 + user/peer 直通 + agent 拒绝伪造**。
- `pnpm -C packages/identity build` clean;全量 identity 328 绿（+13，零回归）。

---

## 六、给后续流的接口（这块地基谁吃）

- **0-M2（下一步）**:`agentPrincipal(id)` 当 owner 主体 + 一张 `requires_human` 高危动作
  清单（改最高权限 / 加 owner / 删审计 / 改安全设置 需人类二次确认）。
- **A-M1**:`resource_grants(resource_kind, resource_id, principal, perm)`——`principal` 列
  = `principalKey()`;`perm` 复用并泛化现有 `WorkflowPerm` 梯子（viewer<editor<owner）。
- **A-M3**:凭证归属接 `principalFromVaultOwner`，per-user / per-agent key 自然落进同一词汇。
- **B / C**:模板导出「谁的什么」、联邦按 owner scope，都以 Principal 为单位。

---

## 七、不做 / 后续

- **agent-owner 运行时 + `requires_human` 闸** = 0-M2（本流下一里程碑）。
- **`resource_grants` 表本身** = A-M1（0-M1 只立词汇不建表）。
- **perm 梯子泛化**（`WorkflowPerm` → 通用 `GrantPerm`）= A-M1 真有第二个消费者时再做;
  0-M1 不为「将来可能用」提前重命名现有梯子。
- **vault 加 `agent` owner kind** = Stream A 凭证归属;在那之前 `principalToVaultOwner('agent')`
  显式抛错挡住误用。

---

## 八、一句话

**org 从来就是 hub 自己。** 0-M1 把这句话变成一个四类主体（hub/user/agent/peer）的统一
`Principal` 词汇 + 两个桥函数（vault `org` ↔ `hub`），纯加性零迁移——后面归属、模板、联邦
全部以它为单位。最实质的一步是 **agent 第一次和 user 平级成为可拥有资源的主体**。

详见 `packages/identity/src/principal.ts`。
