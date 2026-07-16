/**
 * butler-tool-tiers.ts — AFR-M3. 阿同工具面的分层名单 = 防腐门的契约。
 *
 * 这份名单是「每新增 butler 工具必须显式登记落一等或目录」的登记表(镜像
 * env-registry 门的形状):工厂按 toolset 变量接线,防腐门
 * `tests/butler-tool-tiers.test.ts` 用真工厂把两种脸各拼一遍,与这里的名单
 * 双向核对 —— 加了工具不登记、登记了却没接、或把 governed 塞进目录,门都红。
 *
 * 分层规则(AFR-M0 §四 M2,基线数据见 ATONG-FRAMEWORK-RECOVERY.md M1 块):
 * 高频核心 + 全部 governed(+ agent 内建 memory)= 一等;低频 benign 长尾
 * = 目录(经 `list_tool_directory` / `use_tool` 按需取用,能力一件不减)。
 *
 * 三类钉在一等的理由,动名单前逐条想过再动:
 * ① 每轮/每天在用(任务笔记本 4 件、set_reminder、观察三读、派活、跑流);
 * ② **被一等工具的描述或探针卡点名**(模型会照着直调,名字不在脸上=指路指空):
 *    - `list_peers` ← ask_peer(governed)描述与错误文案点名 4 处;
 *    - `plan_workflow` ← create_workflow(governed)描述点名 2 处;
 *    - `set_onboarding_done` / `check_llm_key` ← CARE-M4 开箱陪跑卡正文点名;
 *    - `set_reminder` / (create_workflow) ← 任务笔记本工具描述的指路句。
 *    防腐门把这条升成结构性断言:一等/内建工具的 schema 序列化里不得出现任何
 *    目录工具名(use_tool / list_tool_directory 自身除外 —— 它们是门)。
 * ③ 发现入口不藏在发现背后(`list_my_capabilities` 是成员问「你能干嘛」的门面)。
 *
 * 动态 toolset(pool base 工具、MCP `<server>__<tool>`)不进本名单也不进目录:
 * 随部署变化、可运行中长新工具,与 AFR 边界③「快照静止」冲突,永远留一等。
 */

/** 一等 benign(高频核心 + 被点名钉住的):每轮直接在脸上。 */
export const BUTLER_FIRST_CLASS_BENIGN = [
  // workflows — 日常动词:看流/跑流
  'list_my_workflows',
  'run_my_workflow',
  // observe 三读 — 「怎么样了/用了多少」
  'list_my_runs',
  'list_my_agents',
  'my_usage',
  // 派活自己的 agent — 核心日常动词
  'ask_my_agent',
  // 被 ask_peer 描述点名(理由②)
  'list_peers',
  // 被 create_workflow 描述点名(理由②);建流主流程的前半步
  'plan_workflow',
  // 日常动词 + 被任务笔记本描述点名(理由②)
  'set_reminder',
  // 任务笔记本 4 件 — 复述卡每轮陪跑的执行伴侣
  'open_task_note',
  'update_task_note',
  'close_task_note',
  'list_task_notes',
  // 发现门面(理由③)
  'list_my_capabilities',
  // 被开箱陪跑卡正文点名(理由②);卡只在 onboarding 期出现,过后 schema 仍小
  'set_onboarding_done',
  'check_llm_key',
] as const

/** 目录 benign 长尾(一次性配置 / 低频自省 / 按需诊断):经 use_tool 取用。 */
export const BUTLER_DIRECTORY_BENIGN = [
  // 按需医生 — 出事才用,BE-M5 播报文案不点名(AFR-M5 面包屑走「问我怎么修」话术)
  'diagnose_my_agents',
  // LLM 自省/发现 — 低频同域一对(互相点名在目录内部,模式连续)
  'list_my_llms',
  'discover_llm_providers',
  // 手动记忆整理 — 罕用触发
  'consolidate_my_memory',
  // 一次性配置类 — 设一次用很久
  'set_reply_language',
  'set_daily_brief',
  'set_run_broadcast',
  // 隐私视图 — 偶发「你记得我什么」
  'show_my_memory',
  // AFR-M4 随身向导+医生 — 说明书型按需知识卡,长尾的第一租户
  'gotong_guide',
  // AFR-M7 恢复层只读 — 低频(「多久没备份了」);打包动作 pack_backup 是
  // governed,按规则全量留一等(它的描述不点名本工具,指路不指空成立)
  'backup_status',
  // SEN-M1 hub 体检只读 — 低频按需自省(「hub 现在正常吗」);尾卡探针文案
  // 刻意不点名它(指路指空原则),渲染里点名的 list_my_llms 同在目录内部
  'hub_health',
  // SEN-M3 自我状态一卡 — 低频按需自省(「你还好吗」);渲染里点名的
  // list_my_llms 同在目录内部(LSA-M1 先例,模式连续)
  'my_status',
  // SEN-M4 定时工作流成员向投影 — 低频(「每天早上自动跑什么」);渲染指路
  // admin 面板是人话不是工具名,描述零工具点名
  'list_schedules',
  // SEN-M5 成员名单 — 低频(「hub 里有谁」「审批指派谁」);岔口 A 全员可见
  'list_members',
] as const

export type ButlerFirstClassBenign = (typeof BUTLER_FIRST_CLASS_BENIGN)[number]
export type ButlerDirectoryBenign = (typeof BUTLER_DIRECTORY_BENIGN)[number]
