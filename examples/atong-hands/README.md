# atong-hands — 一双手,和它够不到的每一样东西

阿同执行能力 track(HANDS)的 capstone。这条 track 给阿同装了一双真手:它能在
工作区里写文件、跑命令、装依赖,还能在手机上给自己换 API key。而整条线上唯一
值得反复证明的事情**不是**「它能跑命令」——是**它跑命令的时候够不到什么**。

威胁模型只有一句话:**一次成功的 prompt injection 就是一次远程代码执行**。所以
每一条能力都必须能指着一道结构性的墙说「这里过不去」,而不是指着一段 prompt 说
「我们叮嘱过它别这么做」。

```bash
pnpm demo:atong-hands   # 零网络、零 API key、零 LLM,exit 0 即全过(36 条断言)
```

## 四幕(外加一幕布景)

| 幕 | 证什么 | 硬断言 |
|---|---|---|
| 0 布景 | fail-closed 是地板不是兜底 | 监狱缺席 ⇒ `armButlerHands` 根本不返回 host(五件工具一件也造不出来),`my_status` 那一行如实说「没装」并说清原因;查不到成员角色 ⇒ 同样不装 |
| 1 注入写配置 | **两层各拒一次** | 层一:写工作区外的路径 → 策略层当场 `refuse`,execute 一步没跑;层二:同一个念头改走 shell(策略层按设计 `allow`)→ **控制组先证明这条重定向本身通**(写进工作区成功)→ 写 `<space>` 失败 → `agents.json` 逐字节不变 |
| 2 联网 park | 批准前零执行 | `net:true` ⇒ classify 判 `approve` 且带得上理由;**批准之前盘上零痕迹**;人点头之后在监狱里真跑完、产出落在工作区 |
| 3 工作区自留地 | 有手 ≠ 什么都能碰 | `hands_write` tier 1 不 park、文件逐字节落盘;`node test.js` 在监狱里真跑出 `TESTS PASS`;**控制组先证明 `cat` 在这座监狱里读得出东西** → 同一个 `cat` 读 `<space>/gotong.env` 读不到那把 key |
| 4 `/setkey` | 秘密只到金库 | 真 `parseImCommand` → 真 `ImCredentialsService` → 真 `@gotong/identity` 金库(`readVaultSecret` 解出原文)→ **整个 `<space>` 逐字节扫,明文一处也不在**;生产那一份渲染器的回复里没有秘密、有目标名、有「请删掉你那条消息」、有 `/setkey link` 那条路;**顺序打反那次**(`/setkey <key> <agent>` — 着急的人最常犯的)同样一个字节都不回显;日志与审计同罪 |

## 为什么两处要「控制组先跑」

「读不到那把 key」这句话有一种廉价的假通过方式:`cat` 根本没跑起来,输出当然是
空的,断言当然过。所以幕 1 与幕 3 各先跑一条**同形状但目标在工作区里**的命令,
证明这条路本身是通的,再去撞墙——**一条通过了的控制断言,如果它守的门当时是
关着的,它什么也没证明**。这是 HANDS-M3b 那个下午买来的教训,写进 demo 里。

## 底下全是真件

- 真 `detectFsJail()`(`@gotong/core`)+ 真 `armButlerHands` / `buildButlerHandsToolset`
  (`@gotong/host/butler-hands`)——工具面、四档策略、监狱围墙全是生产那一份;
- 真 `parseImCommand`(`@gotong/im-adapter`)——`/setkey` 的每一种形状由它认领;
- 真 `ImCredentialsService` + 真 `renderSetKeyOutcome`(`@gotong/host/im-credentials`)
  ——幕 4 渲染的**就是生产那一份字节**,不是在 demo 里手抄一份看起来一样的话;
- 真 `@gotong/identity` 金库(`loadOrCreateMasterKey` + `openIdentityStore`,key 真
  信封加密),所以「盘上扫不到明文」与「金库解得出原文」这两句话同时成立。

## 诚实边界

- **本机没有 OS 监狱时**(既无 bubblewrap 也无 sandbox-exec),三幕里「真 spawn」
  那一半按设计跳过,断言数会少几条——跳过的是**执行**不是**结论**:幕 0 已经证过
  没有监狱时手根本不存在。想在 Linux 上跑全,`apt install bubblewrap`。
- **tier 2 读的是声明的 `net` 与命令名**,不是真去嗅探流量。推错了的代价是一次
  多余的审批(或一次离线失败后重来),不是一次没被问过的出网。
- **解释器与 shell 刻意不 park**:argv 里塞得下任何东西,逐条分级只会给出安全
  错觉。它们靠的是监狱兜底——幕 1 层二演的正是这件事。

深潜:[`docs/zh/ATONG-HANDS.md`](../../docs/zh/ATONG-HANDS.md)
