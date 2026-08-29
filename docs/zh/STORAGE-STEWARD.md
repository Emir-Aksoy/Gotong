# 存储管家(STOR)—— VPS 存储空间的自动整理与删除

> **方向: 主 T 兼 M**(工具调用能力——给阿同一双管理自己存储空间的手;记忆树阶梯兼记忆管理)。
> Status: **M0 计划落档 + M1 空间账本 + M2 死物清扫(代码半) + M3a 保留阶梯与 set_retention + M3b archive 族旋钮白名单与设置页卡 ✅(2026-08-29)**;M2 配置半随部署同刀 → M4 提案卡 + capstone 待做。
>
> 用户原话(2026-08-29):「vps存储空间管理应该建设起来,多余的内容要能自动整理并删除。」
> 「atong 目前具备自己使用各种方式管理文件、记忆,并有效的执行还要管理给予它的 vps 存储空间的能力吗?
> 我认为这是下一代的 agent 必须具备的能力。」
> 定型立场(用户认可):**策略人定一次,执行自动跑**——人的决定只发生在策略层(保留多久、留几代),
> 执行层是确定性代码,每一次删除都留审计行。

---

## 一、为什么现在做(诚实起点:这是预防,不是救火)

2026-08-29 生产一手普查(只读 SSH):

| 事实 | 数字 |
|---|---|
| 空间目录 `<space>` 总占用 | **7.2 MB** |
| 磁盘 | 50 GB 总 / 21 GB 用(45%)/ **27 GB 余** |
| 最大单件 | `transcript.jsonl` **2.8 MB**(单文件,未曾封段——8 MiB 封段线还没到) |
| 空间根下 `.bak-*` | **21 个 ≈ 3.5 MB**(identity.sqlite-wal.bak 1.3M / identity.sqlite.bak 492K / 历次配置改动前快照)——**约占总量一半,是部署纪律自己的残余** |
| `backups/`(cli backup 档案) | **0 份**(生产从没跑过 `gotong backup`) |
| `.corrupt-*` 隔离件 | **0 个** |
| `butler/` | 456 KB(memory 288K / longrun 68K / ui 28K / presence·prefs 各 16K / sessions·reachable·escalate 各 8K) |
| `/home/ubuntu` 下 predeploy tar.gz | **0 个**(部署快照不在服务器上堆积——别把它当问题修) |

结论:**今天没有任何东西在失控**。这个 track 的价值是把「不失控」从运气变成机制——
在 transcript 破 8 MiB 开始封段、`.bak` 攒到第 50 个、第一个成员的记忆树长到几百 MB **之前**,
让空间有账本、死物有清道夫、成员内容有人定过的保留阶梯。等到磁盘报警再做,一半选项已经没了。

---

## 二、已建成盘点(先翻家底,再造轮子)

**这次侦察最大的发现:类②「滚动历史」的保留机制三族早已全部建成**,旋钮全在 114 冻结名单之内,
boot 应用 + 6h runtime sweeper 双接线,默认全关(不设 = 字节不变)。生产一个都没开。
**M2 对这三族的工作是「开箱」不是「建设」**——谁在这上面重写轮转就是没读这一节。

| 族 | 机制 | 旋钮(已登记) | 位置 |
|---|---|---|---|
| transcript | 8 MiB 自动封段(恒开)→ `archiveSegments({keepLast,before})` 原子 rename 进 `archive/`,先落 `.hwm` seq 水位(归档后 seq 永不倒退),`loadAll()` 可审计重建 | `GOTONG_TRANSCRIPT_KEEP_SEGMENTS` / `GOTONG_TRANSCRIPT_ARCHIVE_DAYS` | `core/src/storage/file.ts:141-235`;`host/src/transcript-retention.ts`;boot 接线 `main.ts:687` |
| 工作流 run | 归档不删除;`running` 的 run 结构性不碰 | `GOTONG_RUN_KEEP` / `GOTONG_RUN_ARCHIVE_DAYS` | `host/src/run-retention.ts:31,33` |
| identity 四表 | usage_ledger / audit_log / peer_summary_snapshots / alert_firings 半开区间 `DELETE`(OPEN 告警永不删) | `GOTONG_LEDGER_KEEP_DAYS` / `GOTONG_AUDIT_KEEP_DAYS` / `GOTONG_PEER_SUMMARY_KEEP_DAYS` / `GOTONG_ALERT_FIRINGS_KEEP_DAYS` | `host/src/retention.ts:49-64` |
| runtime sweeper | 三族同一只 6h 定时器重套(cutoff 每 tick 重锚 `now`),任一族配置了才 arm,零配置零定时器 | (无新钮——「older than N days 显然指持续,不只 boot」) | `host/src/retention-sweeper.ts`;`main.ts:1415` |

