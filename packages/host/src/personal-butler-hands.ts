/**
 * personal-butler-hands.ts — HANDS-M2. 阿同的手(手 A:原生五工具执行器)。
 *
 * 给阿同一双**关在监狱里**的手:在自己的工作区里写文件、跑脚本、装脚手架。
 * 分级判定全部来自 M1 的 `hands-policy`(personal-butler,host-free 纯核),
 * 这里只做三件事:① 把五个工具挂成一个 `GovernedActionToolset`(服务端权威
 * classify + 每次执行前**重跑**同一份策略拿 resolvedPath/net,refuse 只回
 * isError **绝不重新 park**);② 真的动手——**五个动作全部在监狱里跑**(命令
 * 走 `wrapWithFsJail`;文件四动作走同一监狱里的一个 node 小助手,hub 进程自己
 * 从不用自己的权限碰工作区字节);③ 审计 + 上限。见 docs/zh/ATONG-HANDS.md §4.2/§十。
 *
 * ── 四道防线在这文件里的落点 ────────────────────────────────────────────────
 *   监狱      每次动手都过 `wrapWithFsJail`,`hardening` 全开:`hiddenPaths` =
 *             `<space>` + hub 用户 HOME + /home + /root + /run/user(存在的才盖)
 *             + `hands.json` 追加的;`hiddenFiles` = /etc/gotong.env + docker/podman
 *             套接字(存在的才盖);`readOnlyRoots` = 落在 HOME 里的 node 前缀(nvm)
 *             + `hands.json` 追加的;`unshareNet` 默认(离线),`unsharePid`,
 *             `denySharedTmp`(TMPDIR 指进工作区);监狱缺席(kind none)= 手不装。
 *   策略      M1 `classifyHandsToolCall` 是唯一分级权威;这里不重复分级逻辑。
 *   凭证缺席  子进程环境**从零拼**(PATH[剔掉藏起来的目录]/HOME=工作区/TMPDIR=
 *             工作区/.hands-tmp/LANG/TERM 几项),绝不 `...process.env`——hub 进程
 *             里的 `*_API_KEY`/主钥结构性到不了监狱里的命令(测试钉死);代理变量
 *             只在联网命令放行,且带用户名密码的代理 URL 也不放。
 *   审计+上限 每成员 `audit.jsonl`(argv/cwd/exit/时长/字节数/stdin 摘要与 sha256,
 *             **不记 stdout 正文**);硬上限走 `HANDS_LIMITS`,`hands.json` 只能在
 *             文件头钉死的区间内改三项;每成员并发 1(hub 级锁:第二条命令来了响亮
 *             拒,不排队);监狱内 `ulimit -c 0 -f <配额> -u 2048` 兜底。
 *
 * ── opt-in 三态(file-first,零新旋钮,116 冻结)──────────────────────────────
 *   `<space>/hands.json` 缺席 → 手不存在(与今天逐字节一致);
 *   在但形状不对(坏 JSON / 未知键 / 越界数值 / `enabled` 不是 true)→ warn + 不装;
 *   `enabled:true` 但监狱缺席 → warn(附装法)+ 不装。
 *
 * ── 诚实残余(见 ATONG-HANDS.md §十)─────────────────────────────────────────
 *   配额是动作前丈量不是运行期硬界(命令跑着的时候能把盘写满到 ulimit -f 单文件
 *   顶);内存不设界(无 cgroup);macOS 上 setsid 逃出进程组的守护进程**没有上界**
 *   ——命令退出时收的是进程组,setsid 出去的那个不在组里,hub 也没有一把可靠的
 *   扫帚(Linux 的 PID 命名空间随 bwrap 一起死,这条只在 macOS 成立);
 *   藏起来的以外的宿主文件系统(系统
 *   目录、/opt、其他用户 0755 的家)监狱里可读——「凭证结构性缺席」说的是 hub 自己
 *   的凭证,不是整台机器。
 */

import { spawn } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import {
  detectFsJail,
  isInsideRoots,
  wrapWithFsJail,
  type FsJailCapability,
  type FsJailHardening,
  type Logger,
} from '@gotong/core'
import {
  GovernedActionToolset,
  classifyHandsToolCall,
  HANDS_LIMITS,
  HANDS_TOOL_NAMES,
  nodeHandsFsProbe,
  type GovernedToolSpec,
  type GovernedVerdict,
  type HandsPolicyContext,
  type HandsPolicyDecision,
} from '@gotong/personal-butler'
import { ownerDir } from '@gotong/service-memory-file'
import { sanitizeApprovalText } from './approval-text.js'

// ─── Config(opt-in 文件)────────────────────────────────────────────────────

export const HANDS_CONFIG_FILE = 'hands.json'

/** 三项可调上限——`hands.json` 只能在这些区间内改;缺省取 `HANDS_LIMITS`。 */
export interface HandsConfig {
  maxRunSec: number
  maxOutputBytes: number
  maxWorkspaceBytes: number
  /**
   * 谁有手 —— 归属角色白名单,默认**只有 owner/admin**。
   *
   * 手是这台 hub 上最锋利的能力(tier 1 命令免审批、在监狱里任意执行),而
   * 「成员」这个角色的门槛在别处低得多(邀请一个人进来聊天 ≠ 给他一台能跑代码
   * 的机器)。默认收在 owner/admin 与 `pack_backup` 同姿态;要给成员手,得在
   * `hands.json` 里把 `member` 写出来——那一刻是一次明确的决定,不是默认值。
   */
  allowRoles: string[]
  /** 追加藏起来的绝对路径(目录或文件;不存在的 arm 时 warn 后跳过)。 */
  hidden?: string[]
  /** 藏起来的目录里再放开只读的绝对路径(操作者自己的工具链,如 ~/.cargo)。 */
  readOnly?: string[]
}

/** 归属角色闭集(镜像 identity 的 `Role`;host 侧刻意不 import 那个类型)。 */
const HANDS_ROLE_NAMES = Object.freeze(['owner', 'admin', 'member', 'viewer'] as const)

/** `allowRoles` 缺省值——只有 owner/admin 有手。 */
export const HANDS_DEFAULT_ALLOW_ROLES: readonly string[] = Object.freeze(['owner', 'admin'])

/** 可调区间(闭区间)。越界 = 形状不对 = warn + 不装,绝不 clamp 后静默装上。 */
export const HANDS_CONFIG_BOUNDS = Object.freeze({
  maxRunSec: [1, 3600] as const,
  maxOutputBytes: [1024, 1024 * 1024] as const,
  maxWorkspaceBytes: [1024 * 1024, 16 * 1024 * 1024 * 1024] as const,
})

/** `hidden`/`readOnly` 两个路径清单各最多这么多条、每条最长这么多字符。 */
export const HANDS_CONFIG_PATH_LIST_MAX = 32
const HANDS_CONFIG_PATH_MAX_LEN = 1024

const HANDS_CONFIG_KEYS = ['enabled', 'maxRunSec', 'maxOutputBytes', 'maxWorkspaceBytes', 'allowRoles', 'hidden', 'readOnly'] as const

const DEFAULT_CONFIG: HandsConfig = Object.freeze({
  maxRunSec: HANDS_LIMITS.maxRunSec,
  maxOutputBytes: HANDS_LIMITS.maxOutputBytes,
  maxWorkspaceBytes: HANDS_LIMITS.maxWorkspaceBytes,
  allowRoles: HANDS_DEFAULT_ALLOW_ROLES as string[],
})

/**
 * 读 `<space>/hands.json`。三态:缺席 → undefined(静默,与今天逐字节一致);
 * 形状不对 → warn + undefined(fail-closed);`enabled:true` → 合并区间内的
 * 可调项。`enabled:false` → info + undefined(明确关着,不算错)。
 */
export function loadHandsConfig(spaceRoot: string, logger: Pick<Logger, 'info' | 'warn'>): HandsConfig | undefined {
  const file = path.join(spaceRoot, HANDS_CONFIG_FILE)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    logger.warn('hands: hands.json unreadable — hands stay OFF', { file, err: String(err) })
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    logger.warn('hands: hands.json is not valid JSON — hands stay OFF', { file, err: String(err) })
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.warn('hands: hands.json must be a JSON object — hands stay OFF', { file })
    return undefined
  }
  const obj = parsed as Record<string, unknown>
  const unknown = Object.keys(obj).filter((k) => !(HANDS_CONFIG_KEYS as readonly string[]).includes(k))
  if (unknown.length > 0) {
    // 未知键多半是拼错的上限名(maxRunSecs…)——静默忽略会让操作者以为改成了 300s
    // 其实还是 120s;安全相关的配置宁可响亮不装,让人回头改对。
    logger.warn('hands: hands.json has unknown keys — hands stay OFF', { file, unknown, allowed: HANDS_CONFIG_KEYS })
    return undefined
  }
  if (obj.enabled === false) {
    logger.info('hands: hands.json enabled:false — hands OFF')
    return undefined
  }
  if (obj.enabled !== true) {
    logger.warn('hands: hands.json needs "enabled": true — hands stay OFF', { file })
    return undefined
  }
  const out: HandsConfig = { ...DEFAULT_CONFIG }
  for (const key of ['maxRunSec', 'maxOutputBytes', 'maxWorkspaceBytes'] as const) {
    const v = obj[key]
    if (v === undefined) continue
    const [lo, hi] = HANDS_CONFIG_BOUNDS[key]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) {
      logger.warn('hands: hands.json value out of range — hands stay OFF', { file, key, value: v, allowed: [lo, hi] })
      return undefined
    }
    out[key] = v
  }
  if (obj.allowRoles !== undefined) {
    const bad = roleListProblem(obj.allowRoles)
    if (bad) {
      // 拼错一个角色名(members / Admin)在白名单里是**静默收紧**——手看起来装上了,
      // 每个人却都被拒;而写错的人以为自己刚把手交给了谁。闭集之外一律不装。
      logger.warn('hands: hands.json allowRoles invalid — hands stay OFF', { file, problem: bad, allowed: HANDS_ROLE_NAMES })
      return undefined
    }
    out.allowRoles = obj.allowRoles as string[]
  }
  for (const key of ['hidden', 'readOnly'] as const) {
    const v = obj[key]
    if (v === undefined) continue
    const bad = pathListProblem(v)
    if (bad) {
      logger.warn('hands: hands.json path list invalid — hands stay OFF', { file, key, problem: bad })
      return undefined
    }
    out[key] = v as string[]
  }
  return out
}

/** `allowRoles` 形状门:非空字符串数组、每条来自角色闭集、不重复。 */
function roleListProblem(v: unknown): string | undefined {
  if (!Array.isArray(v)) return 'must be an array of role names'
  // 空数组 = 谁都没有手 = 就是「没开」,但它长得像「开了」。要关就 enabled:false。
  if (v.length === 0) return 'empty — use "enabled": false to turn hands off'
  const seen = new Set<string>()
  for (const r of v) {
    if (typeof r !== 'string' || !(HANDS_ROLE_NAMES as readonly string[]).includes(r)) return `unknown role: ${JSON.stringify(r)}`
    if (seen.has(r)) return `duplicate role: ${r}`
    seen.add(r)
  }
  return undefined
}

