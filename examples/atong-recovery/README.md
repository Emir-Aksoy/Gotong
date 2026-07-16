# atong-recovery — 零中央节点,恢复兜底是你手里的三份档案

阿同框架及恢复能力 track(AFR)腿 C 的 capstone。Gotong 没有中央身份锚点:
没有「找回账号」的客服,也没有替你保管钥匙的云——**用户自持档案是唯一兜底**。
这个 demo 把「打包 → 灾难 → 新家恢复」整条链在一个确定性脚本里证死。

```bash
pnpm demo:atong-recovery   # 零网络、零 API key、零 LLM,exit 0 即全过
```

## 四幕

| 幕 | 证什么 | 硬断言 |
|---|---|---|
| 1 身份档 | 「我还是我」 | 恢复出的钥**独立复算** RFC 7638 指纹 === 原 kid;恢复目录恰好三件;每个字节扫不到主钥/令牌(结构性无密,不是恰好没带) |
| 2 关系档 | 「认识谁」≠「连得上」 | peers 非密投影行还在(endpoint / pinned_kid / trust_tier);诚实边界 note 印在**档案本体**(令牌在金库,重连要对端 re-mint);投影全文无令牌明文、无 vault 指针字段 |
| 3 搬家档 | 全量开机 | 用**恢复出来的**主钥真开金库、listPeers 两行俱在、getPeerToken 解出令牌明文 round-trip——boot 级证明;且档案不含关于自己的「上次备份」事实 |
| 4 M7 事实 | 阿同看的台账 | 三次打包每次刷新 `runtime/last-backup.json`,最后一档如实记 tier=full + includesMasterKey=true |

## 底下全是真件

- 真 node:crypto ES256 签名钥(kid = RFC 7638 指纹,与 STD-M1 同算法);
- 真 `@gotong/identity` 金库(`openIdentityStore` + `addPeer`:peer 令牌真信封加密);
- 真 `@gotong/cli` `backup()` 三档打包 + `restore()`(sha256 清单校验后原子落位);
- 真 M7「上次备份」事实文件(阿同 `backup_status` / 陈旧提醒 sweeper 看的就是它)。

## 这个 capstone 抓过的真 bug

写 M8 时幕 3 断言「档案不含关于自己的事实」变红,揪出 M7 的真缺口:首次备份靠
「先归档后写」天然不进档,但**第二次**全量备份会把上一轮的事实文件带进档案——
恢复进新家的空间会抱着旧家的台账装新鲜,压掉本该触发的「新家该打一份」提醒。
修法 = 事实文件与 `backups/` 同罪,staging 阶段全模式排除(见
`packages/cli/src/commands/backup-core.ts` 的 `shouldSkipForStaging`)。

深潜:[`docs/zh/ATONG-FRAMEWORK-RECOVERY.md`](../../docs/zh/ATONG-FRAMEWORK-RECOVERY.md)
