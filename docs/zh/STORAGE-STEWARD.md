# 存储管家(STOR)—— VPS 存储空间的自动整理与删除

> **方向: 主 T 兼 M**(工具调用能力——给阿同一双管理自己存储空间的手;记忆树阶梯兼记忆管理)。
> Status: **M0 计划落档(2026-08-29)**;M1 空间账本 → M2 死物清与类②开箱 → M3 成员内容阶梯 → M4 提案卡 + capstone 待做。
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
| ① 死物 | 按构造已无读者的字节 | **无条件自动删**,删前审计行 | 孤儿 `.tmp-*`;`.corrupt-*` 超保留代数的旧件 |
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

### M1 空间账本(先有尺,后动刀)

- `host/src/space-ledger.ts` 纯核:有界流式遍历(`opendirSync` 逐项,hands `measureTree` 同款姿态,
  上限步数防挂死)按顶层类目分桶丈量(transcript+archive / identity+wal / butler 分子目录 / runtime /
  根部 `.bak-*` 族 / 其他),写 `runtime/space-ledger.json` **惰性事实文件**(`last-backup.json` 同族:
  没人读也无害,读者各取所需)。
- 三个读者:①admin 体检面板「空间」三态卡(absent=未接/读不动=缺席+warn/行=分桶数字,
  EFF-M3 admin-health 同款三态诚实);②阿同 `my_status` 多一行「空间占用 X,最大类目 Y」;
  ③benign 只读工具 `space_report`(目录层,AFR 注册三件套)。
- 丈量骑既有 6h retention sweeper 的节律(sweeper 未 arm 时由维护 sweep 兜底)——不开新定时器。
- **不删任何东西**。M1 的全部产出是数字。

### M2 死物清道夫 + 类②生产开箱

- **代码半**:`space-sweeper.ts` 两类确定性动作,全部先审计后动手:
  - 类①死物:孤儿 `.tmp-*`(mtime > 24h)删除;`.corrupt-*` 每前缀族保最新 5 代,更旧的删
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

### M3 成员内容阶梯(retention.json + set_retention)

- `<space>/retention.json` file-first 策略文件(`hands.json` 同族读者:缺席=零字节不变=不删;
  坏形状 warn + 整份不装——半开的剪刀比没有剪刀更坏)。v1 键面刻意窄:
  记忆归档层保留天数、翻篇 dossier 保留天数、离场成员会话窗保留天数,每键都有下限(≥30d)。
- governed `set_retention`(`personal-butler-config.ts` `set_hub_config` 同款形状:参数空间封闭
  枚举、classify 预检镜像执行顺序、写盘走唯一咽喉、审计行);进 `IM_APPROVABLE_TOOLS`
  (`host/src/personal-butler-escalation.ts:38`)——理由与 `set_hub_config` 同一条:**参数空间封闭
  故渲染行结构性长不了**,手机上说人话 → park → `/approve` 一条路走完。
- 阶梯执行器:活跃→归档(已由图书馆员/双时态承担)→**超保留期删**,删除前逐条过岔口 1 硬前置
  (读 `runtime/last-backup.json` 与 git 快照事实,内容晚于最近安全网 ⇒ 跳过 + 巡检黄牌响亮说)。
- 设置页一张「存储保留」卡(UXCFG-M3 同款出处徽章:默认/你设的)。
- 设计点(M3 时决):把类②八个既有旋钮**加进 `ENV_KNOBS` 白名单**让网页/IM 也能改——符合
  「一个网页完成所有配置」的产品目标,且 archive-not-delete 天然满足 M2 白名单判据「改错了能改回来」。

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