零散的自我管理件(同样已在):self-heal 台账自剪(`PRUNE_HIGH=300/KEEP=200`,
`host/src/self-heal-log.ts:40-41`)、outbox 24h TTL(`host/src/butler-outbox.ts:34`)、
备份事实文件 `runtime/last-backup.json`(`cli/src/commands/backup-core.ts:124`)、
记忆树 git 快照(`host/src/butler-memory-git.ts`,**2026-08-29 已在生产开启**)。

**真缺口只有四件**(这就是 M1-M4):
1. **看不见**——没有空间账本,`my_status` 没有磁盘行,体检面板没有空间卡,阿同答不出「我占多少、什么在长」。
2. **类①死物没有清道夫**——空间根的 21 个 `.bak-*`(部署纪律残余)没人轮转,`.corrupt-*` 无上限,孤儿 tmp 无人扫。
3. **类③成员内容没有阶梯**——记忆归档、翻篇 dossier、离场成员的会话窗:没有策略面,也就没有任何删除。
4. **提案缺席**——空间紧了阿同只能沉默;该有一张「建议把 X 的保留期收紧」的卡,改动仍走人批。

---

## 三、四类数据的规矩(一张表定生死)

| 类 | 是什么 | 规矩 | 生产实例 |
|---|---|---|---|
| ① 死物 | 按构造已无读者的字节 | **无条件自动删**,删前审计行 | 孤儿 `*.tmp`(fs-atomic 临时名以 `.tmp` **结尾**,M2 落地时对源码纠正过本表初版的 `.tmp-*` 前缀写法);`.corrupt-*` 超保留代数的旧件 |
| ② 滚动历史 | 追加型日志/档案,新代替代旧代 | **自动轮转保 N 代**(归档优先于删除;三族机制已建成见 §二) | transcript 段、run 史、identity 四表、空间根 `.bak-*` 族 |
| ③ 成员内容 | 成员的记忆/知识/任务档案 | **阶梯:活跃→归档→超保留期删**;策略缺席 = 不删 = 字节不变;删除硬前置见岔口 1 | `butler/memory` 归档层、翻篇 longrun dossier、离场成员会话窗 |
| ④ 凭证/身份 | 钥匙、金库、身份库 | **结构性永不自动碰**——不进任何 sweeper 的视野,连「建议删」都不出 | `identity.sqlite`、vault、`im-shortcode.key`、`secret.key.pre-unify.bak`(B① 退役钥,永不删)、`.discarded.*` 救援位(`host/src/master-key-recovery.ts:18-64`「never overwritten, never deleted」) |

**读者感知的保留下限**:EFF-M3 效果信号读的是 `<space>/inbox` 已决审批与 `butler/escalate` 事实行的
**30 天窗**(`host/src/effect-signals.ts:51` `DEFAULT_WINDOW_DAYS=30`)。任何触及这两处的保留策略
下限 ≥ 30 天,否则效果回路会把「被删了」读成「没发生」——把读不到计成零正是 EFF-M3 亲手修过的谎。
将来新增读者,先查它的窗再定下限。

---

## 四、拍板记录(2026-08-29,用户「都按推荐,几项都做」)

