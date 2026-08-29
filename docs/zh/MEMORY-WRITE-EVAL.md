# 记忆写侧评测(M-EVAL)——把「整理质量」做成可测件

> 状态:**M0 计划落档(2026-08-29)。下一步 M1 立尺。**
> 方向: M(记忆管理能力;见 [`DIRECTIONS.md`](DIRECTIONS.md) M 路线第一项「写侧评测」)。
>
> 一句话:读侧已有尺(MU-M1 recall 承重门 + 棘轮地板),写侧只有二值机械门没有分数;
> 本 track 给「整理质量」立尺——**① bitemporal close 正确率 / ② 原子事实自包含率 /
> ③ 遗忘-投影同步**——照 recall 门的形状:零 key 可复现的 CI 门 + 用户门真档跑分。

---

## 一、为什么

[`STRATEGY-2026-08.md`](STRATEGY-2026-08.md) §三点名的业界空白:记忆评测几乎全测**读侧**
(LongMemEval/LoCoMo 都是「问答对不对」),**写侧**(整理这一步做得好不好)集体缺席——而
Gotong 的记忆是 file-first 白盒,双时态翻篇、原子事实抽取、遗忘-投影同步全是**盘上可验证
的写行为**,这正是差异化评测面。[`DIRECTIONS.md`](DIRECTIONS.md) M 路线把它排在第一项:
「M1 recall 承重门是先例,写侧照这个形状立尺」。

先立尺再动刀的理由与 STOR-M1 完全同款:6h 蒸馏的提示词
(`reconcile.ts:230 DEFAULT_RECONCILE_SYSTEM`、`atomic-facts.ts:68 DEFAULT_ATOMIC_FACTS_SYSTEM`)
将来任何调优,没有尺就只能靠感觉;有了尺,「换了提示词/换了模型,整理质量是升是降」变成
一条命令出数字的事。

---

## 二、侦察实录(2026-08-29,全部一手 file:line)

### 2.1 写侧已经有半把尺,M-EVAL 是推广不是另起炉灶

`packages/personal-memory/tests/memory-consolidation.test.ts` 已在 `check:memory-recall`
里(根 `package.json:102`):scripted `MemorySummarizer`(`:86` 一行 thunk 回既定事实)+
**真** `atomicFactsReviewer`(`:87`)+ 确定性判分(抽取前 answer-recall 0 → 抽取后 1)。
这就是「写侧可以零 key 判分」的既有证明——M-EVAL 把这半把尺推广成记分的 `score*` 族。

### 2.2 指标①:机械面已有门,**判定面没有尺**

- 机械面 = `reconcile.ts` 的 op 应用循环:ADD/UPDATE/DELETE/NOOP、写前退后、幻觉 id 丢弃、
  first-op-wins、digests/profile 结构性不进候选;bitemporal 模式由 `:148`
  `opts.bitemporal === true && !!opts.closeEntry` 双条件门控,UPDATE/DELETE 翻篇不真删。
  这一面已被 `tests/reconcile.test.ts` **22 例**二值盖死(其中 bitemporal describe 5 例:
  UPDATE 关旧 validTo + 新事实带 validFrom+supersedes / DELETE 关区间 / ADD 打 validFrom /
  无 closeEntry 降级 / 旗标而非写者门控)。
- 缺的 = **决策质量**:给定「既有事实 + 矛盾的新 episodic」,决策者(summarizer,即真跑里
  的 LLM)有没有发出**对的** ops——该翻篇的翻了、不该动的没动、没有把旁观者误伤。今天
  没有任何测试量这件事,因为量它需要场景库和判分器,那正是 M1 的活。

### 2.3 指标②:只有间接代理,没有直接判分器

`DEFAULT_ATOMIC_FACTS_SYSTEM` 在提示词里强制自包含(「事实必须独立可读」),
`parseFacts`(`atomic-facts.ts:152`)只做长度/形状过滤(>200 字符按「段落不是原子事实」跳过),
**不判自包含**。2.1 那半把尺用 recall-lift 间接量它(自包含的事实才搜得回来),但没有
「这条事实本身自不自包含」的直接判分——比如「他最爱的是珍珠奶茶」(代词悬空)今天不会被
任何测试标红。

### 2.4 指标③:**已被既有门盖死——本次侦察最重要的「不做」**