/** `hidden`/`readOnly` 形状门:字符串数组、每条绝对路径、无控制字节、有上限。 */
function pathListProblem(v: unknown): string | undefined {
  if (!Array.isArray(v)) return 'must be an array of absolute paths'
  if (v.length > HANDS_CONFIG_PATH_LIST_MAX) return `more than ${HANDS_CONFIG_PATH_LIST_MAX} entries`
  for (const p of v) {
    if (typeof p !== 'string' || p.length === 0 || p.length > HANDS_CONFIG_PATH_MAX_LEN) return 'entries must be non-empty strings (≤1024 chars)'
    if (!path.isAbsolute(p)) return `not absolute: ${p}`
    for (let i = 0; i < p.length; i++) {
      const c = p.charCodeAt(i)
      if (c < 32 || c === 127) return 'control character in path'
    }
  }
  return undefined
}

// ─── Jail shape(arm 时算一次,每成员共用)─────────────────────────────────

/**
 * 监狱里「藏什么 / 再放开什么 / PATH 剩什么」——hub 级事实,arm 时算一次。
 * 全部是**存在的**绝对路径(bwrap 要有挂载点),并附 realpath 拼写(Seatbelt 按
 * 规范路径匹配)。
 */
export interface HandsJailShape {
  hiddenDirs: string[]
  hiddenFiles: string[]
  readOnlyRoots: string[]
  /** 监狱里的 PATH:剔掉落在藏起来目录里的项(再放开的除外),补上 node 自己的 bin。 */
  pathEnv: string
  /** 被 `hands.json` 点名但不存在、被跳过的路径(arm 时 warn 一次)。 */
  skipped: string[]
}

/** 默认藏的目录候选(存在才盖;`<space>` 与 HOME 另加)。 */
const DEFAULT_HIDDEN_DIRS = ['/root', '/home', '/run/user']
/** 默认藏的文件候选(存在才盖):runbook 默认的 EnvironmentFile + 容器套接字。 */
const DEFAULT_HIDDEN_FILES = [
  '/etc/gotong.env',
  '/run/docker.sock',
  '/var/run/docker.sock',
  '/run/podman/podman.sock',
  '/var/run/podman/podman.sock',
]

export interface JailShapeProbe {
  homedir: () => string
  /** 'dir' | 'file'(含套接字/设备)| null(不存在或探不到)。 */
  kind: (p: string) => 'dir' | 'file' | null
  execPath: string
  pathEnv: string | undefined
}

const defaultProbe: JailShapeProbe = {
  homedir: () => homedir(),
  kind: (p) => {
    try {
      const st = statSync(p)
      return st.isDirectory() ? 'dir' : 'file'
    } catch {
      return null
    }
  },
  execPath: process.execPath,
  pathEnv: process.env.PATH,
}

export function jailShapeFor(spaceRoot: string, config: HandsConfig, probe: JailShapeProbe = defaultProbe): HandsJailShape {
  const skipped: string[] = []
  const dirs = new Set<string>()
  const files = new Set<string>()
  const addDir = (p: string): void => {
    for (const v of variants(p)) {
      // `/` 或空:盖住整个根等于把监狱焊死——这种 HOME(服务账号 HOME=/)直接跳过。
      if (v === '/' || v === '') continue
      dirs.add(v)
    }
  }
  addDir(spaceRoot)
  const home = probe.homedir()
  if (home && probe.kind(home) === 'dir') addDir(home)
  for (const d of DEFAULT_HIDDEN_DIRS) if (probe.kind(d) === 'dir') addDir(d)
  for (const f of DEFAULT_HIDDEN_FILES) if (probe.kind(f) === 'file') for (const v of variants(f)) files.add(v)
  for (const p of config.hidden ?? []) {
    const k = probe.kind(p)
    if (k === 'dir') addDir(p)
    else if (k === 'file') for (const v of variants(p)) files.add(v)
    else skipped.push(p)
  }
  const hiddenDirs = [...dirs]

  const ro = new Set<string>()
  // node 自己的前缀落在藏起来的目录里(nvm 装在 HOME)时再放开只读——文件动作的
  // 小助手与成员的 `node` 命令都要它;前缀是公共工具链,不是操作者的私产。
  const nodePrefix = path.dirname(path.dirname(realpathOrSelf(probe.execPath)))
  if (isInsideRoots(nodePrefix, hiddenDirs)) for (const v of variants(nodePrefix)) ro.add(v)
  for (const p of config.readOnly ?? []) {
    if (probe.kind(p) === 'dir') for (const v of variants(p)) ro.add(v)
    else skipped.push(p)
  }
  const readOnlyRoots = [...ro].filter((r) => isInsideRoots(r, hiddenDirs))

  const nodeBin = path.dirname(probe.execPath)
  const seen = new Set<string>()
  const pathEntries: string[] = []
  const visible = (p: string): boolean => {
    const vs = variants(p)
    const hidden = vs.some((v) => isInsideRoots(v, hiddenDirs))
    if (!hidden) return true
    return vs.some((v) => isInsideRoots(v, readOnlyRoots))
  }
  for (const entry of [nodeBin, ...(probe.pathEnv ?? '/usr/local/bin:/usr/bin:/bin').split(path.delimiter)]) {
    if (!entry || !path.isAbsolute(entry) || seen.has(entry)) continue
    seen.add(entry)
    if (visible(entry)) pathEntries.push(entry)
  }
  return { hiddenDirs, hiddenFiles: [...files], readOnlyRoots, pathEnv: pathEntries.join(path.delimiter), skipped }
}

/**
 * 「这份配置会不会把监狱拆了」——arm 前的 fail-closed 体检,有问题就不装。
 *
 * `jailShapeFor` 对拆监狱的写法是**静默**的(`/` 跳过、越界的 readOnly 过滤掉),
 * 那对「不存在的路径」是对的姿态,对「合法但危险」不是:一条
 * `readOnly:["/srv/hub"]` 会把整个 `<space>` 只读地摆回监狱里,而日志里只多一行
 * 「再放开」。这里逐条判死:
 *   - `<space>` 是 `/`(HOME=/ 的服务账号在自己家跑 hub):整棵树没法藏,监狱等于没有;
 *   - `hidden`/`readOnly` 写了 `/`:藏根=焊死,放开根=白藏;
 *   - `readOnly` 与 `<space>` 有任何重叠(是它的祖先、就是它、或在它里面):
 *     金库密文/agents.json/会话会被重新读到;
 *   - `readOnly` 是 hub 用户 HOME 的祖先(`/`、`/Users`、`/home`):同上,HOME 白藏。
 * 落在 HOME **里面**的 `readOnly`(~/.cargo、nvm 前缀)才是这个键存在的理由,放行。
 */
export function hardeningProblem(spaceRoot: string, config: HandsConfig, probe: JailShapeProbe = defaultProbe): string | undefined {
  const space = variants(path.resolve(spaceRoot))
  if (space.some((s) => s === '/')) return '<space> 就是根目录 /——整棵树没法藏,监狱等于没有'
  for (const key of ['hidden', 'readOnly'] as const) {
    for (const p of config[key] ?? []) {
      if (variants(path.resolve(p)).some((v) => v === '/')) return `${key} 里写了根目录 /`
    }
  }
  const home = probe.homedir()
  // HOME 是**藏起来的东西里唯一不来自常量表的一条**——它由 `probe.homedir()` 现问,
  // `jailShapeFor` 只在它是个真目录时 addDir。于是 `/`(或空)会被静默跳过:hub 用户的
  // 家目录连同落在里面的 gotong.env 一起留在监狱里可读,而日志上一个字都不会少。
  // 这类「藏不了」必须与 `<space>` 是 `/` 同罪——arm 不上,而不是装一双漏的手。
  // 相对路径同罪:`addDir` 会把它按 hub 进程当时的 cwd 解释,藏的于是是「碰巧那一刻
  // 的某个目录」而不是家目录——判死的三个条件与每次 spawn 前的复检逐字相同。
  if (home === '' || !path.isAbsolute(home) || variants(path.resolve(home)).some((h) => h === '/')) {
    return 'hub 用户的家目录解析成了根目录 /(或解析不出)——家目录没法藏,凭证会留在监狱里'
  }
  for (const p of config.readOnly ?? []) {
    const rs = variants(path.resolve(p))
    if (rs.some((r) => space.some((s) => isInsideRoots(s, [r]) || isInsideRoots(r, [s])))) {
      return `readOnly「${p}」与 <space> 重叠——金库与配置会被重新读到`
    }
    if (home && rs.some((r) => isInsideRoots(home, [r]) && !isInsideRoots(r, [home]))) {
      return `readOnly「${p}」把 hub 用户的家目录整个放开了`
    }
  }
  return undefined
}

// ─── Arm(boot 时一次)─────────────────────────────────────────────────────────

export type ButlerHandsKind = 'bwrap' | 'sandbox-exec'

/** 给 `my_status`「手」那一行用的事实——装没装、为什么。 */
export type ButlerHandsStatus =
  | { armed: true; kind: ButlerHandsKind }
  | { armed: false; reason: string }

/** 装上手的 hub 级事实(每成员 toolset 共用;不含任何成员态)。 */
export interface ButlerHandsHost {
  /** `<space>` 的绝对路径——监狱里整个盖住的那棵树。 */
  readonly spaceRoot: string
  /** `<space>/butler/hands`——各成员 `user/<id>/{workspace,audit.jsonl}` 的父目录。 */
  readonly handsRoot: string
  readonly kind: ButlerHandsKind
  readonly config: HandsConfig
  readonly shape: HandsJailShape
  /**
   * arm 时用过的探针,**每次 spawn 前再问一遍存在性**:docker 是 hub 起来之后才
   * 装的、`/run/user/<uid>` 是操作者登录后才出现的——只在 boot 算一次会让这些
   * 后长出来的特权入口在监狱里裸着(shape 是快照,这个才是当下)。
   */
  readonly probe: JailShapeProbe
  /**
   * 这个成员有没有手 —— **classify 与 execute 各问一遍,不缓存**:park 可能挂几
   * 小时,期间他可能被降权;缓存下来的「他当时是 admin」会让一次过期的批准照样
   * 兑现。`pack_backup` 两端各查一次是同一个理由。
   */
  readonly allowed: (userId: string) => boolean
  readonly logger: Logger
}

/** {@link handsHardening} 的入参——把「围墙长什么样」这件事拆出闭包,好让手 B 共用。 */
export interface HandsHardeningInput {
  hands: ButlerHandsHost
  /** 这次 spawn 允不允许联网(手 A 按四档策略逐条决定;手 B 恒 true——它得连自己的模型)。 */
  net: boolean
  /** 监狱里 HOME 的未 realpath 写法。 */
  homeRaw: string
  /** 同一个 HOME 的 realpath 写法——两种写法都要在只读层里放开。 */
  homeReal: string
}

/**
 * 一圈围墙,三个住客共用:手 A 的命令、手 A 的文件小助手、手 B 的外驱 coding
 * agent(M2b)。**刻意导出**——手 B 若自己再推一遍「该藏什么」,那就是第二圈墙,
 * 两圈墙迟早不一样,而不一样的那天没有人会收到通知。
 *
 * 藏什么**每次现算**:arm 时的 shape 是 boot 那一刻的快照,而 docker 可能是
 * hub 起来之后才装的、`/run/user/<uid>` 是操作者 ssh 进来才出现的、
 * `hands.json` 点名的路径可能当时还不存在(arm 时只 warn 跳过)。存在性一变,
 * 上次算好的清单就少一条特权入口。几次 statSync 对一次 spawn 是零头。
 */
