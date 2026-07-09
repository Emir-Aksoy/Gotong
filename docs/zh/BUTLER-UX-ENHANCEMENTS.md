# 管家使用感受增强 track(UX)—— 让常驻管家更「懂当下」

> 北极星第 1 层「我的 AI 桌面」的体感抓手:管家反应式 tool-loop 的骨架已经稳,
> 但它每轮开口时对「当下」几乎一无所知 —— 不知道现在几点、多久没聊了、用户想用
> 哪种语言、这条消息从哪个渠道来、自己到底能帮上什么、早报能不能带上真实的天气
> 日程。这个 track 一样一样补,全部**零内核改动、零新 env 旋钮**。
>
> Last updated: 2026-07-08 · **全完**(时钟 + A1→A4 + B1 + B2 共 7 commit)。

---

## 一、为什么(缺口)

管家是**纯反应式的有界 tool-loop**:一条 IM = 一个 Task = 一轮工具循环。它的系统
提示 = `[冻结记忆块] + [人格] + [每轮 contextProbe 尾卡]`。冻结块是 prompt 缓存
前缀,**必须逐字节不变**;一切随每轮变化的东西只能骑**尾缝**(`composeContextProbes`)。
在这个 track 之前,尾缝只有 CARE-M4 的开箱现状卡 + TN 的任务复述卡 —— 管家对「此刻」
的其它维度全是盲的:

- 问它「现在几点」答不上来(用户实测)。
- 半夜隔了 8 小时再聊,它像刚才还在聊一样直接接话。
- 三语用户(中/英/土)每轮得靠模型猜该用哪种语言回。
- 在 Telegram 聊天窗里甩一张 Markdown 表格 —— 桥全是纯文本送达,显示成一堆 `*` 和 `|`。
- 用户问「你能帮我做什么」,弱模型要么漏说要么**虚报没接上的功能**。
- 早报只会用记忆里的旧事实,带不上今天真实的天气/日程。

对**弱模型**这些缺口尤其疼:它不会自己推断当下语境,喂给它 = 把认知负担从模型搬到
确定性的注入。

## 二、四条不可破边界(全程守住)

1. **热路径零 LLM**。A 系列(时钟/间隔/语言/渠道)全是**纯拼字符串**的尾卡,每轮
   零模型调用;B1 是纯目录渲染;B2 复用早报**本就唯一**的模型调用(不新增热路径
   LLM),且只读不写、硬上限 3 轮。
2. **冻结块字节不变**。所有随轮变化的内容只走尾缝;不注入时返回 `null` = prompt
   逐字节和今天一致(「能力」不是「行为分叉」)。
3. **数据离盒 opt-in**。B2 默认关;开启才让早报调外部连接器,连接器安装时的
   `dataLeavesBox` 披露仍在。A 系列全在盒内。
4. **内核零改动**。core/workflow/protocol/identity 一行不动;全部落在
   `host` / `personal-butler` 层。旋钮**仍 107**,`main.ts` 顶格 3000/3000。

## 三、设计(复用既有的两条缝)

- **contextProbe 尾缝**(A0 时钟 / A1 待办 / A2 间隔 / A3 语言 / A4 渠道):每个探针
  是 `(task) => Promise<string | null>`,非空卡用 `\n\n` 拼进系统提示尾。探针**自门控**
  —— 不该注入就返回 `null`。A4 是第一个真正**读 `task`** 的探针(平台在 `task.from`
  里),其余读每用户小文件或纯 `Date`。每用户状态放在记忆树的**兄弟目录**
  (`presence/`、`prefs/`)而非记忆树内,免得搅动 MU-M5 的 opt-in git 快照。
- **benign 派生工具**(A3 `set_reply_language` / B1 `list_my_capabilities`):和
  `set_reminder` 同类(只影响你自己,无需审批闸),始终提供。B1 的清单**从真实已装
  工具集派生**(工厂把最终 benign+governed 的工具名懒喂给它),漏报是安全失败、
  虚报不可能发生。

## 四、六个特性

### 时钟(A0)—— 当前时间感知(`21ae15f`)
`packages/personal-butler/butler-clock.ts`:每轮注入「当前时间」卡(`Intl.DateTimeFormat`
+ `longOffset` + UTC 锚点,坏时区兜底 UTC),**永远非空**(知道「现在」是助手的底线)。
时区默认跟部署环境的 `TZ`(生产机 Asia/Shanghai +0800 = 马来西亚正确时间,故不加
TZ 旋钮)。

### A1 —— 待办审批提醒卡(`ba5aecb`)
`personal-butler-pending.ts`:读成员 /me 收件箱里**还等他本人确认**的 park 项(审批/
选择/修改),注入「用户还有 N 件事在等你」。只读投影(源自 `HostInboxService`),空则
`null`。最多列 3 件,超出说「还有 N 件未列出」。