执法是结构性的:投影只有一份实现 `projectButlerMemoryVault`(`butler-obsidian.ts:107`),
恰好两个调用者——6h 维护兜底(`:94`)与成员单条遗忘(`butler-memory-service.ts:141`);
forgetAll 走 `removeMemoryProjections`(`butler-memory-service.ts:162-166` → 纯核
`obsidian-projection.ts:575`)。门 = `packages/host/tests/butler-obsidian-wiring.test.ts`
四例:`:156` 6h 兜底与写路径**逐字节相同**、`:179` forgetAll 清记忆投影不碰 tasks.md、
`:202` 忘掉**单条**也会重投、`:224` 无 provider 照样投影。

**裁决:③ 不再立分数。** 给一个已经被二值门钉死的结构性性质配百分比,是假精度——
「同步率 98%」只会让人问「那 2% 去哪了」,而正确答案是「同步是一份实现两个调用者,
结构上没有 2% 可失」。记分卡如实报「③ = 二值,已由既有门盖死(引 file:line)」。

### 2.5 可照抄的尺子惯例(MU-M1 家族)

- 棘轮惯例(`tests/memory-recall-bench.test.ts`):`FLOORS` 常量钉在实测值下一点点、
  头注「Never lower a floor to make it pass」、提升主张写成测试、天花板精确断言
  (semantic recall `.toBe(0)` 诚实记录本地上限)、生产工厂镜像真管家接线。
- 零 key 理由(`benchmark.ts` 头注原话):「a gate must be key-free + reproducible」——
  M-EVAL 对这句的延伸:写侧同理,CI 档零 key 锁尺子,真档才碰模型。
- fixture 惯例(`tests/fixtures/recall-cases.ts`):固定钟 `T0 = 1_700_000_000_000` 零
  `Date.now()` 使分数字节稳定;每个分类头注写明「哪个里程碑会动它」——尺子的刻度必须
  落在下一个里程碑要动的区间里;`closed()` helper 造翻篇事实。
- 假店(`tests/fake-memory.ts`):`makeFakeMemory(seed)` 带 `entries` 活视图 + `patchMeta`
  浅合并——写侧场景就在它上面跑真 `reconcile`,然后**判店况**。
- 注入缝:`MemorySummarizer = (input:{system,user}) => Promise<string>`
  (`consolidate.ts`)——scripted 决策者与真模型决策者走**同一个缝**,harness 零分叉。

---

## 三、设计

### 3.1 诚实结构:两档

核心困难:①② 量的是 **LLM 的决定**,零 key 的 CI 量不到真模型。硬凑会得到两种谎:
CI 里放宽松 mock 假装量了模型,或真档数字没有校准过的判分器背书。拆成两档,各说各话:

- **CI 档 `pnpm check:memory-write`(零 key 零网络,进 guards 家族)——锁的是尺子不是模型**:
  1. **判分器校准**:手标 fixture(正确 op 集 / 错误 op 集 / 部分正确 op 集;自包含事实 /
     不自包含事实)喂判分器,断言按标打分——满分是满分、零分是零分、部分介于其间。
     这是真档数字可信的**全部理由**:判分器自己先被判过。
  2. **管道贯通**:scripted oracle 决策者(照标准答案出 ops)走真 `reconcile` 全管道 →
     必须满分;**故意犯错的 scripted 决策者(翻错对象/漏翻/误伤旁观者)→ 必须低于地板**。
     后者是把变异测试内建进门里:判分器若失聪,这条当场红。
  3. 机械不变量**不重造**——`reconcile.test.ts` 22 例已盖(§2.2),引用不复制。
- **真档(用户门,要 key 烧 token)**:同一套场景 + 真模型当决策者/写手 → 真·close 正确率
  与自包含率,报告 JSON+MD 落盘。EFF 同纪律:**不立标准,数字只与自己比**——第一次跑出
  的数就是基线,此后改提示词/换模型与它比。

### 3.2 指标① `scoreCloseDecisions`——判店况,不判 ops JSON

场景 = `{ 既有店况(带 id/meta 的事实集), 新 episodic, 黄金后置条件 }`。跑
`reconcile({bitemporal:true, closeEntry, summarize: 决策者})` 于 FakeMemory,然后逐条
核**店况后置条件**:

- 旧事实已翻篇(`validTo` 已打)而非仍活跃、也非被真删;
- 新事实活跃且带 `validFrom`;
- 旁观者一字未动;
- 矛盾不存在的场景 = 正确答案是 NOOP,动了扣分;
- 幻觉 id 不伤店(机械面兜底,场景里作对照)。