- **岔口 1(删除前置)= a 硬前置**:类③成员内容删除前,必须确认该内容**已进最近一次备份或 git 快照**;
  备份陈旧或缺席 ⇒ **跳过 + 响亮说**,绝不静默删。生产现实:`backups/` 为空(cli backup 从没跑过),
  记忆树 git 快照 2026-08-29 才开启——所以这道前置在生产**初期几乎恒跳过**,这是特性不是缺陷:
  没有安全网就不动剪刀。
- **岔口 2(策略面形态)= a file-first**:`<space>/retention.json`(`hands.json` 同族,旋钮 114 冻结
  零新增)+ governed `set_retention` 工具(参数空间封闭,进 `IM_APPROVABLE_TOOLS`,`set_hub_config`
  同款先例——手机上说人话 → park → `/approve <短码>`)+ 设置页一张卡。**不走 env 旋钮**
  (类②既有 env 族保持原样——已建成、已登记、boot fail-loud 语义成熟,迁移是纯折腾)。
- **岔口 3(节奏)= a+b 都做**:M0 计划落档 → M1 起刀;同批生产开启图书馆员+git 快照(已完,
  2026-08-29)+ LONG-M6.3 禁未来日期承诺(已完,`b497363`)。

---

## 五、五条不可破边界

1. **热路径零 LLM**——丈量、轮转、阶梯判定、删除全是纯代码;LLM 只出现在 M4 提案卡的**措辞**里,
   且提案卡本身由确定性阈值触发,模型一个字节都删不了。
2. **旋钮 114 冻结零新增**——策略进 `retention.json`(file-first),类②沿用既有已登记旋钮;
   本 track 一个新 env 都不加。
3. **类④结构性不可达**——sweeper 的目录遍历用白名单圈定作用域,vault/identity/钥匙文件**不在视野内**
   (不是「看到了跳过」,是路径上就走不到——`hands.json` hiddenPaths 同一哲学)。
4. **审计先行**——每一次移动/删除先落 `runtime/space-actions.jsonl` 一行(self-heal 台账同族:
   append-only、自剪、宽容读者),**先落账再动手**(self-heal「先落账再 restart」同序);
   账写不进去就不删(一次磁盘打嗝不该让删除变成无据可查)。
5. **归档优先于删除**——类②三族全是 archive-not-delete(字节还在 `archive/`);真正的 unlink 只
   发生在类①死物与类③过完整阶梯的内容上,且类③必过岔口 1 硬前置。

---

## 六、里程碑

### M1 空间账本(先有尺,后动刀)✅ 2026-08-29

- `host/src/space-ledger.ts` 纯核:有界流式遍历(`opendirSync` 逐项,hands `measureTree` 同款姿态,
  上限步数防挂死)按顶层类目分桶丈量(transcript+archive / identity+wal / butler 分子目录 / runtime /
  根部 `.bak-*` 族 / 其他),写 `runtime/space-ledger.json` **惰性事实文件**(`last-backup.json` 同族:
  没人读也无害,读者各取所需)。
- 三个读者:①admin 体检面板「空间」三态卡(absent=未接/读不动=缺席+warn/行=分桶数字,
  EFF-M3 admin-health 同款三态诚实);②阿同 `my_status` 多一行「空间占用 X,最大类目 Y」;
  ③benign 只读工具 `space_report`(目录层,AFR 注册三件套)。
- 丈量骑既有 6h retention sweeper 的节律(sweeper 未 arm 时由维护 sweep 兜底)——不开新定时器。
- **不删任何东西**。M1 的全部产出是数字。

**落地记(2026-08-29)**——四条承重判断全部变异测试钉死:

1. **根读不动 = null 绝不零行**(`measureSpaceLedger` 空间根 `opendirSync` 抛 ⇒ warn + 返回 null,
   盘上不落文件)——一行全零的账本读起来像「空间是空的」,而真相是「我看不见」;EFF-M3
   「把『读不动』计成 0 会谎报『一切安静』」第四次现身。变异(伪造零行)恰红 1 例。