### A2 —— 时段问候 + 上次对话间隔(`ee1c4ef`)
`personal-butler-last-seen.ts`:每用户 `presence/last-seen.json`。首次接触 = 无卡
(招呼归 onboarding);间隔 **< 3h** = 活跃对话不重复招呼;≥3h 才注入「现在是<时段>,
距上次约<间隔>」+ 自然招呼提示(时段按本地小时分深夜/早上/中午/下午/晚上)。每轮
best-effort 落盘当前时间。

### A3 —— 成员语言偏好(`cdf4c09`)
`personal-butler-language.ts`:`set_reply_language` 工具写每用户 `prefs/reply-language.json`
(空值清除);探针在设了偏好时注入「用<语言>回复」。没设 = 不注入 = 跟着用户当下的
输入语言走。三语用户不再每轮靠猜。

### A4 —— 来源渠道感知(`889b09e`)
`personal-butler-source.ts`:从 `task.from`=`im:<平台>:<uid>`(或 `title`=`im:<平台>`)
解析平台,注入「本条来自<平台>聊天窗,回复以纯文本送达,别甩表格/堆叠 Markdown/长代码块」。
六个桥(Telegram/飞书/Slack/Discord/Matrix/QQ)**全是纯文本送达**,故这条指引是硬事实
不是猜测。走 web /me 控制台(能渲染 Markdown)则无 `im:` 任务 = 无卡 = 完整格式照旧。

### B1 —— 能力发现卡 / help(`dde3355`)
`personal-butler-capabilities.ts`:`list_my_capabilities` 工具,清单**从当前真实接上的
工具派生**。工厂把最终 benign+governed 工具名的懒 getter 喂给它;只有信号工具在场的
能力才列出,MCP 连接器按 `<server>__<tool>` 前缀点名(去重、不逐个列)。governed 项
标「需你确认」诚实交代审批闸。无 member 面向工具时也诚实答「现在主要陪你聊天」。

### B2 —— 晨报增强(`04776b0`)
早报本就是**唯一一处**跑管家模型的地方(`composeBrief`,原本单次无工具、只吃记忆事实)。
B2 给它加一道 `set_daily_brief` 的 `enrichWithConnectors` 开关(**默认关**):开了,早报
就跑一个**有界只读 tool-loop**(镜像 LlmAgent 循环,硬上限 3 轮、单结果截断)调管家
连接器的 **benign 读工具**(天气/日历/新闻),把真实数据自然融进问候。WRITE 半是会 park
的 governed 闸,**绝不**交给无人值守的 sweep —— 早报能看不能动。连接器挂了 / 解析不到 /
开关关 全部退回历史单次无工具路径,逐字节一致;工具抛错变 isError 结果模型自愈,SKIP
仍表示保持沉默。

**授权岔口(用户 2026-07-08 拍板 = 早报级开关)**:「装了连接器」授权的是聊天里**按需**
查;「早报每天自动外呼 provider」是更强的授权,故单独设一道默认关的开关,而非连接即授权。
落在项目 opt-in 法则上。

## 五、验收

- `personal-butler` 全绿;`host` **1993** 全绿(A1 9 · A2 14 · A3 8 · A4 9 · B1 8 · B2 8,
  外加时钟 8+3)。
- 四门 PASS:旋钮 **107**(零新增)、`main.ts` **3000/3000**(每次 host 增行靠压注释
  净零)、内核依赖方向不变。
- B2 的 pool 缝 `LocalAgentPool.butlerMcpReadToolset()` 镜像 `buildButlerProvider`
  (找 butler 行 → 取其活 MCP → 按工厂同法切读半),`armButlerSweeps` 把 resolver 穿进
  composer,sweeper 把每成员 `enrich` 从已读的 config 转下去(不二次读盘)。

## 六、相关文档

- 管家骨架:[`docs/zh/ledger/PERSONAL-BUTLER-FINAL.md`](ledger/PERSONAL-BUTLER-FINAL.md)
  · [`docs/zh/ledger/PERSONAL-BUTLER-FOLD-IN-FINAL.md`](ledger/PERSONAL-BUTLER-FOLD-IN-FINAL.md)
- 增强观察面 + 诊断闭环:[`docs/zh/ledger/BUTLER-EMPOWER-FINAL.md`](ledger/BUTLER-EMPOWER-FINAL.md)
- 任务笔记本(同属管家层、同用 contextProbe 尾缝):[`docs/zh/BUTLER-TASK-NOTEBOOK.md`](BUTLER-TASK-NOTEBOOK.md)
- 早报所在的定时/主动机制:[`docs/zh/WORKFLOW-SCHEDULES.md`](WORKFLOW-SCHEDULES.md)
- B2 连接器所在的接入面:[`docs/zh/REAL-LIFE-CONNECTORS.md`](REAL-LIFE-CONNECTORS.md)