**为什么判店况**:UPDATE 与 DELETE+ADD 两条 op 路都能达成「旧的翻篇 + 新的活跃」,判
ops 原文会把等价解法误判成错;判店况天然两收。`supersedes` 回链只在 UPDATE 路存在
(`openedMeta` 第三参),故按场景标注为**加分项**不计主分。分数 = 达成后置条件的比例,
按场景平均;精确评分细则(各条权重、部分分)M1 随 fixture 定,原则钉死:**确定性、可复算、
店况为准**。

### 3.3 指标② `scoreSelfContainment`——确定性词面判分 + 手标校准

每条产出事实按 expected-terms 判(MU-M1 recall-cases 同款手法):自包含 = 类别词在
(「饮料」「住址」…)**且**具体值在(「珍珠奶茶」…)**且**无悬空指代(裸「他/她/它/这/那」
开头这类可枚举的形状)。判分器是纯函数;手标 fixture(自包含/不自包含各若干条,双语)
校准它。真档:真模型从 episodic 写事实 → 逐条判 → 自包含率。

### 3.4 指标③:引用,不立新尺

记分卡固定一行:「③ 遗忘-投影同步 = 二值,已由 `butler-obsidian-wiring.test.ts`
:156/:179/:202/:224 盖死(一份实现两个调用者,见 §2.4)」。

### 3.5 落点与输出

- `packages/personal-memory/src/write-benchmark.ts`:纯 harness(`scoreCloseDecisions` /
  `scoreSelfContainment` / `formatWriteBenchResult`),镜像 `benchmark.ts` 住 src/ 的先例
  (harness 是可复用件,真档 runner 也要 import 它)。
- `tests/fixtures/write-cases.ts`:场景库 + 校准 fixture,双语、固定钟、每分类头注写明用途。
- `tests/memory-write-bench.test.ts`:CI 门本体(校准 + 贯通 + 地板常量只升不降)。
- 根 `package.json` 新 `check:memory-write`——**刻意不并进 `check:memory-recall`**:
  读写两把尺各自可单跑,谁红一眼看清是哪一侧。
- 真档 runner = `scripts/memory-write-real.mjs`(EFF-M1 `scripts/effect-matrix.mjs` 先例:
  personal-memory host-free、provider 在 `@gotong/llm-*`,repo 根脚本两头都够得着;
  key 走 env 变量名,值永不进档案/报告)。

---

## 四、边界(不可破)

1. **热路径零 LLM**——评测全部住测试/脚本层,运行时一个字节不动。
2. **CI 零 key 可复现**;真档 = 用户门,绝不自启烧 token。
3. **不立标准**——真档数字只与自己比(EFF 纪律);判分器必须**确定性**,不做 LLM-judge
   (LoCoMo 判卷器收 63% 故意错答的教训,STRATEGY-2026-08 §三:判分器不确定,棘轮地板
   就没有意义)。
4. **内核零改动零新旋钮(114 冻结)**——write-benchmark 是纯函数 harness,不是开关。
5. **不重造既有门**——机械面(reconcile 22 例)与 ③ 同步面引用不复制;棘轮地板只升不降。

---

## 五、里程碑

- **M0 本文档** ✅(纯 docs)。
- **M1 立尺**:harness + fixtures + 校准门 + `check:memory-write`(CI 零 key);地板从
  scripted oracle 满分与校准精确性起步。
- **M2 真档跑分**〔用户门:要 key〕:`scripts/memory-write-real.mjs` 出首份基线报告。
  备注:可与 EFF-M4 真实档矩阵同一批 key 同一次跑(都是「烧真 token 出基线」的活),
  是否合批由用户定,不阻塞 M1。

## 六、显式不做

- **③ 的百分比分数**(§2.4 裁决:二值已盖死,立分数是假精度)。
- **LLM-as-judge 判分**(边界 3)。
- **改被测提示词**(`DEFAULT_RECONCILE_SYSTEM` / `DEFAULT_ATOMIC_FACTS_SYSTEM`)——
  先立尺后调优,调优等真档出数再议。
- **embedder / 真语义档**(既定推迟,semantic recall 0% 是已接受状态)。
- **CI 跑真模型**(边界 2)。
- **遗忘「彻底性」全盘扫描类评测**——真删的执法在 `mem.forget`、同步的执法在 §2.4,
  各有其门;再造一层扫描是第二个执法点。
