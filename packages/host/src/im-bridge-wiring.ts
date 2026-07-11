/**
 * im-bridge-wiring.ts — main.ts 的 IM 装配块整体外迁。
 *
 * 为什么存在:CARE-M2 要往 IM 装配里加断供接线,而 main.ts 行数棘轮只剩
 * 3 行余量——按 PUB·KIT·CARE 计划的前置腾挪惯例(同 LIFE 的
 * `armButlerSweeps` / FDE 的三抽取),把 setting-ops M5 当年的装配块原样
 * 搬进来,新增量在这里长,main.ts 净减。
 *
 * 语义逐字保留自 main.ts:
 * - IM `/setting` 复用与 web 总览同一个 live `adminHealth`,IM `status`
 *   永不与总览面板打架;
 * - IM caller 恒为 surface='im' + allowConfigWrite=false——config-write 与
 *   destructive-offline 在 ops-core 的 chokepoint 被拒(列出但指去 web/CLI);
 * - 入口闸是 admin bar(owner OR admin),按绑定的 Gotong userId 判,绝不
 *   按裸 IM handle;
 * - 平台仍逐个 env/vault 门控:什么都没配时 handle 惰性(hotStart 让首启
 *   向导写完 token 能热启,零桥零消费)。
 *
 * CARE-M2 新增(此文件的存在理由):llmOutage 接线——断供状态文件
 * `<space>/runtime/llm-outage.json`、语言随 host defaultLang、边沿播报骑
 * BE-M5 已同意成员(butler memory 根下枚举)。
 */

import { join } from 'node:path'

import type { Hub } from '@gotong/core'
import type { IdentityStore } from '@gotong/identity'

import type { AdminHealthSurface } from './admin-health.js'
import type { FailureLang } from './failure-translator.js'
import { ImApprovalService, type ImApprovalServiceOptions } from './im-approval-service.js'
import { startImBridges, type ImBridgesHandle, type ImLogger } from './im-bridge.js'
import { listOpsCommands, runOpsCommand } from './ops-core.js'

export interface ImBridgeWiringDeps {
  hub: Hub
  identity: IdentityStore
  log: ImLogger
  /** Workspace 根(GOTONG_SPACE)。reachable / runtime / butler 路径都从它长。 */
  spaceRoot: string
  /** 与 web 总览同一个 live 体检面——IM `status` 不许有第二个真相。 */
  health: AdminHealthSurface
  /** host 已解析的 GOTONG_DEFAULT_LANG——断供文案随它,不二次读 env。 */
  defaultLang: FailureLang
  /**
   * CARE-M5 — 只读活体探针(可选)。给了它,断供期间就按节律主动探 provider
   * 恢复并立刻播报,不必等下一条用户消息。宿主复用 onboarding key check 的解析
   * 链(lazy 读 ref),缺省 → 恢复仍只走反应式。
   */
  probeLiveness?: () => Promise<boolean>
  /**
   * IMA-M2 — 审批面双依赖(读=InboxStore.listPending,写=HostInboxService.resolve)。
   * 给了它,三个审批动词(/inbox /approve /deny)在绑定成员的 IM 里生效——只对
   * 写入时标了 `imApprovable` 白名单的 hub 内动作;缺省 → 动词回「未启用」,
   * 其余分支字节不变。风险裁决在写入方与 resolve 权威点,这里只是装配。
   */
  approvals?: ImApprovalServiceOptions
}

/** 装配并启动 IM 桥(语义=当年 main.ts 内联块 + CARE-M2 断供接线)。 */
export async function armImBridgeWiring(deps: ImBridgeWiringDeps): Promise<ImBridgesHandle | undefined> {
  const identityForIm = deps.identity
  const imIsOperator = (userId: string): boolean => {
    const role = identityForIm.getMembership(userId)?.role
    return role === 'owner' || role === 'admin'
  }
  // 「谁在命令模式」的旗子——handleImMessage 是无状态函数,状态在这持有,
  // host 生命周期一张 Map。
  const imSettingMode = new Map<string, boolean>()
  const imOpsCaller = { surface: 'im' as const, allowConfigWrite: false }
  const imOpsDeps = { spaceDir: deps.spaceRoot, env: process.env, health: deps.health }
  return startImBridges({
    hub: deps.hub,
    identity: deps.identity,
    log: deps.log,
    // DEPLOY-B1 — 始终持 handle,首启向导写完 vault token 能热启一座桥
    // (「粘完 token」与「bot 应答」之间零重启);什么都没配时 handle 惰性。
    hotStart: true,
    // F1 — 出站推送地基:绑定成员的每条入站消息都记下最新可达聊天,
    // 后续提醒 / 审批回推 / 播报走返回的 pushToMember。
    reachableDir: join(deps.spaceRoot, 'butler', 'reachable'),
    // IMA-M2 — /inbox /approve /deny 的审批面(有 inbox 才有)。
    ...(deps.approvals ? { approvals: new ImApprovalService(deps.approvals) } : {}),
    // CARE-M8 — 投递失败入盘、成员可达时重投的每成员 outbox。给了它,
    // reachable push 的失败不再只是一行日志(短暂失联的成员不漏播报/提醒)。
    outboxDir: join(deps.spaceRoot, 'butler', 'outbox'),
    // CARE-M2 — 断供不失联:状态文件 + 语言 + BE-M5 同意面的根。
    // CARE-M5 — 有 probeLiveness 时 im-bridge 再 arm 主动恢复探活定时器。
    llmOutage: {
      file: join(deps.spaceRoot, 'runtime', 'llm-outage.json'),
      lang: deps.defaultLang,
      butlerMemoryRoot: join(deps.spaceRoot, 'butler', 'memory'),
      ...(deps.probeLiveness ? { probeLiveness: deps.probeLiveness } : {}),
    },
    setting: {
      isOperator: imIsOperator,
      mode: imSettingMode,
      ops: {
        list: () => listOpsCommands(imOpsCaller),
        run: async (id, args) => {
          const r = await runOpsCommand(id, args, imOpsCaller, imOpsDeps)
          return { lines: r.lines }
        },
      },
    },
  })
}