2. **钩子位置是正确性不是风格**:维护 sweep 侧的丈量钩挂在 `runOnce()` 最前、`listUserIds()`
   与零成员 early-return **之前**——丈量不需要模型也不需要成员,一台零成员/没 key 的 hub 也该有
   诚实的空间账本。变异(钩子挪到 early-return 之后)恰红 1 例(零成员仍丈量那例),census 抛错
   不拖垮蒸馏那例保持绿。
3. **载体二选一,main.ts 按 `retentionConfigured()` 定夺**:retention sweeper 已 arm ⇒ 骑它的
   第四段独立 try/catch(三族清完才量,census 抛错不连累 retention,反向同理);未 arm(生产现状)
   ⇒ 骑维护 sweep;外加 boot 一次 fire-and-forget。永远恰好一个载体,不开新定时器。
4. **读者宽容,权威是盘上那份**:`readSpaceLedger` 无缓存逐次读,`isLedger`/`isCategory` 全形状
   校验(数值 `Number.isFinite`、`truncated` 布尔、`v===1`),坏档=null 不隔离不改名(观察者永不
   隔离,`readButlerMemoryHealth` 同纪律)。变异(摘 `truncated` 形状检查)恰红 1 例。
   `.bak-` 分桶规则(目录名/文件名两处)变异恰红 1 例;`space_report` 从
   `BUTLER_DIRECTORY_BENIGN` 摘除 ⇒ tiers 双向名册门**两面各红 1 例**。

验收:host **3317**+5skip(+25:space-ledger 16 / admin-health 4 / retention 2 / maintenance 2 /
self-status·tiers·toolface 同步)、web **1690**(面板卡由既有契约门盖)、全仓 `pnpm -r typecheck`
RC=0、四门 PASS(**旋钮 114 零新增**——账本是惰性事实文件不是开关;main.ts 2754/2760);五道变异
五次全红且只红该红那些,复原一律 python 精确替换 + `shasum` 对拍。admin 面板「空间」卡 6 个
`healthSpace*` i18n 键双语,sw CACHE v23→**v24**。

### M2 死物清道夫 + 类②生产开箱(代码半 ✅ 2026-08-29;配置半随部署同刀)

- **代码半**:`space-sweeper.ts` 两类确定性动作,全部先审计后动手:
  - 类①死物:孤儿 `*.tmp`(mtime > 24h)删除;`.corrupt-*` 每前缀族保最新 5 代,更旧的删
    (隔离件的价值在「事发后能验尸」,五代之外的验尸没人做过——生产现况 0 个,这是预防线)。
  - 类②`.bak-*` 族轮转:空间根的 `<name>.bak-<ts>` 按 `<name>` 分族,**每族保最新 3 代**,更旧的删;
    「保 N≥3 永不删最后一代」是硬不变量(回滚资产,剪到只剩一代等于没有轮转只有删除)。
  - 作用域白名单:只看空间根一层 + `runtime/`;`butler/`、`identity.sqlite*`、`vault` 前缀、
    `backups/`、`exchange/`、`inbox/` 全不在视野(边界 3)。
- **配置半(生产动作,随 M2 部署同刀)**:给类②三族开箱——
  `GOTONG_TRANSCRIPT_KEEP_SEGMENTS=8`(8 段×8MiB=64MiB 活跃载荷顶)+ `GOTONG_TRANSCRIPT_ARCHIVE_DAYS=30`、
  `GOTONG_RUN_KEEP=200` + `GOTONG_RUN_ARCHIVE_DAYS=30`、identity 四表 `*_KEEP_DAYS=180`
  (audit_log 是治理证据,给它半年;**全部 ≥ EFF 30 天信号窗**,边界见 §三)。具体数字部署时按
  M1 账本实测再定,此处是量级承诺不是最终值。
- `space-actions.jsonl` 审计台账随本刀出生(self-heal-log 形状:append-only + 自剪滞回)。

**落地记(2026-08-29,代码半)**——五条承重判断全部变异测试钉死:

