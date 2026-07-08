# butler-task-notebook — 弱模型也能跨轮把事办完(TN-M3 capstone)

任务笔记本(TN track)的核心论点一句话:

> 「在上下文里记住 5 步计划撑很多轮」需要强模型;
> 「读笔记本 → 做一步 → 勾掉」只需要小而有界的单步推理。

这个 demo 用**故意失忆**的脚本 provider 驱动**真** `PersonalButlerAgent` 把论点钉死:

- 每个成员轮都**全新构造** provider / 笔记本 store / agent(= 每轮都是重启);
- 记忆捕获关掉(`captureTurns: false`),frozen block 恒空 —— 没有记忆拐棍;
- 每个新轮的首次模型调用**只有 1 条消息**(demo 里有结构性断言)——
  没有任何跨轮会话被携带。

模型唯一的进度来源,是 agent 经 TN-M1 复述缝(`contextProbe`)注进 system prompt
的笔记本摘要(`【任务笔记本】… 下一步: …`)。就这样,一个 5 步使命跨 6 个独立
轮次完成。

## 四幕

1. **开任务** —— 「帮我筹备生日会」→ `open_task_note` 5 步落盘 `tasks.json`。
   开任务前的轮次 system 里**没有**笔记本卡(空笔记本 = prompt 字节不变)。
2. **失忆推进** —— 3 轮 ×(读摘要 → 做一步 → `update_task_note` 勾掉),
   进度走到 3/5;每轮断言摘要里的「下一步」正确。
3. **笔记本≠授权** —— 第 4 步「给宾客发邀请短信」是对外发送:写在笔记本里
   **不代表授权执行**。该轮 park 进 `/me` 审批;批准前断言**未发送、未勾步**;
   主人批准后同轮续跑,先执行、后勾步。
4. **收尾 + 静音** —— 最后一步勾完,工具结果提示收尾,`close_task_note` 归档;
   之后的轮次摘要消失,管家如实说「现在没有在办的事」。

## 运行

```bash
pnpm demo:butler-task-notebook
```

零前置:无 API key、无 host、无 identity。自断言,全部不变量成立才 exit 0。

## 对照生产

demo 里手写的三样东西,在生产 host 里全部由既有装配提供:

| demo 里 | 生产里 |
|---|---|
| `openTaskNotebook` + `contextProbe: () => notebook.digest()` | `personal-butler-factory.ts` 按成员接好(经 `composeContextProbes` 与 onboarding 卡合流) |
| 脚本 provider | 任意真 `LlmProvider`(Anthropic / DeepSeek / Ollama …) |
| `GovernedActionToolset` 内联审批 | 真 park → `/me` 收件箱 → `HostInboxService` resume |

另有 TN-M2:任务停摆 3 天,后台巡检(零 LLM 纯时间戳分诊)经 IM 轻声问一句
「要继续吗?」—— 只提醒,绝不代执行。见
[`docs/zh/BUTLER-TASK-NOTEBOOK.md`](../../docs/zh/BUTLER-TASK-NOTEBOOK.md)。
