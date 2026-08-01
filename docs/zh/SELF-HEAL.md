# 自检自愈(HEAL):定时自检 + 卡死自动重启 + 失败日志可查

> 一句话:一个 **deploy 层的外部看门狗**每分钟探 hub 的 `/healthz`,连续 3 次
> 不应答就 `systemctl restart` 并把「几点、为什么、当时日志尾巴」记进台账;
> hub 自己每次开机把「上一次是怎么停的」也记进**同一份台账**——之后在管理
> 面板「体检 → 自愈历史」看得到,问阿同「你昨晚是不是挂了」它用
> `restart_history` 工具答得出。
>
> Last updated: 2026-08-01 · 状态:**全完**(M1 hub 侧 + M2 deploy 三件套 + M3 生产安装,SIGSTOP 卡死演练 2026-08-01 生产实测通过:冻结→1/3→2/3→3/3→自动拉起全程 2 分 40 秒,台账三行齐)

---

## 一、设计立场(先说不做什么)

1. **重启单位 = 整个 hub 进程,判据 v1 只治「死和卡」。**
   - 「死」(进程退出)= unit 模板里 `Restart=always` 的事,秒级比分钟级快,
     看门狗不抢;
   - 「卡」(进程活着但 `/healthz` 不应答——事件循环死锁、FD 耗尽之类)=
     `Restart=` 看不见的盲区,**这才是看门狗存在的理由**;
   - 巡检红黄牌(`derivePatrolCards`:缺 key、IM 断、断供)是**重启治不了的
     病**,重启只会抹掉现场——一律不进重启判据,留给巡检/CARE 播报给人。
2. **看门狗在 hub 外面。** hub 卡死时 hub 里的任何定时器都跟着卡,自检进程
   必须在被检对象之外(systemd timer 拉起的独立 oneshot,零依赖纯 stdlib,
   hub 的 node_modules 坏了它也能跑)。
3. **限流 + 响亮。** 每小时最多重启 3 次;打满说明重启治不了,只在台账记一条
   `watchdog-throttled` 等人来,绝不无限循环拉起一个起不来的进程。
4. **维护停机不打架。** `systemctl stop gotong` 期间 unit 非 active,看门狗
   不数失败也不重启——有意停机归人管。
5. **零新 GOTONG_\* 旋钮(116 冻结)。** hub 侧台账/心跳是惰性常开的事实文件
   (不装看门狗它们也只是安静落盘);看门狗的开关就是「装没装 timer」,参数
   全在 unit 文件的 ExecStart 里。

## 二、一份台账,两个写入方

台账 `<space>/runtime/self-heal-log.jsonl`(JSONL,一行一事件,宽容读者):

| 写入方 | 行 kind | 什么时候写 |
|---|---|---|
| hub(`packages/host/src/self-heal-log.ts`) | `boot` | 每次开机,带上一次停止的分类 `prev` 与停机时长 `downMs` |
| 看门狗(`deploy/gotong-watchdog.mjs`) | `watchdog-restart` | 连续 K 次 healthz 失败动手重启前(先落账再动手),带 `journalTail` 日志尾巴 |
| 看门狗 | `watchdog-throttled` | 每小时重启额度打满,同一段故障只记一条 |

两个写入方**天然错峰**:看门狗只在 hub 死/卡时写,hub 只在开机时写。唯一
重叠是 hub 开机剪枝(>300 行重写保 200)撞上看门狗同秒追加——窗口极小,最坏
丢一行看门狗记录、不丢分类能力,接受并记档于模块头注。

**开机分类(消费式停止标记,三态)**:

- 干净退出:shutdown 第一步就同步落 `self-heal-stop.json` → 下次开机读到
  即 `prev='clean'`,**读完就删**(标记用一次就没,陈旧标记误判结构性不存在);
- 崩溃/强杀/断电:没有标记,但心跳文件 `self-heal-heartbeat.json`(每 60s 刷)
  还在 → `prev='unclean'`,`downMs` 按最后心跳算(**误差 ±60s**,心跳节律固有);
- 首跑:两样都没有 → `prev='none'`。

## 三、看得见:面板、阿同、盘上

- **管理面板 → 体检 → 「自愈历史」**:开机三态行 + 看门狗记录(红字),
  `journalTail` 折进「当时日志尾巴」可展开。历史块**不是信号灯**——一条
  30 天前的旧崩溃不该让面板一直黄着,红色只染在坏行自己身上。