1. **孤儿谓词按 fs-atomic 的真相,不按本文档初版的想象**:动手前读了 `fs-atomic.ts`——原子写
   临时名是 `${target}.<pid>.<hrtime36>.<hex>.tmp`,以 `.tmp` **结尾**,不是 M0 写下的 `.tmp-*`
   前缀(那个形状在这套代码里根本不存在)。谓词=`endsWith('.tmp')` + 24h 年龄门;§三表与本节
   的 `.tmp-*` 已同刀改口。**给一个不存在的形状写删除器,要么删不到孤儿,要么哪天真删错**。
   变异(摘年龄门)恰红 1 例(新鲜的活跃原子写被删那例)。
2. **视野是结构性的不是名单式的**:只走空间根一层 + `runtime/` 一层、只看普通文件(`Dirent.isFile()`
   把目录与符号链接一起排除,候选再 `lstat` 复核)。`butler/`、金库、身份库、`backups/` 不是被
   deny 名单挡住——是清扫器**根本不走到那里**;名单会烂,谓词不会,故刻意不设第二份名单。
   变异(视野偷偷加 `butler/sessions/`)恰红 1 例。根部活文件安全网单独一例:identity.sqlite/
   gotong.env/secrets.enc.json 与 `.bak-` **目录**全程零触碰、result 全零。
3. **先落账再动手,账写不进去就不删**(self-heal「先落账再动手」+ M-HEALTH「被吞掉的删除失败
   比响亮报错更接近撒谎」两判例合流):每条删除先 append `{at,kind:'delete',class,scope,file,bytes}`
   到 `runtime/space-actions.jsonl`,append 失败 ⇒ 跳过这条删除 + `auditBlocked` 计数 + 每轮 warn
   一次;unlink 非 ENOENT 失败再补一行 `delete_failed`;ENOENT 当已删(与并发写者赛跑输了=目标
   已不在)。台账只落文件名不落绝对路径。变异(appender 失败谎报成功)**恰红 2 例跨两层**
   (`sweepSpaceOnce` 直测 + `spaceUpkeepAt` 组合)=这条不变量端到端接通的硬证据。
4. **保代数是硬不变量**:`.bak-` 每族 `sort(newestFirst).slice(BAK_KEEP)`——族内 ≤3 代结构性
   不产生候选,独苗碰都不碰;`.bak-` 轮转只在根(`runtime/` 里 `bak:false`)。变异(`BAK_KEEP`→0)
   恰红 1 例。台账自剪滞回(>300 才剪到 200)变异(滞回退化成每轮剪)恰红 1 例——滞回不是省事,
   是别把 append-only 台账变成每 6h 重写一遍的文件。
5. **载体复用 M1 的缝,一个新定时器都不开**:`spaceUpkeepAt(spaceDir)` 把清扫与丈量合成一只
   thunk——**先清扫后丈量**,账本永远反映清扫后的真相(测试钉:一万字节孤儿 → `run()` → 孤儿
   没了且 `totalBytes < 10000`);两半各自 best-effort(`runtime` 被占成文件时台账/账本落盘全堵,
   孤儿不删、丈量行照常返回)。载体沿 M1 原位改名 `spaceLedger`→`spaceUpkeep`(诚实命名:
   会删字节的 thunk 不该顶着只丈量的名字),retention 第四块 / 维护 sweep 钩 / boot 一次,
   main.ts 净零行。

验收:host **3330**+5skip(+13 `space-sweeper.test.ts`)、全仓 `pnpm -r typecheck` RC=0、四门 PASS
(**旋钮 114 零新增**——台账是惰性事实文件不是开关;main.ts 2754/2760 净零);五道变异五次全红且
只红该红那些,复原一律 python 精确替换 + `shasum` 对拍与基线逐字节相同。**配置半(类②三族生产
env)刻意不随本 commit**:数字要按生产 M1 账本实测定,随下次部署同刀落 `gotong.env`。已知后果
如实记:生产首次 boot 会按族轮转根部 `.bak-*`(现况 21 件≈3.5M,保 3/族约删 18 件),每件一行台账。

### M3 成员内容阶梯(retention.json + set_retention;M3a + M3b ✅ 2026-08-29)

