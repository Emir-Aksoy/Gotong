# 暂停快照 — 2026-09-03

> 这是 [`docs/zh/releases/`](README.md) 的第二篇,记的是项目**暂停时**的整体状态,给隔一段
> 时间回来的人(包括未来的自己)一个不用先啃账本的入口。上一篇是
> [2026-08-03 首篇快照](2026-08-03-project-state.md);两篇之间发生了什么见下面「这一个月」。
> 深挖细节一律链回专题文档与 [`../PROGRESS-LEDGER.md`](../PROGRESS-LEDGER.md)。

## 现在处于什么状态

- **暂停**:2026-09-03 用户决定「先把这个项目放着,过一段时间再继续」。不是放弃,是价值判断:
  当时摆在桌上的候选都不够大。
- **代码点**:`main` = `5452cfb2`,本地、GitHub、生产三处一致;工作树干净。
- **生产**:同一 commit 当日部署并验收通过(healthz 200 / 启动日志 error 级零条 / 三 agent 就位 /
  七个 sweep 上膛 / 看门狗正常),机器负载很低。基础设施细节不进公开仓库。
- **三大方向的 track 全部收口**,没有半截活。

## 这一个月做了什么(2026-08-03 → 09-03)

按三大方向([`../DIRECTIONS.md`](../DIRECTIONS.md),2026-08-21 钉死:T 工具 / M 记忆 / C 协作):

- **T**:HANDS 阿同的手(四档执行策略 + 工作区监狱)、LONG 长任务分段执行(M0→M6.3)、
  EFF 效果回路机制(M0→M3)、STOR 存储管家(M0→M4)。
- **M**:M-EVAL 写侧评测立尺(M0/M1,CI 门 `check:memory-write`)、记忆经济(M0→M5:整合尺 /
  联想网 / 记忆账 / 显著性 / 降温 / 写侧新颖门 / 万轮 capstone)。
- **C**:EXCH 交付物信封与多宿主技能包(M0→M5)、OpenAI 兼容面(M0→M3:非流式 / SSE /
  未改一字节的 SDK 客户端 capstone)。
- **维护**:dependabot 告警清零、方向纪律钉子、Codex harness 借鉴清单。

规模:36 个可发布包锁 `v4.0.0`;旋钮 114(冻结);73 个 examples;四门防腐 + 发布门全绿。

## 生产上默认开着 / 关着什么(恢复时先知道)

- **记忆经济**:写侧新颖门默认开(复述在写入时折进既有条)、显著性逐出默认开、降温挂在 6h
  维护 sweep;reconcile / librarian / links 三个 reviewer 是 opt-in。
- **存储管家**:清扫与轮转默认全关,保留策略文件缺席 = 全保留,不会自动删任何数据。
- **OpenAI 兼容面**:已上线;成员 key 今天只能由管理员经 admin 端点签发,管理面还没有按钮。

## 暂停时桌上有什么(用户已裁决,恢复时不要自作主张重提)

- **被判「当前价值不大」的三条**:记忆写侧秘密脱敏 + 注入防御(Codex 清单 #3)、工作区
  受保护名单堵 `.git/hooks`(Codex #1)、admin 面 `aipk_` 签发按钮 + Codex #12。
- **用户门**(等用户给输入才动):EFF-M4 首份真实档矩阵报告(要档位表 + key),其后排着
  RES 调节回路、LONG-M5 随档刻度、记忆节律随档;M-EVAL M2 真档;HANDS 上生产;EXCH-M4
  实机验证;WX M3b;embedder;真壳 SHELL(2026-08-02 起搁置)。
- **长期项**:微信小程序 / 其他原生入口。
- **小残余**:GitHub 默认分支一条 moderate 级 dependabot 告警(#60);启动日志一条老 warn
  (workflow-assistant 无 anthropic key 跳过注册,预期内)。

## 恢复时怎么接

1. 读根 `CLAUDE.md` 第三节顶部的暂停牌与最近里程碑,再读本文。
2. 先问用户想往哪个方向走(T / M / C)再开工;每个开发第一句说明方向。
3. 门禁:`pnpm -r build && pnpm -r typecheck && pnpm check:guards`;动了 examples 再
   `pnpm check:publish`;受影响的包跑 vitest。
4. 部署沿用既有 runbook:本机 bundle → 服务器 ff 拉取 → 数据快照 → 限内存串行 build →
   重启 → 验收(通用版见 [`../DEPLOY.md`](../DEPLOY.md))。
