# Agentic engineering —— 把 agent 拴住

> 源:[[raw/sources]] · 上级:[[index]] · 对照:[[vibe-coding]]

## 核心隐喻:leash(牵引绳)

[[vibe-coding]] 是放开绳子;**agentic engineering 是把绳子收短**。对要维护的软件,
Karpathy 的做法是让 agent 干大部分活,但**人始终在回路里掌舵**:

- **小步 diff**:一次一个小、具体、可审的改动。不接「一口气重写 5 个文件」的大 diff。
- **范围收窄**:把目标拆成边界清楚的小任务再交给 agent。模糊的大任务 = 跑偏。
- **测试当验证夹具**:测试是你「不读每一行也敢信」的依据。先有测试/验收点,再放 agent 跑。
- **紧反馈环**:生成 → 跑/审 → 修,循环要短。环越短,agent 越不会在错误方向上越走越远。
- **agent 是「快实习生」**:它快、不知疲倦,但需要**上下文 + 明确范围 + 复核**。给够
  context(规范、相关文件),它就强;让它猜,它就编。

## 80/20 迁移

Karpathy 描述自己从「大部分手写 + 自动补全 / 少量 agent」转向「**大部分 agent 写、
人审与掌舵**」。重点不是「不写代码」,而是**人的角色从打字员变成审阅者/架构师/把关
人**。把关质量(审、测、拒大 diff)成了核心技能。

## 反模式

- 盲接大 diff(= 退化成生产环境里的 [[vibe-coding]])。
- 没测试就放 agent 改核心逻辑。
- 一个超大模糊任务丢过去,期待它一次做对。

## 落到本 hub

- mentor **拆活**:起草(规划)派给 claude-code、实现派给 codex,每步小到可审。
- `PROGRESS.md` 是**交接棒 + 短反馈环**:动手前读、做完追加一行,下一个 agent 看得见上一步。
- `dangerousCommandGate()` 是「拴绳」的硬底线:危险命令(`rm -rf`/`git push`/`sudo`)
  在 CLI 还没 spawn 前就挂起等人批。

→ 手册:[[coding-with-agents]]。知识怎么沉淀:[[llm-knowledge-base]]。