export function handsHardening(args: HandsHardeningInput): FsJailHardening {
  const { hands, net, homeRaw, homeReal } = args
  const dirs = new Set(hands.shape.hiddenDirs)
  const files = new Set(hands.shape.hiddenFiles)
  // HOME 也现问一次:它不在下面那两张常量表里(`jailShapeFor` 从 `probe.homedir()`
  // 单独取),arm 时若它还不存在(容器里家目录后建、账号切换)就没进 shape,
  // 只补常量表等于永远补不回来它。
  const home = hands.probe.homedir()
  // 现问回来的 HOME 也要**现判死**(Codex 四轮 M5):arm 时判过的是 boot 那一刻的
  // 值,而这里重问的意义就在于它会变。变成 `/`、空、或相对路径 ⇒ 下面那个循环会
  // 静默跳过它(`v === '/'` continue / resolve 出别的东西),命令照跑而家目录没藏——
  // 恰好是 arm 时判死要避免的那个状态,只是晚了一步发生。停手,不装作藏好了。
  if (home === '' || !path.isAbsolute(home) || variants(path.resolve(home)).some((v) => v === '/')) {
    throw new Error(`家目录现在解析成「${home === '' ? '(空)' : home}」——藏不住它,这一步停手`)
  }
  for (const p of [home, ...DEFAULT_HIDDEN_DIRS, ...DEFAULT_HIDDEN_FILES, ...(hands.config.hidden ?? [])]) {
    if (p === '') continue
    const k = hands.probe.kind(p)
    if (k === null) continue
    for (const v of variants(p)) {
      if (v === '/' || v === '') continue
      if (k === 'dir') dirs.add(v)
      else files.add(v)
    }
  }
  // 监狱里的 HOME 是一个只读空目录——它落在被藏起来的 `<space>` 里,靠 core 的
  // 深度分层在藏之上再开一层只读把它露出来(与工作区可写层同一个机制)。
  //
  // **不能少这一层**:少了它 HOME 落在藏起来的那块里,bwrap 那边是块空 tmpfs
  // (`mkdir -p $HOME` 能成 → 点文件又能写了,只是活不过这条命令),seatbelt 那边
  // 是彻底读不了(工具直接报错)。两个执法者两种脾气,而只读空目录在两边**行为
  // 一致**:存在、可读、空、写不进去。所以没建出来就停手,不装作 HOME 是安全的。
  //
  // 与 `hardeningProblem` 禁止操作者用 `readOnly` 碰 `<space>` 不矛盾:那条禁的是
  // **操作者点名**的路径(`<space>/agents.json` 之类);这一条是 hub 自己建的、
  // 保持为空的一个叶子目录,里面结构上没有东西可读。
  return {
    unshareNet: !net,
    unsharePid: true,
    hiddenPaths: [...dirs],
    hiddenFiles: [...files],
    readOnlyRoots: [...hands.shape.readOnlyRoots, ...variants(homeRaw, homeReal)],
    denySharedTmp: true,
  }
}

export interface ButlerHands {
  /** 只有真装上时才有;factory 据此决定装不装五工具。 */
  host?: ButlerHandsHost
  status: ButlerHandsStatus
}

export interface ArmButlerHandsOptions {
  spaceRoot: string
  logger: Logger
  /**
   * 谁是谁 —— 归属角色查询(identity)。**不给 = 不装手**:`allowRoles` 说了
   * 只有 owner/admin 有手,而没有归属就答不出「他是不是 owner」;装上一双每次
   * 调用都得 fail-closed 拒的手,读起来像 bug,不如响亮地不装、说清原因。与
   * 「监狱缺席不装」同姿态,也与 `pack_backup` 在 identity 缺席时整个不装一致。
   */
  membershipRole?: (userId: string) => string | null | undefined
  /** 测试缝:不给 = 读 `<space>/hands.json`。 */
  config?: HandsConfig | undefined
  /** 测试缝:不给 = 真 `detectFsJail()`。 */
  detect?: () => Promise<FsJailCapability>
  /** 测试缝:不给 = 真机探针(HOME/存在性/node 路径/PATH)。 */
  probe?: JailShapeProbe
}

const JAIL_INSTALL_HINT =
  'Linux 装 bubblewrap(apt install bubblewrap;Ubuntu 23.10+ 需允许非特权 userns),macOS 自带 sandbox-exec;装好后重启 hub'

/**
 * boot 时调一次:读 opt-in 文件 → 只在开了的时候探监狱 → 返回 host(装上)或
 * 只带原因的 status(没装)。缺席时**零副作用**(不探监狱、不建目录、不打日志)。
 */
export async function armButlerHands(opts: ArmButlerHandsOptions): Promise<ButlerHands> {
  const spaceRoot = path.resolve(opts.spaceRoot)
  const config = 'config' in opts ? opts.config : loadHandsConfig(spaceRoot, opts.logger)
  if (!config) {
    return { status: { armed: false, reason: `未开启(<space>/${HANDS_CONFIG_FILE} 缺席或未 enabled)` } }
  }
  const membershipRole = opts.membershipRole
  if (!membershipRole) {
    opts.logger.warn('hands: hands.json enabled but no membership lookup — hands NOT installed (fail-closed)', {
      allowRoles: config.allowRoles,
    })
    return { status: { armed: false, reason: '查不到成员角色(identity 缺席)——手只给 ' + config.allowRoles.join('/') + ',查不到就不装' } }
  }
  const cap = await (opts.detect ?? detectFsJail)()
  if (cap.kind === 'none') {
    const why = cap.reason ?? '未知原因'
    opts.logger.warn('hands: hands.json enabled but no OS jail available — hands NOT installed (fail-closed)', {
      reason: why,
      hint: JAIL_INSTALL_HINT,
    })
    return { status: { armed: false, reason: `监狱缺席:${why}(${JAIL_INSTALL_HINT})` } }
  }
  const probe = opts.probe ?? defaultProbe
  const shape = jailShapeFor(spaceRoot, config, probe)
  const problem = hardeningProblem(spaceRoot, config, probe)
  if (problem) {
    // 一条配错的 `readOnly` 能把整个 `<space>` 只读地摆回监狱里(金库密文、
    // agents.json、会话全在里面),而它看起来只是「多放开一个工具链」。这类配置
    // 不 clamp、不忽略——响亮不装,让人回头改对。
    opts.logger.warn('hands: hands.json would defeat the jail — hands NOT installed (fail-closed)', { problem })
    return { status: { armed: false, reason: `配置会拆掉监狱:${problem}` } }
  }
  if (shape.skipped.length > 0) {
    opts.logger.warn('hands: hands.json hidden/readOnly entries that do not exist were skipped', { skipped: shape.skipped })
  }
  const host: ButlerHandsHost = {
    spaceRoot,
    handsRoot: path.join(spaceRoot, 'butler', 'hands'),
    kind: cap.kind,
    config,
    shape,
    probe,
    allowed: (userId) => {
      let role: string | null | undefined
      try {
        role = membershipRole(userId)
      } catch (err) {
        // 查不出来就是没有——归属库读不了的时候「谁都放行」会把这道门变成
        // 一次数据库抖动就能绕过的东西。
        opts.logger.warn('hands: membership lookup failed — treating as no hands', { userId, err: String(err) })
        return false
      }
      return typeof role === 'string' && config.allowRoles.includes(role)
    },
    logger: opts.logger,
  }
  opts.logger.info('hands: armed', {
    jail: cap.kind,
    allowRoles: config.allowRoles,
    maxRunSec: config.maxRunSec,
    maxOutputBytes: config.maxOutputBytes,
    maxWorkspaceBytes: config.maxWorkspaceBytes,
    hidden: shape.hiddenDirs,
    hiddenFiles: shape.hiddenFiles,
    readOnly: shape.readOnlyRoots,
    workspaces: `${host.handsRoot}/user/<userId>/workspace`,
  })
  return { host, status: { armed: true, kind: cap.kind } }
}

// ─── Toolset(每成员一份)────────────────────────────────────────────────────

export interface ButlerHandsToolsetDeps {
  userId: string
  hands: ButlerHandsHost
  logger?: Logger
  now?: () => number
}

/** 输出超过「上限 × 这个倍数」就提前终止(`yes` 之类的洪水不该白吃 CPU 到超时)。 */
export const HANDS_OUTPUT_KILL_MULTIPLIER = 64
/** 命令退出后再等 stdio 关闭的宽限;逃出进程组的守护进程抓着管道时不能无限等。 */
const STDIO_GRACE_MS = 1000
/**
 * **一行**带 argv 的台账最坏能有多大。全部项都由策略层封顶,所以这是推得出来的:
 *   - argv 总量 ≤ `maxArgvTotalChars`(单位是 UTF-16 码元),JSON 转义最坏
 *     **6 字节/码元**——落单代理项写成 `\udXXX` 六个 ASCII 字节。(控制字符同样是
 *     六字节,但它们在策略层就被 `hasHostileArgChar` 拒了,根本进不到这里。)
 *   - 每个元素还要 `"…",` 三个结构字节,元素数 ≤ `maxArgv`;
 *   - 其余字段(时间戳 / 工具名 / 判决码 / cwd / stdin 摘要 / 退出码 / 输出计数)给
 *     一块宽定额,免得再为每个字段各拍一个数。
 */
const AUDIT_WORST_ROW_BYTES =
  HANDS_LIMITS.maxArgvTotalChars * 6 + HANDS_LIMITS.maxArgv * 3 + 8 * 1024
/**
 * 一条动作最坏往台账里写多少。**三行不是两行**(Codex 六轮 M):分级(classify)、
 * 动手前(begin)、跑完(result)——三行都带 argv。上一版只数了前两行,于是「装得下
 * 40 条」这个说法本身就是错的(真容量约 26 条)。
 *
 * 这一条**不靠公式对不对**来保证:`personal-butler-hands.test.ts` 里有一条门,拿
 * 顶格 argv 真跑一次、量出这条动作实际写了多少字节,再断言 `阈值 / 实测 ≥ 40`。
 * 公式漂了、哪天多写一行带 argv 的、`maxArgvTotalChars` 调大了,那道门先红。
 */
const AUDIT_WORST_ACTION_BYTES = AUDIT_WORST_ROW_BYTES * 3
/** 台账里至少要装得下多少条**最坏情况**的动作。 */
export const AUDIT_MIN_ACTIONS = 40
/**
 * 轮转阈值。为什么不是随手一个 1MB(Codex 五轮 M):台账只留一代 `.1`,所以阈值太小
 * 会变成一根**反取证杠杆**——被注入的模型连着发几条顶格 argv 的 tier 1 命令(在监狱
 * 里、不需要审批),就能把更早的行挤出窗口。阈值从 argv 上限推出来,argv 上限哪天改了
 * 它自己跟着走,不会两个数字各自漂。
 *
 * 现在:~12.3MB,够装 40 条顶格动作;换成正常动作是**约一万四千条**——一条动作
 * 记**三行**(分级/动手前/跑完),一行真实命令大约 300 字节,所以每条约 900 字节。
 * (Codex 七轮 L7:上一版拿「12MB ÷ 300」写成了「四万多条动作」,那是四万多**行**,
 * 把行数当成了动作数。)
 *
 * **诚实残余**两条:
 *   1. 轮转天生是个窗口。发足够多的顶格动作仍然能把旧行推出去——挡不住,只能让它
 *      变贵且留痕:那些动作每一条自己都先被记了下来。
 *   2. 台账**不计入工作区配额**(它是工作区的兄弟目录,成员的命令删不掉它),所以
 *      最坏盘上占用是「每成员两代 ≈ 25MB × 成员数」,没有 hub 级总量闸。日常量级
 *      差着三个数量级(正常行 300 字节),但这是随成员数线性增长的一笔账。
 */
