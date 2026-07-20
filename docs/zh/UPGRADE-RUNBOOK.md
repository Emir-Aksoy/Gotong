# 升级 runbook — 把一个在跑的 hub 换成新版本

> 面向**已经有 hub 在跑**的运维者。第一次部署看
> [`GO-LIVE.md`](GO-LIVE.md)；这里只讲「已经在生产、要换版本」这件事。
>
> Last updated: 2026-07-20

---

## 零、先读这一条：升级是单向的

**数据库迁移只有前进档，没有倒车档。** 这不是疏漏，是设计：
`packages/identity/src/schema.ts` 里的 `MIGRATIONS` 只允许**追加**，
每条只有 `sql`，**没有 `down`**。hub 每次打开 identity 库都会自动补跑缺
的那几条（`packages/identity/src/store.ts:3293`），跑过的版本号记进
`schema_migrations` 表。当前最新 = **v37**。

推论，也是本文存在的唯一理由：

> **回滚二进制 ≠ 回滚。** 把 `gotong` 换回旧版本，库还是新的。

所以：

| 你想做的 | 实际有效的做法 |
|---|---|
| 升级 | 换二进制 → 重启 → 库自动前进 |
| 「撤销这次升级」 | **恢复升级前的备份**（库和代码一起退） |
| 只把代码退回去 | ✗ 做不到干净的退——见下 |

从 v1.5 起，只退代码这条路会**当场被拦住**：旧二进制打开新库时，发现
`schema_migrations` 里有它不认识的版本号，会抛
`IdentityError: schema_from_the_future` 拒绝启动，并把两个版本号和
本文路径印在错误里。

**在这道拦截存在之前它是静默的**——旧 host 发现「我认识的迁移都跑过了」，
短路返回，日志干干净净地启动，然后用旧代码读写新 schema。那是**静默的
数据损坏，不是崩溃**，比崩溃难查得多。现在它响亮失败。

> ⚠️ 看到 `schema_from_the_future` 时**不要**去 `DELETE FROM
> schema_migrations`「绕过去」。列已经在库里了，删掉版本记录只会让 hub 再
> 跑一遍 `ALTER TABLE` 然后撞重复列。正确的两条路只有：装回新版本，或者
> 恢复备份。

---

## 一、升级前（5 分钟，不可跳过）

### 1. 打一份备份

```bash
# systemd 部署（生产主路）
sudo systemctl stop gotong
gotong backup /srv/gotong/.gotong /srv/gotong/backups
sudo systemctl start gotong      # 想缩短停机就先起回来，备份已经落盘
```

停机打备份是为了拿到**一致快照**。如果你的窗口不允许停机，用
`scripts/backup/backup.sh`——它对 `.gotong/` 只读，可以带机跑，代价是
理论上可能抓到写到一半的 transcript（identity 库走 SQLite，本身是一致的）。

**不带 `--tier`、不带 `--include-master-key`** 就是你要的全量档：能恢复出
一个能跑的 hub。带 `--tier` 的是身份/关系子集，**不足以回滚**。

> 主钥默认**不进**归档。如果你的 `GOTONG_MASTER_KEY` 在 `gotong.env` 里而
> 你没单独备份那个文件，恢复出来的库你打不开。升级前顺手确认一句：
> `grep -c GOTONG_MASTER_KEY /srv/gotong/gotong.env`（**只看有没有，别 echo 值**）。

### 2. 记下当前版本

```bash
gotong --version
git -C /srv/gotong rev-parse --short HEAD   # git checkout 部署
```

回滚时你需要这个数。写进变更单，别只留在 shell history 里。

### 3. 看一眼有什么在跑

```bash
curl -s localhost:3000/healthz
```

正在挂起的审批、跑到一半的工作流会**跨重启幸存**（这是设计），但你要知道
重启后该去 `/me` 收件箱确认哪些还在。

---

## 二、升级

`gotong update` 会自己认出你是哪种装法：

| 装法 | 它做什么 |
|---|---|
| git checkout | `git fetch` + `merge --ff-only`；**工作区脏或分叉就拒绝**，不 reset 不 stash |
| 全局 npm | `npm i -g gotong@latest` |
| 便携包 | 不自更新（内嵌 runtime 是制品的一部分），指给你新的下载地址；数据目录在包外，照常沿用 |
| rsync 拷过去的 | 不自更新，如实说做不到——去源 checkout 更新后重新同步 |

```bash
gotong update
```

出码：