- `<space>/retention.json` file-first 策略文件(`hands.json` 同族读者:缺席=零字节不变=不删;
  坏形状 warn + 整份不装——半开的剪刀比没有剪刀更坏)。v1 键面刻意窄:
  记忆归档层保留天数、翻篇 dossier 保留天数、离场成员会话窗保留天数,每键都有下限(≥30d)。
- governed `set_retention`(`personal-butler-config.ts` `set_hub_config` 同款形状:参数空间封闭
  枚举、classify 预检镜像执行顺序、写盘走唯一咽喉、审计行);进 `IM_APPROVABLE_TOOLS`
  (`host/src/personal-butler-escalation.ts:38`)——理由与 `set_hub_config` 同一条:**参数空间封闭
  故渲染行结构性长不了**,手机上说人话 → park → `/approve` 一条路走完。
- 阶梯执行器:活跃→归档(已由图书馆员/双时态承担)→**超保留期删**,删除前逐条过岔口 1 硬前置
  (读 `runtime/last-backup.json` 与 git 快照事实,内容晚于最近安全网 ⇒ 跳过 + 巡检黄牌响亮说)。
- **M3b(✅ 2026-08-29)**:类② **archive 族**四旋钮进 `ENV_KNOBS` 白名单(23→27)+ 设置页
  「存储归档」卡——符合「一个网页完成所有配置」的产品目标;§六初版写的「八个」按 M2 白名单
  判据(「改错了能改回来」)收窄成 **4+4 分界**:archive 族(TRANSCRIPT_KEEP_SEGMENTS/
  TRANSCRIPT_ARCHIVE_DAYS/RUN_KEEP/RUN_ARCHIVE_DAYS)只 rename 进 `archive/` 永不删、归档的
  照样读得到=天然可逆进名单;删除族(LEDGER/AUDIT/PEER_SUMMARY/ALERT_FIRINGS 四个
  `*_KEEP_DAYS`)是 SQL `DELETE` 不可逆,**仍拒**——同为保留期,分界在机制不在名字。

**M3a 落地记(2026-08-29)**——host 新 `space-retention.ts`(阶梯纯核+策略读写)+
`personal-butler-retention.ts`(governed 工具面),六条承重判断,五道变异全部钉死:

1. **策略读者「未知键=整份 null」**:`loadRetentionPolicy` 缺席=静默 null(不删是缺省不是降级);
   坏 JSON / 非对象 / 未知键 / 越界(30–3650 天)各自 warn 后**整份 null**——装一半的策略比没有
   策略更坏(拼错 `dossier_days` 静默忽略=成员以为设了保留而剪刀按「没设」跑,两头都错)。
   `{}` 合法=显式全保留。变异(未知键不拒)恰红 1 例;`writeRetentionPolicy` 的未知键 throw 是
   **独立执法点**照绿——写侧拒绝保护写者,读侧拒绝保护盘上被人手改过的档,两道各有测试。
2. **翻篇判定是闭集**:dossier `closed = status==='done'||'cancelled'`,active/blocked/
   winding_down **结构性不进候选**——静默跳过且不计 `skippedNoNet`(那不是「缺安全网」是
   「还活着」,计进去会把黄牌变成常亮噪音)。变异(closed 恒 true)恰红 1 例。
3. **岔口① 硬前置逐条执行,三层各认各的安全网**:知识归档层 per-file `mtimeMs <= netAt`,
   `netAt = max(全量备份, 该成员记忆树 git HEAD)`(两个安全网谁新认谁);dossier 与离场会话窗
   **只认全量备份**——`butlerLongRunRoot`/`butler/sessions` 是记忆树**兄弟**目录,MU-M5 git 快照
   结构性照不到它们,拿快照当它们的安全网是把「隔壁有备份」读成「我有备份」。`skippedNoNet`
   响亮计数 + 巡检黄牌 `retention:no-net`(48h 滞回;`blockedAudit` 刻意不上牌——那是 M2 台账
   故障面的事)。变异(摘 dossier 安全网门)恰红 1 例。生产 `backups/` 现况 0 份 ⇒ dossier/会话窗
   初期**恒跳过=特性**:没有安全网就不动剪刀(岔口① 拍板原文)。