const AUDIT_ROTATE_BYTES = AUDIT_MIN_ACTIONS * AUDIT_WORST_ACTION_BYTES
export const AUDIT_ROTATE_BYTES_FOR_TEST = AUDIT_ROTATE_BYTES
const LIST_MAX_ENTRIES = 200
const LIST_SCAN_MAX = 5000
const BINARY_SNIFF_BYTES = 8192
/** 文件动作小助手(监狱内 node)的时限与输出顶(读 256KB 走 base64 要 ~350KB)。 */
const HELPER_TIMEOUT_MS = 30_000
const HELPER_TAIL_BYTES = HANDS_LIMITS.maxReadBytes * 2 + 64 * 1024
/** 监狱内的进程数上限(RLIMIT_NPROC 按 UID 全局计,hub 自己那份不受影响)。 */
const HANDS_ULIMIT_NPROC = 2048
/**
 * 审批标题里命令 / stdin 各自最多露这么多字符。**故意给得宽**:标题是审批的人
 * 唯一会读的那行字,截得越狠,「批准」这个动作就越接近盲签(一条 `sh -c` 的真正
 * 动作往往在第 120 个字符之后)。截断处一律附「共 N 字符,已截断」——见 `clipSafe`。
 */
const ARGV_TITLE_CHARS = 600
const STDIN_PREVIEW_CHARS = 240
/**
 * 台账里 argv 的上限。**刻意等于策略层允许的 argv 总量**——「可批准的命令必须是
 * 可留档的命令」(Codex 四轮 H2):策略拒掉超过这个数的命令,于是台账那一行恒是整条
 * 命令,审批卡那句「完整命令见审计台账」才不是空头支票。两者用同一个常量,不是各写
 * 一个数字然后祈祷它们不漂。(同一个上限也给文件动作的 path 当兜底。)
 */
const AUDIT_ARGV_CHARS = HANDS_LIMITS.maxArgvTotalChars
/**
 * 工作区文件数硬顶(与字节配额并列):字节配额挡不住「一百万个空文件」——每次
 * 写/跑前的用量丈量会被拖成秒级,列目录会吃内存。超了同样响亮拒、指路清理。
 */
export const HANDS_MAX_WORKSPACE_ENTRIES = 100_000
/** 工作区里给监狱内命令当 TMPDIR 的子目录(算配额,不自动清)。 */
export const HANDS_TMP_SUBDIR = '.hands-tmp'
/** 工作区里给包管理器当缓存根的子目录(HOME 只读之后缓存的落点;算配额)。 */
export const HANDS_CACHE_SUBDIR = '.hands-cache'

/**
 * 不够格时给模型的那句话——**说清楚是资格问题、别让它重试**,并指一条真出路
 * (把步骤写给成员)。名单从配置现拼:操作者把 `member` 加进 `allowRoles` 之后,
 * 这句话不能还在说「只开给 owner/admin」。`pack_backup` 同姿态。
 */
export function handsRefuseRole(allowRoles: readonly string[]): string {
  return (
    `你在这台 hub 上没有动手的权限(手只开给 ${allowRoles.join('/')};这不是重试能解决的)。` +
    '把要做的步骤写清楚交给成员,由有权限的人来跑。'
  )
}

interface Busy {
  what: string
  since: number
}

/**
 * hub 级「每成员一双手在忙」锁——按 handsRoot+userId 键,不是 toolset 实例态:同一
 * 成员在同一进程里被建了两份 toolset(会话窗与 IM 各一份)也只有一双手。
 */
const BUSY = new Map<string, Busy>()

/**
 * 五个 governed 工具挂成一个 toolset。构造**零副作用**(工作区目录第一次用到才
 * 建)——装了手但成员从没伸过手,盘上就没有它的痕迹。
 */