- **阿同 `restart_history` 工具**(benign 只读,工具目录层):成员问「昨晚
  是不是挂了/最近重启过几次」时,阿同读同一份台账渲染出来,只读不触发任何
  重启。
- **盘上直读**:`cat <space>/runtime/self-heal-log.jsonl`;看门狗自己的
  运行日志在 `journalctl -u gotong-watchdog`。

## 四、装(VPS,与 gotong.service 同机)

```bash
sudo cp deploy/gotong-watchdog.service deploy/gotong-watchdog.timer /etc/systemd/system/
sudo $EDITOR /etc/systemd/system/gotong-watchdog.service   # 改 ExecStart 三处路径(脚本/healthz/空间根)
sudo systemctl daemon-reload && sudo systemctl enable --now gotong-watchdog.timer
journalctl -u gotong-watchdog -f    # 每分钟一行 ok / 失败计数 / 重启记录
```

三处路径怎么填,`gotong-watchdog.service` 文件头逐行写了;`--space` 指
**下面有 `runtime/` 的那层目录**(与 `GOTONG_SPACE` 解析结果一致,`ls` 确认)。

## 五、演练(装完做一次,没演练过的自愈等于没有自愈)

模拟「卡」(进程活着但不应答):

```bash
sudo kill -STOP $(systemctl show -p MainPID --value gotong)   # 冻结进程
journalctl -u gotong-watchdog -f                              # 看 1/3 → 2/3 → 3/3 → restart
```

约 3–4 分钟内看门狗应完成:三次失败计数 → 落账 → `systemctl restart` →
hub 重启(生产实测 2026-08-01:冻结到拉起全程 2 分 40 秒)。之后验证三处
一致:台账里有 `watchdog-restart` 行(带 journalTail)+ 紧随的 `boot` 行;
面板「自愈历史」显示这两行;问阿同「最近重启过吗」答得出。

> 恢复行的 `prev` 大概率是 **`clean`** 而非 unclean——systemd 默认在 SIGTERM
> 后补发 SIGCONT 唤醒被冻结的进程,干净关停路径(含停止标记)照常跑完
> (实测 `prev:'clean'`,`downMs` 2 秒级=关停到开机的间隙)。这不削弱演练:
> 「卡」的证据在 `watchdog-restart` 行,不在 boot 分类。只有 drain 真卡死
> 超 `TimeoutStopSec`(默认 90s)被 SIGKILL,恢复行才是 `unclean`。

## 六、可测门(会红的)

`packages/host/tests/gotong-watchdog.test.ts` spawn **真脚本**,PATH 垫片
stub systemctl/journalctl,healthz 用测试内真 http 服务:K=3 连败才重启 /
健康即清零(中断不算连续)/ 限流打满只记一条 / unit 非 active 不数不重启 /
journalctl 缺席照样重启 / 坏参数 exit 2。**跨写入方契约**钉在两条断言上:
看门狗写的行必须能被 hub 的 `parseSelfHealLines` 读、被 `renderRestartHistory`
渲染。hub 侧纯核门在 `tests/self-heal-log.test.ts`(开机三态/标记消费式/
剪枝滞回/坏行宽容)。

> 测试排错记:tick 必须**异步 spawn**——`spawnSync` 会阻塞 vitest 进程的
> 事件循环,而 healthz 假服务就活在同一进程里,子进程探针被饿死成超时,
> 活服务被判成死(真死锁,踩过一次)。

## 七、诚实边界

- `downMs` 有 ±60s 心跳节律误差;`unclean` 分不清「崩溃/强杀/断电/OOM」——
  只说「疑似」,病因去 `journalTail` 和 journalctl 里找。
- 看门狗探的是 **liveness**(能不能应答 HTTP),不是 readiness、更不是
  「工作正常」:LLM 断供、IM 掉线时 healthz 照样 200,那些归巡检/CARE。
- 看门狗自己死了(timer 被禁、node 没了)没有第三层看门狗盯它;
  `journalctl -u gotong-watchdog` 一眼能看出它多久没跑。
- 非 systemd 环境(macOS 本机、容器)脚本探针照跑,但 `systemctl` 缺席时
  只记账不重启(stdout 说明)——容器场景该用编排器自己的 liveness 探针。