4. **先落账再动手**(M2 `deleteWithLedger` 同纪律,retention 有自己的执法件):账 append 失败 ⇒
   `blockedAudit`++ 且**一个字节不删**;unlink 非 ENOENT 失败 ⇒ `failed`++ 补 `delete_failed` 行;
   ENOENT=已删(与并发写者赛跑输了=目标已不在)。台账行 `class:'retention'` 与 M2 的
   `class:'tmp'|'corrupt'|'bak'` 同册分类。变异(先删后落账)恰红 1 例。
5. **`set_retention` 全套 `set_hub_config` 形状**:classify 预检镜像执行顺序(角色→键 enum→
   days⊕reset 互斥→范围,拒绝各带病名+回显收窄);读现值失败 try/catch **承重**(warn 后照常
   approve——该不该问人不依赖那句注解,`set_hub_config` 同判例);execute 批准后重查角色(降权
   批准救不回);写失败不回显路径。审计 `setting_config_write` 行 `metadata.kind:'retention'`。
   进 `IM_APPROVABLE_TOOLS` 的理由钉在名单注释里:3 键闭集 enum + 有界整数天数/reset 布尔,
   零自由文本字段,渲染行结构上长不出来。变异(名单摘 `set_retention`)**恰红 2 例跨两文件**
   (工具面测 + tiers 双向名册门)=名单缝端到端接通的硬证据。
6. **读失败有方向性**:候选目录读失败折 `[]`=安全方向(少删);identity 读失败**反方向**——
   `liveUserIds` 拿不到 ⇒ 离场会话窗**整类跳过** + warn(读不出谁还在,就不能删任何人的窗;
   把「读不动」当「都离场了」正是 EFF-M3 那句谎的删除版)。
7. 载体:`spaceUpkeepAt` 长 `extras.ladder` 缝,顺序**清扫→阶梯→丈量**(账本反映动刀后的真相),
   extras 缺席=M2 形态字节不变;策略缺席时 `buildRetentionLadder` 返回 null 连 state 文件都不落。
   零新定时器,main.ts 接线走既有载体。

验收:host **3406**+5skip(+77:space-retention 52 / personal-butler-retention 25;tiers 10 /
toolface 6 同步),首轮全量另有 1 例 `me-exchange-service` replay 时序红(EXCH-M1 fire-and-settle
面,本刀零触碰,单跑两轮 12/12 全绿,按不可复现 flake 记档);全仓 `pnpm -r typecheck` RC=0、四门
PASS(**旋钮 114 零新增**——retention.json 是策略文件不是旋钮;main.ts 2773,棘轮 2760→**2790**
显式抬理由记 gate);五道变异五次全红且只红该红那些,复原一律 python 精确替换 + `shasum` 对拍
与基线逐字节相同。

**M3b 落地记(2026-08-29)**——`ops-config-write.ts` ENV_KNOBS 23→27 + `setting-ops-ui.js`
新「存储归档」组四控件,四条承重判断,五道变异全部钉死:

1. **单向 containment 是这次准入的全部安全论证**:`applyEnvKnob` 写的是 boot 时才被
   `parseTranscriptRetention`/`parseRunRetention` 读的值,而那两个读者对坏形状**抛错拒启**——
   校验器比读者严=安全,比读者松=重启炸弹,**炸的人正是刚才那个以为「保存成功」的人**。
   containment 测试不抄读者的规则,拿 `verdict.value`(校验器真正落盘的归一化输出)喂**真 parse**:
   收下的每个值 parse 必须收、空串必须是显式清除、坏形状必须两头都拒。变异(摘 `RUN_KEEP`
   整条)**恰红 6 例跨两文件**(containment 四例经 knob() throw + 双向名册门 + UI 对拍)=白名单缝
   端到端接通的硬证据。