export function buildButlerHandsToolset(deps: ButlerHandsToolsetDeps): GovernedActionToolset {
  const { userId, hands } = deps
  const log = deps.logger ?? hands.logger
  const now = deps.now ?? (() => Date.now())
  const cfg = hands.config
  const memberRoot = ownerDir(hands.handsRoot, { kind: 'user', id: userId })
  const workspaceRaw = path.join(memberRoot, 'workspace')
  /**
   * 监狱里的 HOME —— 一个**永远空、永远只读**的目录,不是工作区。
   *
   * 让 HOME 指向工作区看起来省事(缓存有地方落),代价是**在工作区里写文件是
   * tier 1 免审批的**:模型可以先无声地写一份 `~/.gitconfig`(`core.pager` 挂个
   * 命令)或 `~/.npmrc`(换个 registry),再请成员批准一条看起来人畜无害的
   * `npm install`。审批卡上那行字是真的,行为却在批准之前就被改写了。
   *
   * 环境配置是**看不见的**,工作区里的文件是这次活儿**看得见的一部分**——这条
   * 线就画在这里:HOME 只读到根本放不进点文件,缓存另给明确的落点(见 childEnv)。
   */
  const homeRaw = path.join(memberRoot, 'home')
  const auditPath = path.join(memberRoot, 'audit.jsonl')
  const busyKey = `${path.resolve(hands.handsRoot)}::${userId}`

  let workspaceReal: string | undefined
  let homeReal: string | undefined

  function ensureWorkspace(): { ok: true; root: string } | { ok: false; reason: string } {
    if (workspaceReal) return { ok: true, root: workspaceReal }
    try {
      mkdirSync(workspaceRaw, { recursive: true, mode: 0o700 })
      // HOME 与工作区同生:监狱要它当挂载点(bwrap 得有个真目录),而它必须先
      // 存在、后被 ro-bind——反过来就是「HOME 不存在 → 只读层被静默跳过 →
      // HOME 落回被藏起来的 <space> 里的某个路径」。
      mkdirSync(homeRaw, { recursive: true, mode: 0o700 })
      workspaceReal = realpathSync.native(workspaceRaw)
      homeReal = realpathSync.native(homeRaw)
      return { ok: true, root: workspaceReal }
    } catch (err) {
      const reason = `工作区建不起来:${errMsg(err)}`
      log.warn('hands: workspace unavailable', { userId, dir: workspaceRaw, err: String(err) })
      return { ok: false, reason }
    }
  }

  /**
   * 监狱里的 HOME —— 一处回答,两个消费者(jail 的只读层与子进程 env)。少了它就
   * 停手:两边任一边偷偷回落,HOME 就落回被藏起来的那块地方(见 `hardening`)。
   */
  function jailHome(): string {
    if (!homeReal) throw new Error('监狱里的 HOME 还没建出来——这一步停手(不拿藏起来的路径当家目录)')
    return homeReal
  }

  function ctx(root: string): HandsPolicyContext {
    return { workspaceRoot: root, fs: nodeHandsFsProbe }
  }

  function rel(root: string, abs: string): string {
    const r = path.relative(root, abs)
    return r === '' ? '.' : r
  }

  /**
   * 错误文本给模型前把 hub 的绝对路径换成占位——路径本身就是布局情报(哪台机器、
   * 哪个用户、装在哪、工具链在哪),而错误文本是注入过的模型能读到的东西。
   * 换的清单就是监狱的形状(`<space>`/工作区/藏起来的目录/再放开的只读根),不是
   * 只换 `<space>` 一条:`ENOENT: /home/ubuntu/.nvm/...` 一样是情报。**长的先换**,
   * 否则 `<space>` 会把落在它下面的工作区路径切成两半。
   */
  function redact(text: string): string {
    const pairs: Array<[string, string]> = []
    for (const v of variants(workspaceRaw)) pairs.push([v, '<workspace>'])
    if (workspaceReal) pairs.push([workspaceReal, '<workspace>'])
    for (const v of variants(hands.spaceRoot)) pairs.push([v, '<space>'])
    for (const d of hands.shape.hiddenDirs) pairs.push([d, '<hidden>'])
    for (const r of hands.shape.readOnlyRoots) pairs.push([r, '<toolchain>'])
    pairs.sort((a, b) => b[0].length - a[0].length)
    let out = text
    for (const [from, to] of pairs) if (from.length > 1) out = out.split(from).join(to)
    return out
  }

  /**
   * 「**我这一趟**记过结果行了吗」——每次调用自己的一格状态(Codex 四轮 M4)。
   *
   * 原来这里是一个 toolset 级的计数器。但同一成员的两次调用可以并发到同一份
   * toolset(第二次会被 BUSY 拒——**而那次拒绝也写一行**):第一趟早退回来时只看到
   * 「计数涨了」,于是跳过兜底,恰好把自己那条失败漏掉。计数器答的是「有人记过吗」,
   * 要问的却是「我记过吗」。AsyncLocalStorage 让这格状态跟着调用走,并发的另一趟
   * 拿的是另一格;不同成员各有各的闭包,本来就不会串。
   */
  const CALL = new AsyncLocalStorage<{ recorded: boolean }>()

  /** 写一行;**返回写没写成**——调用方据此 fail-closed(留痕是四道防线之一)。 */
  function audit(row: Record<string, unknown>): boolean {
    try {
      try {
        if (statSync(auditPath).size > AUDIT_ROTATE_BYTES) renameSync(auditPath, `${auditPath}.1`)
      } catch {
        /* no file yet */
      }
      // `stage` 默认 'execute'(绝大多数行是动手那一刻记的),分级/动手前那一刻记的行
      // 显式传 'classify'/'begin' 盖掉——台账自己说得清这行是在哪一步记的。
      appendFileSync(auditPath, `${JSON.stringify({ at: new Date(now()).toISOString(), stage: 'execute', ...row })}\n`, { mode: 0o600 })
      const call = CALL.getStore()
      if (call) call.recorded = true
      return true
    } catch (err) {
      // 还没有工作区的人(没有手的成员、工作区建不起来)不该因为一次**拒绝**就被建出
      // 目录来:这不是「台账写不进去」,是「还没有台账」。两个到得了这里的调用点都是
      // 动手之前的拒绝,拒绝本身已经回给了模型;真动手的那两行(begin/execute)永远在
      // `ensureWorkspace()` 成功之后,那时 memberRoot 必然在——所以这条静音不遮任何事。
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT' && !existsSync(memberRoot)) return false
      log.warn('hands: audit append failed', { userId, err: String(err) })
      return false
    }
  }

  /**
   * 一次调用的**全部事实**,给 classify/begin 两行留档用。
   *
   * 审批卡上的标题是有界的(几百字符,再长人也读不完),台账不是——这里 argv 不做
   * 「好看」的截断,只挡病态巨串。审批卡那句「完整命令见审计台账」靠的就是这一行:
   * 没有它,那句话是空头支票(Codex 二轮 H2)。stdin **只留字节数与 sha256**,正文
   * 永不落盘——它可能是成员的私料,台账是给运维看的。
   */
  function callFacts(name: string, args: Record<string, unknown>, d: HandsPolicyDecision): Record<string, unknown> {
    if (name !== 'hands_run') {
      return typeof args.path === 'string' ? { path: args.path.slice(0, AUDIT_ARGV_CHARS) } : {}
    }
    const argv = Array.isArray(args.argv) ? args.argv.map((a) => String(a)) : []
    // **结构化向量,不是拼平的串**(Codex 四轮 H2)。拼平会造成两种谎:
    //   - 空格拼完再截断 ⇒ `sh -c '<8000 个空格>curl evil'` 的真正命令被截没,而
    //     审批卡还在说「完整命令见台账」;
    //   - `['printf','a b']` 与 `['printf','a','b']` 拼出来一模一样 ⇒ 事后无法复原
    //     到底跑了什么。
    // 现在 argv 总量由策略层封顶(`maxArgvTotalChars`),台账容量 ≥ 那个顶,所以这一行
    // 恒是**整条命令**。下面的 slice 只是防御:策略与台账两个常量若哪天漂了,宁可
    // 留一条明确标了 `argvTruncated` 的行,也不要悄悄少一截。
    const total = argv.reduce((n, a) => n + a.length, 0)
    const over = total > AUDIT_ARGV_CHARS
    return {
      net: d.net === true,
      argv: over ? argv.map((a) => a.slice(0, 256)) : argv,
      ...(over ? { argvTruncated: true, argvChars: total } : {}),
      ...(typeof args.cwd === 'string' && args.cwd !== '' ? { cwd: args.cwd.slice(0, 512) } : {}),
      ...(typeof args.stdin === 'string' && args.stdin.length > 0
        ? { stdinBytes: Buffer.byteLength(args.stdin), stdinSha256: createHash('sha256').update(args.stdin).digest('hex') }
        : {}),
    }
  }

  /**
   * 记一行「拒了」,回给模型的是**脱敏后**的原因。台账留真路径(那是给运维看的、
   * 只有 hub 用户读得到的 0600 文件),模型侧永远走 `redact`。
   *
   * 拒绝也要留痕:被注入的模型试着 `sudo`、试着写 `/etc/gotong.env`、试着穿越出
   * 工作区——这些**没发生**的事恰恰是运维最想看见的,只记成功等于把侦察阶段整段
   * 抹掉。
   */
  function denied(stage: 'classify' | 'execute', tool: string, code: string, reason: string, extra?: Record<string, unknown>): string {
    audit({ stage, tool, ok: false, code, why: reason.slice(0, 200), ...extra })
    return redact(reason)
  }

  /**
   * 审计写不进去就不动手(fail-closed)。留痕是四道防线之一——盘满、权限被改、
   * 目录被换成只读时继续执行,等于把一次真实的越界变成没人看得见的事。
   *
   * **证据就是那一行本身**:分级写判决行、动手前写 begin 行,写成了才往下走。
   * 早先那个「零字节 append 当探针」被 Codex 二轮打掉了——`appendFileSync(p,'')`
   * 在只读文件系统等情形下不必然报错,而且它证明的是「当时能打开」,不是「这一行
   * 记下来了」。事后 append 失败仍只 warn:动作已经发生,拒绝收不回(§10.4)。
   */
  const AUDIT_UNWRITABLE = '审计台账写不进去——手不动:不留痕的执行不是这双手允许的状态'

  /** 工作区用量;`over` = 已超上限(字节含 extra 的预算,或文件数超顶)。 */
  function quota(root: string, extra: number): { bytes: number; entries: number; over: boolean } {
    const m = measureTree(root, cfg.maxWorkspaceBytes, HANDS_MAX_WORKSPACE_ENTRIES)
    return { ...m, over: m.bytes + extra > cfg.maxWorkspaceBytes || m.entries > HANDS_MAX_WORKSPACE_ENTRIES }
  }

  function quotaMsg(q: { bytes: number; entries: number }): string {
    const what =
      q.entries > HANDS_MAX_WORKSPACE_ENTRIES
        ? `工作区文件数超过 ${HANDS_MAX_WORKSPACE_ENTRIES}`
        : `工作区已用 ${fmtBytes(q.bytes)},上限 ${fmtBytes(cfg.maxWorkspaceBytes)}`
    return `${what}——先用 hands_rm 清理(node_modules/缓存/产物)再继续`
  }

  /**
   * 每次 spawn 都同一份 hardening——命令与文件小助手不许各说各话。手 B(M2b)
   * 走的是同一个 `handsHardening`,所以它拿到的也**只能是**同一圈围墙。
   */
  function hardening(net: boolean): FsJailHardening {
    return handsHardening({ hands, net, homeRaw, homeReal: jailHome() })
  }

  const tools: GovernedToolSpec[] = [
    {
      name: 'hands_run',
      description:
        `在你的监狱工作区里执行一条命令(argv 数组,不经 shell;要管道/重定向就 argv:["sh","-c","…"])。` +
        `离线命令直接跑;要联网的(npm/pip/git 拉取、curl…)设 net:true 或按命令名自动推断→每次都先请成员确认。` +
        `cwd 相对工作区(默认根);stdin 可选(成员在审批时会看到摘要);timeoutSec 最多 ${cfg.maxRunSec}。` +
        `命令看不到 hub 的配置与凭证(<space>、hub 用户的家目录整个不可见),只能写工作区(TMPDIR 与包管理器缓存都在工作区里)。` +
        `HOME 是一个只读空目录——点文件(~/.npmrc、~/.gitconfig…)写不进去,要改工具行为请用命令行参数,或在这一条命令里临时设环境变量。` +
        `输出只回最后 ${fmtBytes(cfg.maxOutputBytes)}——长输出请重定向到文件再 hands_read。` +
        `不能做的:sudo/装系统包/管服务/容器/定时任务这类系统级动作(会被拒,请把步骤写给成员)。`,
      inputSchema: {
        type: 'object',
        properties: {
          argv: { type: 'array', items: { type: 'string' }, minItems: 1, description: '命令与参数,逐项一个字符串' },
          cwd: { type: 'string', description: '相对工作区的目录;默认工作区根' },
          stdin: { type: 'string', description: '喂给命令标准输入的文本;不给=空输入' },
          timeoutSec: { type: 'integer', minimum: 1, maximum: cfg.maxRunSec, description: `秒;默认与最大 ${cfg.maxRunSec}` },
          net: { type: 'boolean', description: 'true=需要联网(每次先请成员确认);false=明确离线;不给=按命令名推断' },
        },
        required: ['argv'],
        additionalProperties: false,
      },
      defaultVerdict: { decision: 'approve', reason: '在工作区里执行命令' },
    },
    {
      name: 'hands_write',
      description: `在工作区里写一个文件(覆盖;自动建父目录;≤${fmtBytes(HANDS_LIMITS.maxWriteBytes)};不经符号链接)。路径相对工作区。`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的文件路径' },
          content: { type: 'string', description: '整个文件内容(UTF-8)' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      defaultVerdict: { decision: 'approve', reason: '在工作区里写文件' },
    },
    {
      name: 'hands_read',
      description: `读工作区里的一个文件(≤${fmtBytes(HANDS_LIMITS.maxReadBytes)},超出只回前面并注明;二进制只回摘要)。路径相对工作区。`,
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对工作区的文件路径' } },
        required: ['path'],
        additionalProperties: false,
      },
      defaultVerdict: { decision: 'approve', reason: '读工作区里的文件' },
    },
    {
      name: 'hands_list',
      description: `列工作区里一个目录(名字/类型/大小,最多 ${LIST_MAX_ENTRIES} 项)。path 相对工作区,不给=根。`,
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对工作区的目录;默认根' } },
        additionalProperties: false,
      },
      defaultVerdict: { decision: 'approve', reason: '列工作区目录' },
    },
    {
      name: 'hands_rm',
      description: '删工作区里的一个文件或目录(递归;不能删工作区根;不经符号链接)。路径相对工作区。',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对工作区的路径' } },
        required: ['path'],
        additionalProperties: false,
      },
      defaultVerdict: { decision: 'approve', reason: '删工作区里的东西' },
    },
  ]

  return new GovernedActionToolset({
    tools,
    // 服务端权威分级——M1 策略是唯一权威;这里只叠两件执行器才知道的事实:
    // 工作区建不起来(refuse)、要 park 的联网命令先看配额(超了就别浪费成员一次审批)。
    classify: (name, args): GovernedVerdict => {
      // 「他有没有手」排在最前面:不够格的成员连工作区目录都不该被建出来。
      if (!hands.allowed(userId)) return { decision: 'refuse', reason: denied('classify', name, 'role', handsRefuseRole(cfg.allowRoles)) }
      const ws = ensureWorkspace()
      if (!ws.ok) return { decision: 'refuse', reason: denied('classify', name, 'workspace_unavailable', ws.reason) }
      const d = classifyHandsToolCall(name, args, ctx(ws.root))
      if (d.verdict.decision === 'refuse') {
        return { ...d.verdict, reason: denied('classify', name, d.code, d.verdict.reason, { tier: d.tier }) }
      }
      if (d.verdict.decision === 'approve') {
        const q = quota(ws.root, 0)
        if (q.over) {
          return { decision: 'refuse', reason: denied('classify', name, 'quota', quotaMsg(q), { tier: d.tier, bytes: q.bytes, entries: q.entries }) }
        }
      }
      // 分级过了就落一行判决——这一行同时是三件事:
      //  ① **审批卡那句「完整命令见审计台账」的兑现**(全 argv + cwd + stdin 指纹);
      //  ② 「台账写得进去」的真证据(写成了才继续,替掉了原来的零字节探针);
      //  ③ park 可能挂几小时,决定与动手之间的这段时间也该有存档。
      const ok = audit({
        stage: 'classify',
        tool: name,
        ok: true,
        code: d.code,
        tier: d.tier,
        verdict: d.verdict.decision,
        ...callFacts(name, args, d),
      })
      if (!ok) return { decision: 'refuse', reason: AUDIT_UNWRITABLE }
      return d.verdict
    },
    describe: (name, args) => {
      if (name === 'hands_run' && Array.isArray(args.argv)) {
        // 标题是审批的人**唯一**会读的那行字(/me 审批卡与 IM 的一行),所以它得说全:
        //  · 命令要么完整,要么明说截掉了多少(截断处不吭声 = 把动作藏在省略号后面);
        //  · 在哪跑(cwd)决定这条命令碰得到什么,不写出来等于没说清;
        //  · stdin 是命令的一部分——「联网执行 sh -c 'sh'」配一段 stdin,真正的动作
        //    全在 stdin 里。
        const cwd = typeof args.cwd === 'string' && args.cwd !== '' && args.cwd !== '.' ? clipSafe(args.cwd, 120) : ''
        const where = cwd === '' ? '工作区' : `工作区的 ${cwd} 目录`
        const stdinNote =
          typeof args.stdin === 'string' && args.stdin.length > 0 ? ` · stdin ${Buffer.byteLength(args.stdin)}B「${previewText(args.stdin)}」` : ''
        return `阿同要在${where}里联网执行:${describeArgv(args.argv as unknown[])}${stdinNote}`
      }
      const p = typeof args.path === 'string' ? clipSafe(args.path, 200) : '.'
      const verb = name === 'hands_write' ? '写' : name === 'hands_rm' ? '删' : name === 'hands_read' ? '读' : '列'
      return `阿同要在工作区里${verb}:${p}`
    },
    // 整个 execute 跑在 `CALL` 的作用域里,兜底那格状态才跟着**这一趟**走。
    execute: async (name, args) =>
      CALL.run({ recorded: false }, async () => {
      // 再问一遍(不是复述 classify 的答案):park 挂着的这几小时里他可能被降权,
      // 而批准是对**那一刻够格的他**发的。
      if (!hands.allowed(userId)) return err(denied('execute', name, 'role', handsRefuseRole(cfg.allowRoles)))
      const ws = ensureWorkspace()
      if (!ws.ok) return err(denied('execute', name, 'workspace_unavailable', ws.reason))
      // 执行前重跑同一份策略(TOCTOU 缩窗 + 拿 resolvedPath/net)。refuse → isError,
      // 绝不重新 park:park 的裁决权在 classify,执行器只会拒不会再问。
      const d = classifyHandsToolCall(name, args, ctx(ws.root))
      if (d.verdict.decision === 'refuse') {
        return err(denied('execute', name, d.code, d.verdict.reason, { tier: d.tier }))
      }
      const busy = BUSY.get(busyKey)
      if (busy) {
        const why = `上一条命令(${busy.what})还在跑——手最多同时做一件事,等它结束再来`
        return err(denied('execute', name, 'busy', why, { tier: d.tier }))
      }
      // 动手前先落一行 `begin`,写成了才动手。这是真正的「审计写得进去」证据:
      // 事后那行 append 失败只剩 warn(动作已经发生,拒绝收不回),所以证据必须在
      // 动作**之前**写。同时它也是**进程**崩溃后的线索——只有 begin 没有结果的那
      // 一行,说的正是「开始了,没回来」。**只到这一步**:`appendFileSync` 不 fsync,
      // 整机断电时这行可能还在页缓存里没落盘,故这条不承诺断电语义(Codex 四轮)。
      if (!audit({ stage: 'begin', tool: name, ok: true, code: d.code, tier: d.tier, ...callFacts(name, args, d) })) {
        return err(AUDIT_UNWRITABLE)
      }
      BUSY.set(busyKey, { what: name === 'hands_run' && Array.isArray(args.argv) ? describeArgv(args.argv as unknown[], 80) : name, since: now() })
      // begin 已经记过一行了,但它不是**结果**。从这里开始重新计:兜底要补的是
      // 「动作回来了却没人说它怎么样」。
      const call = CALL.getStore()!
      call.recorded = false
      try {
        let out: { text: string; isError?: boolean }
        switch (name) {
          case 'hands_run':
            out = await run(ws.root, args, d)
            break
          case 'hands_write':
            out = await write(ws.root, args, d)
            break
          case 'hands_read':
            out = await read(ws.root, d)
            break
          case 'hands_list':
            out = await list(ws.root, d)
            break
          case 'hands_rm':
            out = await remove(ws.root, d)
            break
          default:
            out = err(`不认识的手部动作(${name})`)
        }
        // 每个动作自己记一行,但四个文件动作只在**成功**那条路上记:早退的
        // 「不是目录」「不存在」「监狱不让」一个字都不会留下(Codex 二轮 M6)。
        // 与其在七八处早退各补一行(下一个早退又会漏),不如在这里数:这一趟一行
        // 都没记 → 补一行兜底。台账的合同是「每次动手都有痕」,不是「每处记得写」。
        if (!call.recorded) {
          audit({ tool: name, ok: !out.isError, code: d.code, tier: d.tier, ...(out.isError ? { why: out.text.slice(0, 200) } : {}) })
        }
        return out.isError ? { ...out, text: redact(out.text) } : out
      } catch (e) {
        audit({ tool: name, ok: false, code: d.code, tier: d.tier, why: `threw:${errMsg(e).slice(0, 200)}` })
        return err(redact(`执行时出错:${errMsg(e)}`))
      } finally {
        BUSY.delete(busyKey)
      }
      }),
  })

  // ── hands_run ──────────────────────────────────────────────────────────────

  async function run(root: string, args: Record<string, unknown>, d: HandsPolicyDecision): Promise<{ text: string; isError?: boolean }> {
    const argv = args.argv as string[]
    const cwd = d.resolvedPath ?? root
    const net = d.net === true
    let timeoutSec = cfg.maxRunSec
    if (args.timeoutSec !== undefined) {
      const t = args.timeoutSec
      if (typeof t !== 'number' || !Number.isInteger(t) || t < 1) return err(`timeoutSec 要是 ≥1 的整数(最多 ${cfg.maxRunSec})`)
      timeoutSec = Math.min(t, cfg.maxRunSec)
    }
    let stdin: string | undefined
    if (args.stdin !== undefined) {
      if (typeof args.stdin !== 'string') return err('stdin 要是字符串')
      if (Buffer.byteLength(args.stdin) > HANDS_LIMITS.maxWriteBytes) return err(`stdin 太大(> ${fmtBytes(HANDS_LIMITS.maxWriteBytes)}),先写成文件再重定向`)
      stdin = args.stdin
    }
    try {
      if (!statSync(cwd).isDirectory()) return err(`cwd「${rel(root, cwd)}」不是目录`)
    } catch {
      return err(`cwd「${rel(root, cwd)}」不存在——先 hands_write/hands_run mkdir 建出来`)
    }
    const q = quota(root, 0)
    if (q.over) return err(quotaMsg(q))

    // 监狱内先套一层 /bin/sh:建 TMPDIR、压 ulimit(不出 core、单文件不超配额、
    // 进程数封顶),然后 exec 真命令——`$0` 是命令,`$1 $2` 是两个数字,再 shift。
    const wrapped = wrapWithFsJail({
      command: '/bin/sh',
      args: ['-c', ULIMIT_SCRIPT, argv[0]!, String(Math.ceil(cfg.maxWorkspaceBytes / 512)), String(HANDS_ULIMIT_NPROC), ...argv.slice(1)],
      allowedRoots: variants(root, workspaceRaw),
      cwd,
      kind: hands.kind,
      hardening: hardening(net),
    })
    if (!wrapped.jailed) {
      // 结构上到不了(armed 才有 toolset),但监狱包不上就绝不裸跑。
      return err('监狱包不上这条命令(kind none)——手不动')
    }

    const started = now()
    const result = await spawnJailed(wrapped.command, wrapped.args, {
      cwd,
      env: childEnv(root, net, { home: jailHome(), pathEnv: hands.shape.pathEnv }),
      stdin,
      timeoutMs: timeoutSec * 1000,
      tailBytes: cfg.maxOutputBytes,
      killAtBytes: cfg.maxOutputBytes * HANDS_OUTPUT_KILL_MULTIPLIER,
    })
    const durationMs = now() - started

    audit({
      tool: 'hands_run',
      ok: !result.spawnError && !result.timedOut && !result.overflow && result.code === 0,
      code: d.code,
      tier: d.tier,
      net,
      jail: hands.kind,
      argv: argv.map((a) => (a.length > 200 ? `${a.slice(0, 200)}…` : a)),
      cwd: rel(root, cwd),
      ...(stdin !== undefined ? { stdinBytes: Buffer.byteLength(stdin), stdinSha256: createHash('sha256').update(stdin).digest('hex') } : {}),
      exit: result.code,
      signal: result.signal,
      ms: durationMs,
      out: result.stdout.total,
      err: result.stderr.total,
      timedOut: result.timedOut,
      overflow: result.overflow,
      ...(result.spawnError ? { spawnError: result.spawnError } : {}),
    })

    const lines: string[] = []
    if (result.spawnError) {
      return err(`起不来:${result.spawnError}`)
    }
    const exitWord = result.code === null ? `signal ${result.signal ?? '?'}` : `exit ${result.code}`
    lines.push(
      `${exitWord} · ${(durationMs / 1000).toFixed(1)}s · stdout ${result.stdout.total}B · stderr ${result.stderr.total}B · ${net ? '联网' : '离线'} · cwd ${rel(root, cwd)}`,
    )
    if (result.timedOut) lines.push(`⏱ 超时(${timeoutSec}s),已终止整个进程组`)
    if (result.overflow) {
      lines.push(`输出超过 ${fmtBytes(cfg.maxOutputBytes * HANDS_OUTPUT_KILL_MULTIPLIER)},已提前终止——请把输出重定向到文件再 hands_read`)
    }
    const { out, errTail, outNote, errNote } = shapeOutput(result.stdout, result.stderr, cfg.maxOutputBytes)
    if (outNote) lines.push(outNote)
    if (errNote) lines.push(errNote)
    lines.push('--- stdout ---')
    lines.push(out.length > 0 ? out : '(空)')
    if (errTail.length > 0) {
      lines.push('--- stderr ---')
      lines.push(errTail)
    }
    const failed = result.timedOut || result.overflow || result.code !== 0
    return { text: lines.join('\n'), isError: failed || undefined }
  }

  // ── 文件四动作:监狱里的 node 小助手 ─────────────────────────────────────────

  /**
   * 文件动作也在监狱里跑——hub 进程绝不用自己的权限 open 工作区里的路径。
   * 为什么:监狱里的命令能在检查与动手之间把目录换成指向 `<space>` 的链接
   * (TOCTOU),hub 若自己 open 就会以 hub 的权限读走 vault / 写坏 agents.json;
   * 小助手在同一座监狱里,链接换过去内核照样拒。代价是一次 node 冷启动。
   */
  async function helper(root: string, op: 'read' | 'list' | 'write' | 'rm', helperArgs: Record<string, unknown>, stdin?: Buffer): Promise<
    { ok: true; value: Record<string, unknown> } | { ok: false; code: string; message: string }
  > {
    const wrapped = wrapWithFsJail({
      command: process.execPath,
      args: ['-e', HELPER_SRC, '--', op, JSON.stringify(helperArgs)],
      allowedRoots: variants(root, workspaceRaw),
      cwd: root,
      kind: hands.kind,
      hardening: hardening(false),
    })
    if (!wrapped.jailed) return { ok: false, code: 'nojail', message: '监狱包不上文件小助手(kind none)——手不动' }
    const r = await spawnJailed(wrapped.command, wrapped.args, {
      cwd: root,
      env: childEnv(root, false, { home: jailHome(), pathEnv: hands.shape.pathEnv }),
      stdin,
      timeoutMs: HELPER_TIMEOUT_MS,
      tailBytes: HELPER_TAIL_BYTES,
      killAtBytes: HELPER_TAIL_BYTES * 4,
    })
    if (r.spawnError) return { ok: false, code: 'spawn', message: `文件小助手起不来:${r.spawnError}` }
    if (r.timedOut) return { ok: false, code: 'timeout', message: `文件动作超时(${HELPER_TIMEOUT_MS / 1000}s)——目录太大?先 hands_rm 清理` }
    const raw = r.stdout.bytes().toString('utf8').trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.slice(raw.lastIndexOf('\n') + 1))
    } catch {
      const tail = r.stderr.bytes().toString('utf8').slice(-400)
      return { ok: false, code: 'proto', message: `文件小助手没有回话(exit ${r.code ?? r.signal ?? '?'})${tail ? `:${tail}` : ''}` }
    }
    if (!parsed || typeof parsed !== 'object') return { ok: false, code: 'proto', message: '文件小助手回话形状不对' }
    const obj = parsed as Record<string, unknown>
    if (typeof obj.error === 'string') return { ok: false, code: obj.error, message: typeof obj.message === 'string' ? obj.message : '' }
    return { ok: true, value: obj }
  }

  function fileErr(root: string, abs: string, code: string, message: string, verb: string): { text: string; isError: true } {
    const p = rel(root, abs)
    switch (code) {
      case 'ENOENT':
        return err(`「${p}」不存在`)
      case 'ELOOP':
        return err(`「${p}」是符号链接——不经链接${verb}`)
      case 'EISDIR':
        return err(`「${p}」是目录${verb === '读' ? '——用 hands_list 看' : `,${verb}不了`}`)
      case 'ENOTDIR':
        return err(`「${p}」不是目录——用 hands_read 看`)
      case 'ENXIO':
      case 'ENOTFILE':
        return err(`「${p}」不是普通文件(管道/套接字)${verb === '读' ? '' : `,${verb}不了`}`)
      case 'EACCES':
      case 'EPERM':
        return err(`「${p}」监狱不让${verb}(路径落在工作区外或被藏起来的地方)`)
      case 'escape':
        return err(`「${p}」越出工作区`)
      default:
        return err(`${verb}「${p}」失败:${code}${message ? ` ${message}` : ''}`)
    }
  }

  // ── hands_write ────────────────────────────────────────────────────────────

  async function write(root: string, args: Record<string, unknown>, d: HandsPolicyDecision): Promise<{ text: string; isError?: boolean }> {
    const abs = d.resolvedPath!
    const content = args.content
    if (typeof content !== 'string') return err('content 要是字符串')
    const buf = Buffer.from(content, 'utf8')
    if (buf.byteLength > HANDS_LIMITS.maxWriteBytes) {
      return err(`内容太大(${fmtBytes(buf.byteLength)} > ${fmtBytes(HANDS_LIMITS.maxWriteBytes)}),分几个文件写`)
    }
    const q = quota(root, buf.byteLength)
    if (q.over) return err(quotaMsg(q))
    if (abs === root) return err('路径指向工作区根本身,写不了')
    const r = await helper(root, 'write', { path: rel(root, abs) }, buf)
    if (!r.ok) return fileErr(root, abs, r.code, r.message, '写')
    audit({ tool: 'hands_write', ok: true, code: d.code, tier: d.tier, path: rel(root, abs), bytes: buf.byteLength })
    return { text: `已写 ${rel(root, abs)}(${fmtBytes(buf.byteLength)})` }
  }

  // ── hands_read ─────────────────────────────────────────────────────────────

  async function read(root: string, d: HandsPolicyDecision): Promise<{ text: string; isError?: boolean }> {
    const abs = d.resolvedPath!
    const r = await helper(root, 'read', { path: rel(root, abs), max: HANDS_LIMITS.maxReadBytes, sniff: BINARY_SNIFF_BYTES })
    if (!r.ok) return fileErr(root, abs, r.code, r.message, '读')
    const size = typeof r.value.size === 'number' ? r.value.size : 0
    const got = typeof r.value.got === 'number' ? r.value.got : 0
    const binary = r.value.binary === true
    audit({ tool: 'hands_read', ok: true, code: d.code, tier: d.tier, path: rel(root, abs), bytes: size })
    if (binary) return { text: `${rel(root, abs)}:二进制文件(${fmtBytes(size)}),不显示内容` }
    const data = Buffer.from(typeof r.value.data === 'string' ? r.value.data : '', 'base64')
    const note = size > got ? `,只显示前 ${fmtBytes(got)}` : ''
    return { text: `${rel(root, abs)}(${fmtBytes(size)}${note}):\n${data.toString('utf8')}` }
  }

  // ── hands_list ─────────────────────────────────────────────────────────────

  async function list(root: string, d: HandsPolicyDecision): Promise<{ text: string; isError?: boolean }> {
    const abs = d.resolvedPath!
    const r = await helper(root, 'list', { path: rel(root, abs), max: LIST_MAX_ENTRIES, scan: LIST_SCAN_MAX })
    if (!r.ok) return fileErr(root, abs, r.code, r.message, '列')
    const total = typeof r.value.total === 'number' ? r.value.total : 0
    const more = r.value.more === true
    const entries = Array.isArray(r.value.entries) ? (r.value.entries as Array<Record<string, unknown>>) : []
    const rows = entries.map((e) => {
      const n = typeof e.n === 'string' ? e.n : '?'
      switch (e.t) {
        case 'link':
          return `[link] ${n}`
        case 'dir':
          return `[dir]  ${n}/`
        case 'file':
          return `[file] ${n}${typeof e.s === 'number' ? ` (${fmtBytes(e.s)})` : ''}`
        default:
          return `[other] ${n}`
      }
    })
    audit({ tool: 'hands_list', ok: true, code: d.code, tier: d.tier, path: rel(root, abs), entries: total, more })
    const count = more ? `超过 ${LIST_SCAN_MAX} 项(只扫了前 ${LIST_SCAN_MAX})` : `${total} 项`
    const head = `工作区/${rel(root, abs)}:${count}${total > entries.length ? `,只显示前 ${LIST_MAX_ENTRIES}` : ''}`
    return { text: total === 0 ? `${head}\n(空目录)` : `${head}\n${rows.join('\n')}` }
  }

  // ── hands_rm ───────────────────────────────────────────────────────────────

  async function remove(root: string, d: HandsPolicyDecision): Promise<{ text: string; isError?: boolean }> {
    const abs = d.resolvedPath!
    if (abs === root) return err('不能删工作区根——要清空就 hands_list 后逐项删')
    // Node 的递归删不跟随符号链接(链接本身被 unlink,目标原地留)——门测试钉死。
    const r = await helper(root, 'rm', { path: rel(root, abs) })
    if (!r.ok) return fileErr(root, abs, r.code, r.message, '删')
    audit({ tool: 'hands_rm', ok: true, code: d.code, tier: d.tier, path: rel(root, abs) })
    return { text: `已删 ${rel(root, abs)}` }
  }
}

