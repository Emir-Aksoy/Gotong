# surface 模式 · 给框架加一块能力而不加一条耦合

> 一句话：一块能力跨 `host` ↔ `web` 边界时，走的是一个**窄的、鸭子类型的
> `*Surface` 接口**——web 侧**只 import 类型**，实现由 host 在装配时**注入**。
> 于是 `web` 始终**不依赖 `host`**，却能调 host 的一切能力。
>
> 这是北极星第三条「协议 / 凭证 / 配额都有显式边界、Hub is dumb on purpose」在
> **呈现层**的样子。想给 admin / `/me` 加一块新能力（一个新的只读投影、一个新的
> governed 动作），照这一页的配方走。

---

## 承重事实：web 不依赖 host

`@gotong/web` 的运行时依赖只有三个：

```jsonc
// packages/web/package.json
"dependencies": {
  "@gotong/core":     "workspace:*",
  "@gotong/protocol": "workspace:*",
  "yaml":              "^2.6.0"
}
```

**没有 `@gotong/host`**——deps 里没有，devDeps 里也没有。可 `web` 却调得到工作流
架构师、上传、setting 运维台、收件箱、管家记忆…几十块只住在 host 里的能力。这不矛盾：
这些能力**不是被 import 进来的，是被注入进来的**。`web/src/server.ts` 里出现了 131 处
`Surface`——全是**只 import 类型**（`import type`），运行时一个 host 符号都不碰。

方向很清楚：**`host` 依赖 `web`**（构造 surface、调 `serveWeb`），**`web` 不依赖
`host`**。箭头单向，web 永远是那层「哑」的渲染 + 路由。

---

## 一个 surface 的三段生命

以「工作流架构师」为例，端到端就三步：

**① host 定义一个窄接口**（只列 web 路由真正要调的方法）
[`packages/host/src/workflow-assist-agent.ts`](../../packages/host/src/workflow-assist-agent.ts)：

```ts
/** Duck-typed surface the Web layer consumes via `ServeWebOpts.workflowAssist`. */
export interface WorkflowAssistSurface {
  assist(input: { description: string; by: ParticipantId; /* … */ }): Promise<{
    yaml: string; draftStatus: string; explanation: string /* … */
  }>
}
```

**② web 声明「我需要这么一块」**（类型，可缺省）
[`packages/web/src/server.ts`](../../packages/web/src/server.ts)：

```ts
export interface ServeWebOpts {
  // …
  workflowAssist?: WorkflowAssistSurface     // ← 只 import 类型；缺省 = 该路由 503/禁用
}
```

web 路由从 ctx 取 `workflowAssist`，为空就优雅降级（返回 503 / 显示禁用），不为空就调
`.assist(...)`，把抛错翻成 HTTP 500。web 不知道背后是 LLM、是 mock、还是别的——**只认这个契约**。

**③ host 在装配时注入具体实现**（带真依赖 + 审计绑定）
[`packages/host/src/main.ts`](../../packages/host/src/main.ts)：

```ts
const web = await serveWeb(hub, {
  workflowAssist,     // ← 这里塞进 host 构造好的真实现（连着 hub / provider / 配额闸）
  uploads,
  settingOps,
  // …几十块 surface
})
```

谁拥有凭证、配额、审计绑定？**host**。谁负责渲染和路由？**web**。surface 就是这条分工线
上那个窄窄的、可单测的、可替换的接缝。

> 两种子形态、同一个模式：多数 surface 由 host 定义、web 经 `ServeWebOpts` 消费（如
> `WorkflowAssistSurface`）；少数由 web 定义、host `import type` 后实现（如
> `UploadSurface`，host 写 `import type { UploadSurface } from '@gotong/web'`）。**类型
> 走哪个方向不重要，重要的是跨缝只走类型、实现靠注入。**

---

## 给它加一块新能力（配方）

想让 admin / `/me` 多一个动作（比如「导出我的某某」）：

1. **定义 surface**：在 host 写 `interface FooSurface { doFoo(input): Promise<Out> }`——
   **只放** web 路由要调的那几个方法，别把 host 内部依赖泄进签名。
2. **web 声明 + 消费**：`ServeWebOpts.foo?: FooSurface`，穿进 route ctx；路由里 `if
   (!ctx.foo) return 503`，否则调它，抛错翻 HTTP。
3. **host 注入**：在 `main.ts` 构造 `FooSurface` 的具体实现（这里才碰真凭证 / 真配额 /
   审计），`serveWeb(hub, { foo })` 塞进去。
4. **权限落既有闸**：surface 只是通道。**写操作要么走既有审批闸（governed →
   `/me` 收件箱），要么就是本人只读投影**——不要在 surface 里新造一条绕过治理的写路径。
   （这正是管家能观察却动不了成员做不到的事的同一条硬约束，见
   [`ledger/BUTLER-EMPOWER-FINAL.md`](ledger/BUTLER-EMPOWER-FINAL.md)。）

配方之外一步都不用：没有新依赖、没有 web→host 的耦合、没有全局单例。缺省 = 该能力优雅缺席。

---

## 为什么值得这么严

- **web 可独立编译 / 独立测**：不背 host 那 30+ 依赖，SPA + 路由自己能跑测。
- **能力可替换 / 可 mock**：测试塞一个假 surface 就能测路由；prod 塞真的。host E2E 正是这么做的。
- **边界诚实**：凭证 / 配额 / 审计永远在 host 手里，web 结构上碰不到——不是靠自觉，是靠
  依赖图。这跟「Hub 只路由、决策在参与者」是同一种克制。

---

## 接着读哪

- 框架模块边界总览：[`ARCHITECTURE.md`](ARCHITECTURE.md)
- 扩展面本身（写一个 Participant）：[`PARTICIPANT.md`](PARTICIPANT.md)
- 例子分级索引（哪个 demo 先跑）：[`EXAMPLES.md`](EXAMPLES.md)
- 只读投影 / governed 写闸的活体样例：[`ledger/BUTLER-EMPOWER-FINAL.md`](ledger/BUTLER-EMPOWER-FINAL.md)