| 码 | 含义 |
|---|---|
| `0` | 更新了 / 本来就是最新 / 便携包已给出指路 |
| `1` | 用法错 |
| `2` | 这种装法自更新不了（rsync 部署、认不出的形态） |
| `3` | git 拒绝了（工作区脏，或非快进——你本地有改动/分叉） |
| `4` | 安装或构建失败（`dist.prev` 已还原；npm 形态的失败也归这里） |

git 形态更新成功后它会顺手跑一次 `gotong check` 复验工作区——**check 红只
是警告，不会让 update 失败**（代码确实前进了，配置问题是 check 的故事）。

两件必须知道的事：

1. **它不会替你重启服务。** 更新完文件就结束了，进程里跑的还是旧代码。
   自己 `sudo systemctl restart gotong`。
2. **它的 `dist.prev` 兜底只覆盖「构建失败」。** 更新时它把
   `packages/*/dist` 挪成 `dist.prev`，构建挂了就挪回来——那一刻你确实
   干净地退回去了，因为**还没重启、库还没迁移**。一旦重启成功、库跑完迁移，
   `dist.prev` 就只是一堆旧代码，退回去会撞上面那道
   `schema_from_the_future`。**分水岭是重启那一下，不是构建那一下。**

然后重启：

```bash
sudo systemctl restart gotong
```

> **命名陷阱**：`gotong migrate` **不是**数据库迁移命令。它是 AipeHub → Gotong
> 的改名残留医生（扫工作区里的旧包名/旧格式 id）。schema 迁移**没有**手动命令，
> 也不需要——启动时自动跑完。

---

## 三、升级后验收（4 项）

```bash
# 1. 启动日志：迁移跑了哪几条 + 没有 error
sudo journalctl -u gotong -n 50 --no-pager

# 2. 活着
curl -s localhost:3000/healthz

# 3. 配置周界还对（TLS cookie / host 白名单 / 闸 / 代理信任 / 主钥位置）
gotong doctor

# 4. 定义还解析得动（工作流 + agent）
gotong check
```

`gotong doctor` 在**面向网络**的机器上会多印一段 `PERIMETER`（家用 loopback
hub 不会看到）。升级最容易悄悄改坏的就是这一段——新版本引入的默认值可能
和你 `gotong.env` 里的旧值打架。**出码 0 = 没有 ✖ 阻塞项**（⚠ 是忠告）。

再补两眼人工的：

- 打开 `/me`，确认挂起的审批项还在、还能批。
- 如果你接了 IM（飞书/微信/Telegram），发一句话给阿同，确认桥活着。

---

## 四、真的要回滚

只有一条路，按顺序：

```bash
sudo systemctl stop gotong

# 1. 代码退回你在 §1.2 记下的那个版本
git -C /srv/gotong checkout <旧 commit>
pnpm -C /srv/gotong install --frozen-lockfile && pnpm -C /srv/gotong build

# 2. 库也退回去 —— 这一步不能省，省了就撞 schema_from_the_future
gotong restore /srv/gotong/backups/gotong-<label>-<时间戳>.tar.gz /srv/gotong/.gotong

sudo systemctl start gotong
```

`gotong restore` 落盘前会先校验归档里的 `gotong-backup-manifest.json`
（文件清单 + sha256）。校验不过就不写——它宁可什么都不做。

**代价要说清楚**：从备份恢复 = 回到备份那一刻。备份之后产生的 transcript、
新审批、新记忆事实**全部丢失**。这就是为什么 §1.1 的备份要贴着升级打，
而不是用昨晚的 cron 那份。

---

## 五、把它变成例行

```cron
# 每周演练一次恢复 —— 没演练过的备份等于没有备份
0 4 * * 0  /srv/gotong/scripts/backup/drill.sh >> /var/log/gotong-drill.log 2>&1
```

升级前的备份是**额外**打的一份，不是复用 cron 那份。两者标签不同，
`prune.sh` 的 `gotong-*.tar.gz` 通配都认得。

完整的备份/清理/演练三件套见 [`../OPERATIONS.md`](../OPERATIONS.md)；
恢复演练的完整脚本和「防不住什么」的诚实清单见
[`THREAT-MODEL.md`](THREAT-MODEL.md)。

---

## 附：为什么不做 down 迁移

写得出 `down` SQL 的迁移是少数（加列可以，改语义、拆表、回填的不行），而
一个**半可逆**的迁移体系比明确的单向体系更危险——运维者会以为有退路，
真按下去才发现这一条恰好没有。所以我们选择：**永远单向 + 明确拒绝降级 +
备份是唯一回滚**。三句话记得住，2 点钟也不会记错。