/**
 * 监狱内套的那层 shell:建 TMPDIR(在工作区里,hub 自己一个字节都不写)、压
 * ulimit(每条 2>/dev/null:硬上限比要的低就保持原样,绝不因此起不来)、exec 真命令。
 * `$0`=命令,`$1`=单文件字节上限(512 字节块),`$2`=进程数上限,再 shift 两个。
 */
const ULIMIT_SCRIPT =
  // 非递归 mkdir:BSD `mkdir -p` 会从根逐级 mkdir(),在藏起来的祖先(<space>)处吃 EPERM 而放弃;
  // TMPDIR 的父目录就是工作区,一级 mkdir 够了(已存在 = 静默)。
  '[ -n "$TMPDIR" ] && [ ! -d "$TMPDIR" ] && mkdir -- "$TMPDIR" 2>/dev/null; ' +
  'ulimit -c 0 2>/dev/null; ulimit -f "$1" 2>/dev/null; ulimit -u "$2" 2>/dev/null; shift 2; exec "$0" "$@"'

/**
 * 监狱里跑的文件小助手(node -e)。零依赖、一次调用一件事、结果一行 JSON 到
 * stdout;错误也是 JSON(`{error, message}`),exit 恒 0——出码留给「起不来/超时」。
 * 路径相对 cwd(=工作区 realpath),小助手自己再拒一次越界(纵深;真边界是监狱)。
 * 用 String.fromCharCode(10) 而不是转义换行:这段源码活在 TS 字符串里。
 */