2. **`boundedInt` 三层各有分工**:`/^\d+$/` 正则管**形制规范性**(拒 `1e3`/`+5`/小数——parse 收
   得下但人读不懂的形状),`Number.isSafeInteger` + 范围是后卫,归一化 `String(n)` 保证落盘值
   与校验值同一形状。变异(摘正则)恰红 **3** 例而非 4——`RUN_ARCHIVE_DAYS` 的收窄探针
   (越界/非整数)恰好被后卫接住,红的三例正是正则独有的活;变异(空串改拒)恰红 5 例
   (:910 通用 defaultValue 门 + 四条显式清除)。
3. **UI 上下界不抄常量,对拍真校验器**:设置页 `min/max` 抄一份服务端数字=只证「我抄得和它
   一样」;门拿边界值 `String(min)`/`String(max)`/`String(max+1)`/`String(min-1)` 喂 ENV_KNOBS
   里的**真 validate**——谁改了 `boundedInt` 的界而忘了这页,当场红。变异(UI 分组拼错)恰红
   2 例;变异(makeControl 退回只认 `port` 写死 1/65535)恰红 1 例(文本门钉住 `number` 分支
   存在且 min/max 从条目读——否则四格静默落进 text 分支,控件照常出现只丢数字键盘与边界,
   没有任何测试会红)。
4. **刻意不挂 `needs:` 级联提示**(门钉死):这四个是 boot 时读的,没有哪个父开关能让它
   「先打开 X」,挂了就是指一个假前提;拒收文案同刀改口——删除族被拒时如实说「归档类可改、
   删除类不可」,不再一句「storage knobs are env-only」把两族混为一谈。

验收:host `ops-config-write` **86** + `setting-ui-contract` **27**(+3 STOR-M3b describe),
ripple 三门 142/142;`setting-ops-ui.js` 是嵌入资产(static-assets.ts),改完重跑
`pnpm --filter @gotong/web build` 重生成嵌入表(POLISH-M4 教训);**旋钮 114 零新增**——
ENV_KNOBS 白名单准入 ≠ env 注册表新增,四个旋钮 M0 起就在 114 之内。

### M4 提案卡 + capstone

- `space_report` 之上长一张提案卡(HANDS-M4 `personal-butler-environment.ts:232` 判别联合同款:
  `applicable:false` 那支**没有 apply 字段**):确定性阈值(如某类目 30 天增长率、磁盘余量百分比)
  触发「建议收紧 X 保留期 / 建议跑一次备份」,`apply` 只指向 `set_retention` 既有参数空间——
  **提案不是新写入口**。
- capstone `examples/atong-storage`:零 LLM 零网络,真 space-ledger + 真 sweeper + 真阶梯,
  四幕自断言(账本分桶正确 / 死物清而类④原地 / 无策略零删除字节不变 / 岔口 1 前置真拦)。

---

## 七、显式不做

- **vault / identity 任何自动清理**——类④(§三);连 `VACUUM` 都不自动跑(锁窗口是运维决定)。
- **B① 的 `.discarded.*` 救援命名空间**——防砖机制的一部分,「never deleted」是它的合同原文。
- **无策略删成员内容**——`retention.json` 缺席就是「全保留」,没有默认阶梯。
- **LLM 现场决定删什么**——模型只能措辞提案(M4),执行面一个字节删不了(边界 1)。
- **迁移类②三族到 retention.json**——既有 env 族成熟且已登记,迁移是零收益折腾;两面并存,
  §三的表写清谁管谁。
- **服务器磁盘级监控/报警**(df 阈值告警归 MONITORING/巡检既有面,不在本 track 重建)。

---

## 八、挂钩

- `docs/zh/README.md` ②区导航行;`docs/zh/DIRECTIONS.md` T 路线现状。
- 相邻:`ATONG-LIBRARIAN.md`(知识树归档=类③阶梯的「活跃→归档」半)/`MEMORY-UPGRADE.md` M5
  (git 快照=岔口 1 安全网)/`ATONG-FRAMEWORK-RECOVERY.md`(备份分档=另一半安全网)/
  `SELF-HEAL.md`(台账形状先例)/`EFFECT-LOOP.md`(30 天信号窗=保留下限来源)。