const HELPER_SRC = [
  "'use strict';",
  "const fs=require('fs'),path=require('path'),C=fs.constants;",
  'const op=process.argv[1],a=JSON.parse(process.argv[2]||"{}"),root=process.cwd(),NL=String.fromCharCode(10);',
  'function out(o){process.stdout.write(JSON.stringify(o)+NL)}',
  "function fail(code,msg){out({error:String(code||'EIO'),message:String(msg||'')});process.exit(0)}",
  "function within(p){const r=path.resolve(root,String(p||'.'));const rel=path.relative(root,r);if(rel.startsWith('..')||path.isAbsolute(rel))fail('escape','');return r}",
  'try{',
  " if(op==='read'){const abs=within(a.path);let fd;try{fd=fs.openSync(abs,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK)}catch(e){fail(e.code,e.message)}",
  "  const st=fs.fstatSync(fd);if(st.isDirectory()){fs.closeSync(fd);fail('EISDIR','')}if(!st.isFile()){fs.closeSync(fd);fail('ENOTFILE','')}",
  '  const want=Math.min(st.size,a.max|0),buf=Buffer.alloc(want);let got=0;while(got<want){const n=fs.readSync(fd,buf,got,want-got,got);if(n===0)break;got+=n}fs.closeSync(fd);',
  '  let binary=false;const head=Math.min(got,a.sniff|0);for(let i=0;i<head;i++){if(buf[i]===0){binary=true;break}}',
  "  out({size:st.size,got:got,binary:binary,data:binary?'':buf.subarray(0,got).toString('base64')})}",
  " else if(op==='list'){const abs=within(a.path);const ents=[];let more=false,dir;try{dir=fs.opendirSync(abs)}catch(e){fail(e.code,e.message)}",
  '  for(;;){const e=dir.readSync();if(e===null)break;if(ents.length>=(a.scan|0)){more=true;break}ents.push(e)}dir.closeSync();',
  '  ents.sort(function(x,y){return x.name<y.name?-1:x.name>y.name?1:0});',
  "  const rows=ents.slice(0,a.max|0).map(function(e){if(e.isSymbolicLink())return{n:e.name,t:'link'};if(e.isDirectory())return{n:e.name,t:'dir'};",
  "   if(e.isFile()){let s;try{s=fs.lstatSync(path.join(abs,e.name)).size}catch(_){}return s===undefined?{n:e.name,t:'file'}:{n:e.name,t:'file',s:s}}return{n:e.name,t:'other'}});",
  '  out({entries:rows,total:ents.length,more:more})}',
  " else if(op==='write'){const abs=within(a.path);const data=fs.readFileSync(0);fs.mkdirSync(path.dirname(abs),{recursive:true});let fd;",
  '  try{fd=fs.openSync(abs,C.O_WRONLY|C.O_CREAT|C.O_TRUNC|C.O_NOFOLLOW|C.O_NONBLOCK,parseInt("644",8))}catch(e){fail(e.code,e.message)}',
  "  if(!fs.fstatSync(fd).isFile()){fs.closeSync(fd);fail('ENOTFILE','')}fs.writeSync(fd,data);fs.closeSync(fd);out({bytes:data.length})}",
  " else if(op==='rm'){const abs=within(a.path);try{fs.lstatSync(abs)}catch(e){fail('ENOENT','')}fs.rmSync(abs,{recursive:true,force:false});out({ok:true})}",
  " else fail('EOP','unknown op');",
  '}catch(e){fail(e&&e.code,e&&e.message)}',
].join(' ')

// ─── Spawn(监狱内跑一条命令)───────────────────────────────────────────────

interface SpawnJailedOptions {
  cwd: string
  env: Record<string, string>
  stdin?: string | Buffer
  timeoutMs: number
  tailBytes: number
  killAtBytes: number
}

interface SpawnJailedResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: TailBuffer
  stderr: TailBuffer
  timedOut: boolean
  overflow: boolean
  spawnError?: string
}

/** 只留最后 `cap` 字节,但记住总量——回执要如实说「共 N 字节只显示最后 M」。 */
export class TailBuffer {
  total = 0
  private chunks: Buffer[] = []
  private held = 0
  constructor(private readonly cap: number) {}
  push(chunk: Buffer): void {
    this.total += chunk.length
    this.chunks.push(chunk)
    this.held += chunk.length
    // 整块丢头:丢掉第一块后剩下的仍 ≥ cap 就整块丢。
    while (this.chunks.length > 1 && this.held - this.chunks[0]!.length >= this.cap) {
      this.held -= this.chunks.shift()!.length
    }
    // 还超就切第一块的头(此时 excess < 第一块长度,不变量由上面的循环保证)。
    if (this.held > this.cap) {
      const excess = this.held - this.cap
      this.chunks[0] = this.chunks[0]!.subarray(excess)
      this.held -= excess
    }
  }
  /** 当前保留的尾巴(长度恒 ≤ cap)。 */
  bytes(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

/**
 * 在跑的进程组:hub 自己退出时一并收掉(bwrap 有 --die-with-parent,macOS 的
 * sandbox-exec 没有;不收的话 hub 重启后监狱里的命令会孤儿化跑到自己结束)。
 */
const ACTIVE_GROUPS = new Set<number>()
let exitHookInstalled = false
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const pid of ACTIVE_GROUPS) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
  })
}

function spawnJailed(command: string, args: string[], opts: SpawnJailedOptions): Promise<SpawnJailedResult> {
  return new Promise((resolve) => {
    const stdout = new TailBuffer(opts.tailBytes)
    const stderr = new TailBuffer(opts.tailBytes)
    let timedOut = false
    let overflow = false
    let settled = false
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // 自成进程组:超时/洪水/正常退出后都 kill(-pid) 连孙进程一起收(bwrap 与
        // --unshare-pid 下 bwrap 即 init,杀它整个命名空间随之消失)。
        detached: true,
      })
    } catch (e) {
      resolve({ code: null, signal: null, stdout, stderr, timedOut, overflow, spawnError: errMsg(e) })
      return
    }
    installExitHook()
    if (child.pid !== undefined) ACTIVE_GROUPS.add(child.pid)

    const killTree = (): void => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }
    const finish = (extra?: { spawnError?: string }): void => {
      if (settled) return
      settled = true
      if (child.pid !== undefined) ACTIVE_GROUPS.delete(child.pid)
      clearTimeout(timer)
      if (grace) clearTimeout(grace)
      try {
        child.stdout?.destroy()
        child.stderr?.destroy()
      } catch {
        /* ignore */
      }
      resolve({
        code: exited?.code ?? null,
        signal: exited?.signal ?? null,
        stdout,
        stderr,
        timedOut,
        overflow,
        ...(extra?.spawnError ? { spawnError: extra.spawnError } : {}),
      })
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, opts.timeoutMs)
    let grace: NodeJS.Timeout | undefined

    const onData = (buf: TailBuffer) => (chunk: Buffer) => {
      buf.push(chunk)
      if (!overflow && stdout.total + stderr.total > opts.killAtBytes) {
        overflow = true
        killTree()
      }
    }
    child.stdout?.on('data', onData(stdout))
    child.stderr?.on('data', onData(stderr))
    child.on('error', (e) => {
      // ENOENT for the wrapper itself (sandbox-exec/bwrap missing) lands here;
      // an inner command that is missing shows up as the wrapper's exit code + stderr.
      exited = exited ?? { code: null, signal: null }
      finish({ spawnError: errMsg(e) })
    })
    child.on('exit', (code, signal) => {
      exited = { code, signal }
      // 命令一退出就收整个进程组:命令自己 fork 出去、还没走的孙进程(后台
      // `&`、守护进程)不该活过这一条命令——下一条动作开始时工作区里没有别人。
      killTree()
      // 退出后 stdio 通常紧跟着 close;逃出进程组的守护进程抓着管道时给个宽限就收工。
      grace = setTimeout(() => finish(), STDIO_GRACE_MS)
    })
    child.on('close', (code, signal) => {
      exited = exited ?? { code, signal }
      finish()
    })
    if (child.stdin) {
      child.stdin.on('error', () => {
        /* EPIPE when the child exits early — not our problem */
      })
      if (opts.stdin !== undefined) child.stdin.end(opts.stdin)
      else child.stdin.end()
    }
  })
}

/**
 * 子进程环境**从零拼**——这是「凭证结构性缺席」的落点:hub 进程里的
 * `*_API_KEY`/主钥/IM token 一个都不进监狱。只在联网命令放行代理变量,且
 * URL 里带 `user:pass@` 的代理不放(那也是凭证)。
 *
 * `ATONG_HANDS=1` 是给监狱里脚本认「我在阿同手里」的标记(出站、hub 自己从不读),
 * 刻意不带 `GOTONG_` 前缀——那是 hub 旋钮的姓,env-registry 门按前缀清点(116 冻结),
 * 一个不是旋钮的名字不该占旋钮的额。
 */
export const HANDS_ENV_MARKER = 'ATONG_HANDS'

const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy']

export interface ChildEnvOptions {
  /**
   * 监狱里的 HOME —— 那个只读空目录(**必填**:少传就退回「HOME=工作区」,
   * 而那正是要堵的洞;让类型系统在编译期问这个问题,别让它变成谁记不记得住)。
   */
  home: string
  /** 监狱里的 PATH(arm 时算好的过滤结果);不给 = hub 的 PATH 原样。 */
  pathEnv?: string
  /** 测试缝:代替 process.env 读代理/USER。 */
  source?: NodeJS.ProcessEnv
}

export function childEnv(workspace: string, net: boolean, opts: ChildEnvOptions): Record<string, string> {
  const src = opts.source ?? process.env
  const cache = path.join(workspace, HANDS_CACHE_SUBDIR)
  const env: Record<string, string> = {
    PATH: opts.pathEnv ?? src.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: opts.home,
    TMPDIR: path.join(workspace, HANDS_TMP_SUBDIR),
    // HOME 只读之后缓存得另有落点,否则每次 `npm i` 都栽在 EROFS 上。缓存放工作区
    // 里是安全的:**缓存不改行为,配置才改行为**——这条线正是 HOME 只读要画的那条。
    // 这张表天生列不全(每个工具一个变量名),但它现在站在**方便**那一侧而不是安全
    // 那一侧:漏掉一个,那个工具当场报错,模型自己 `sh -c 'FOO=$PWD/... cmd'` 就能
    // 绕过去(tier 1,不花成员一次审批)。漏掉一条的代价是一次失败,不是一个洞。
    XDG_CACHE_HOME: cache,
    NPM_CONFIG_CACHE: path.join(cache, 'npm'),
    PIP_CACHE_DIR: path.join(cache, 'pip'),
    [HANDS_ENV_MARKER]: '1',
    LANG: src.LANG ?? 'C.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
  }
  for (const k of ['USER', 'LOGNAME'] as const) {
    const v = src[k]
    if (v) env[k] = v
  }
  if (net) {
    for (const k of PROXY_VARS) {
      const v = src[k]
      if (v && !proxyUrlHasUserinfo(v)) env[k] = v
    }
  }
  return env
}

/**
 * 带凭证的代理值——**只要出现 `@` 就算**,不解析 URL。curl/git/pip 都接受
 * 无 scheme 的 `user:pass@host:3128`,按 `://` 之后找 authority 的写法会把这种
 * 形状判成「干净」并把操作者的代理密码交进监狱。宁可漏放一个古怪但无害的代理
 * 值(联网命令自己会说连不上),也不能漏出一次凭证。`NO_PROXY` 之类的主机名清单
 * 本来就不含 `@`,不受影响。
 */
export function proxyUrlHasUserinfo(value: string): boolean {
  return value.includes('@')
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function err(text: string): { text: string; isError: true } {
  return { text, isError: true }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

/** 同一路径的两种写法(原样 + realpath;macOS /tmp→/private/tmp 之类)去重。 */
function variants(...paths: string[]): string[] {
  const out = new Set<string>()
  for (const p of paths) {
    out.add(p)
    try {
      out.add(realpathSync.native(p))
    } catch {
      /* not existing yet — raw spelling only */
    }
  }
  return [...out]
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)}MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

/**
 * 洗干净并截断,**把截了多少说出来**。审批的人不该以为看到的就是全部。
 *
 * 清洗本身交给 `approval-text.ts`(审批文案只有一处卫生标准,`buildButlerApprovalPrompt`
 * 用的是同一个);这里只管截断与「截了要说」。`tail` 是**给不给出处**:
 * argv 说得起「完整命令见审计台账」——因为分级那一刻真写了一行带全 argv 的判决;
 * stdin 说不起——台账只留字节数与 sha256,正文永不落盘(那可能是成员的私料)。
 * 承诺一个不存在的地方,比不承诺更坏(Codex 三轮 H2)。
 */
function clipSafe(s: string, max: number, tail = ''): string {
  const clean = sanitizeApprovalText(s)
  if (clean.length <= max) return clean
  // 按**码点**切,不按 UTF-16 码元(Codex 七轮 L6,与 `clipApprovalText` 同一条):
  // `slice` 会把 emoji / 增补平面的字劈成半个代理项,审批卡上凭空多一个原文里没有
  // 的替换符——这行字的全部意义就是「它和真正要跑的命令是同一件事」。
  const cps = Array.from(clean)
  if (cps.length <= max) return clean
  return `${cps.slice(0, max).join('')}…(共 ${cps.length} 字符,已截断${tail})`
}

function describeArgv(argv: unknown[], max = ARGV_TITLE_CHARS): string {
  const s = argv
    .map((a) => (typeof a === 'string' ? (/\s/.test(a) ? JSON.stringify(a) : a) : String(a)))
    .join(' ')
  return clipSafe(s, max, ',完整命令见审计台账')
}

/** 审批标题里的 stdin 摘要。 */
function previewText(s: string): string {
  return clipSafe(s, STDIN_PREVIEW_CHARS)
}

/**
 * 工作区用量(只数普通文件,符号链接不跟不数):字节 + 文件/目录项数。任一超过
 * 上限就提前收工——判「超没超」不需要精确总量,大工作区(node_modules)不必走完。
 * 流式 `opendirSync`:一口气 `readdirSync` 一个百万项目录会先把整张表吃进内存。
 * 这是 hub 侧唯一碰工作区的只读动作(只数不读),链接换目录最多让计数失真。
 */
export function measureTree(root: string, capBytes: number, capEntries: number): { bytes: number; entries: number } {
  let bytes = 0
  let entries = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let handle: import('node:fs').Dir
    try {
      handle = opendirSync(dir)
    } catch {
      continue
    }
    try {
      for (;;) {
        const e = handle.readSync()
        if (e === null) break
        entries++
        if (entries > capEntries) return { bytes, entries }
        if (e.isSymbolicLink()) continue
        const p = path.join(dir, e.name)
        if (e.isDirectory()) {
          stack.push(p)
        } else if (e.isFile()) {
          try {
            bytes += lstatSync(p).size
          } catch {
            /* raced away */
          }
          if (bytes > capBytes) return { bytes, entries }
        }
      }
    } finally {
      try {
        handle.closeSync()
      } catch {
        /* ignore */
      }
    }
  }
  return { bytes, entries }
}

function shapeOutput(
  stdout: TailBuffer,
  stderr: TailBuffer,
  cap: number,
): { out: string; errTail: string; outNote?: string; errNote?: string } {
  // stderr 是排错的关键,先给它最多一半;stdout 拿剩下的。合起来不超 cap。
  let errBuf = stderr.bytes()
  const errCap = Math.floor(cap / 2)
  if (errBuf.length > errCap && stdout.total > 0) errBuf = errBuf.subarray(errBuf.length - errCap)
  let outBuf = stdout.bytes()
  const outCap = Math.max(0, cap - errBuf.length)
  if (outBuf.length > outCap) outBuf = outBuf.subarray(outBuf.length - outCap)
  const outNote = stdout.total > outBuf.length ? `(stdout 共 ${stdout.total} 字节,只保留最后 ${outBuf.length} 字节)` : undefined
  const errNote = stderr.total > errBuf.length ? `(stderr 共 ${stderr.total} 字节,只保留最后 ${errBuf.length} 字节)` : undefined
  return {
    out: outBuf.toString('utf8'),
    errTail: errBuf.toString('utf8'),
    ...(outNote ? { outNote } : {}),
    ...(errNote ? { errNote } : {}),
  }
}

/** 五个工具名(与 M1 策略同一份常量)——AFR 门与 factory 用它核对。 */
export { HANDS_TOOL_NAMES }

// `existsSync` is only used by tests' probe fallbacks; keep the import honest.
export const _handsFsProbeExists = existsSync
