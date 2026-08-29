/**
 * `ops-config-write` — the deterministic (NON-AI) config-write tier behind the
 * unified `setting` console (M3). Owner-gated, validated BEFORE anything lands on
 * disk, and audited. It writes only the two things the host actually reads as
 * configuration files, plus a read-only effective view:
 *
 *   1. A managed env file `<space>/gotong.env` — a WHITELIST of non-secret
 *      deterministic knobs (mode / ports / open-browser). The launcher and a
 *      documented systemd `EnvironmentFile=` source it BEFORE the host starts,
 *      so the host still only ever reads `process.env` — the boot read path is
 *      byte-for-byte unchanged. Changes take effect on the NEXT restart (there
 *      is no runtime hot-reload, and we do not invent one).
 *   2. `<space>/pricing.json` — the one config file the host genuinely reads
 *      (the cost table). Validated through the SAME shape authority the boot path
 *      uses (`validatePricingTable`), so a bad price is refused here instead of
 *      blowing up at the next boot.
 *
 * Hard rule, mirroring the steward "env-name not value" discipline: SECRET-name
 * keys (`*_TOKEN`/`*_SECRET`/`*_KEY`/master-key) are REFUSED before any write.
 * Credentials never pass through this editor — they stay in the vault / setup
 * wizard / `rotate-master-key`. The effective-config read view shows secret env
 * vars as set/unset ONLY, never their values.
 *
 * Pure given its seams: every fs touch and the audit sink are injectable, so the
 * M3 acceptance tests run hermetically with fakes.
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { writeFileAtomic } from '@gotong/core'

import { type ModelPrice, validatePricingTable } from './pricing.js'
// `OpsError` is the subsystem's typed error. The import forms a cycle with
// ops-core (which imports this module's writers) — benign in ESM because
// `OpsError` is only ever referenced inside function bodies here, never at
// module-eval time, so the live binding is resolved by the time it is thrown.
import { OpsError } from './ops-core.js'

// ───────────────────────────────────────────────────────────────────────────
// Env-knob whitelist (the ONLY non-secret env vars writable via `setting`)
// ───────────────────────────────────────────────────────────────────────────

/** Validation outcome for a single env-knob value. */
export type KnobVerdict = { ok: true; value: string } | { ok: false; reason: string }

export interface EnvKnobSpec {
  key: string
  /** One-line human description (shown in the editor / read view). */
  summary: string
  /** Default the host falls back to when the knob is unset. */
  defaultValue: string
  /** Deterministic validator — normalises + accepts, or rejects with a reason. */
  validate(raw: string): KnobVerdict
}

function validatePort(raw: string): KnobVerdict {
  const t = raw.trim()
  if (!/^\d+$/.test(t)) return { ok: false, reason: 'must be an integer port number' }
  const n = Number(t)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return { ok: false, reason: 'must be a port in 1–65535' }
  }
  return { ok: true, value: String(n) }
}

function validateMode(raw: string): KnobVerdict {
  const t = raw.trim().toLowerCase()
  if (t !== 'personal' && t !== 'team') {
    return { ok: false, reason: "must be 'personal' or 'team'" }
  }
  return { ok: true, value: t }
}

/**
 * Mirrors host `parseOpenBrowserEnv`: 0/false/off/no → never, 1/true/on/yes →
 * always, plus an explicit `auto`. Anything else is rejected (the host would
 * silently treat it as `auto`, so refusing here is the honest, predictable move).
 *
 * The words `always` / `never` are accepted BECAUSE this validator's own
 * rejection text has always advertised them — telling someone "must be one of:
 * auto, always, never" and then refusing `always` is the editor contradicting
 * itself. They are NORMALISED on the way in, though, and that half is the
 * load-bearing one: `parseOpenBrowserEnv` does NOT know the word `always` —
 * it would fall through to `auto`. Storing the word verbatim would write a
 * value the host silently means something else by, which is exactly the class
 * of quiet lie this editor exists to prevent. So the words map to tokens the
 * host really parses, the same way ` 8080 ` is normalised to `8080`.
 */
const OPEN_BROWSER_ALIASES = new Map<string, string>([
  ['auto', 'auto'],
  ['always', 'true'],
  ['never', 'false'],
  ['1', 'true'],
  ['true', 'true'],
  ['on', 'true'],
  ['yes', 'true'],
  ['0', 'false'],
  ['false', 'false'],
  ['off', 'false'],
  ['no', 'false'],
])
function validateOpenBrowser(raw: string): KnobVerdict {
  const t = raw.trim().toLowerCase()
  const canonical = OPEN_BROWSER_ALIASES.get(t)
  if (canonical === undefined) {
    return { ok: false, reason: 'must be one of: auto, always(1/true/on/yes), never(0/false/off/no)' }
  }
  return { ok: true, value: canonical }
}

/**
 * 布尔归一化 —— UXCFG-M2 的承重件。
 *
 * host 里有**三套互不兼容**的布尔解析器,而它们读的是同一批旋钮的邻居:
 *   - `onUnlessDisabled`(butler-env,opt-out 组): 只有 {0,false,off,no} 算关。
 *   - `onlyIfEnabled`(butler-env,opt-in 组 + version-check): 只有 {1,true,on,yes}
 *     算开——`enabled` / `Y` / `开` 一律**静默当没开**,不报错,只是不生效。
 *   - `envBool`(main-cli): 只认 {1,true,yes}——连 `on` 都不认。
 *
 * 没有人应该被要求记住这个。所以这里收下宽的一套,**吐出去的只有 `true`/`false`**
 * ——那两个字面量是上面三套里唯一被三方都正确理解的值。这与 `always`→`true` 是
 * 同一个判断,而且理由更硬:那次治的是一个解析器的盲点,这次治的是三个解析器
 * 各说各话。
 */
const BOOL_ALIASES = new Map<string, string>([
  ['1', 'true'], ['true', 'true'], ['on', 'true'], ['yes', 'true'], ['y', 'true'],
  ['enable', 'true'], ['enabled', 'true'],
  ['0', 'false'], ['false', 'false'], ['off', 'false'], ['no', 'false'], ['n', 'false'],
  ['disable', 'false'], ['disabled', 'false'],
])
function validateBool(raw: string): KnobVerdict {
  const canonical = BOOL_ALIASES.get(raw.trim().toLowerCase())
  if (canonical === undefined) {
    return { ok: false, reason: 'must be on(1/true/yes/enabled) or off(0/false/no/disabled)' }
  }
  return { ok: true, value: canonical }
}

/** 闭集枚举 —— 值域小到可以逐个印在拒绝语里。 */
function oneOf(...allowed: readonly string[]): (raw: string) => KnobVerdict {
  return (raw) => {
    const t = raw.trim().toLowerCase()
    if (!allowed.includes(t)) return { ok: false, reason: `must be one of: ${allowed.join(', ')}` }
    return { ok: true, value: t }
  }
}

/**
 * 模型名 / 音色 id 这类自由标识符。
 *
 * **控制字符的禁令是安全要求,不是整洁。** 在这之前每个校验器的值域都是闭集,
 * 一个换行永远无从进入;这是第一个收自由文本的。而 `serializeEnvFile` 写的是
 * `KEY=value`、`parseEnvFile` 逐行切——值里夹一个 `\n`,写出去就是**另一行 KEY=**,
 * 下次 boot 被当成第二个旋钮读回来。凭证注入就是这么来的。故控制字符一律拒。
 *
 * 刻意**不**限 ASCII:厂商官方音色 id 本来就是中文(茉莉 / 冰糖 / 苏打 / 白桦)。
 */
function identifier(what: string): (raw: string) => KnobVerdict {
  return (raw) => {
    const t = raw.trim()
    // 空串 = **显式清除**,不是错误。用它的五个感官旋钮读侧全是
    // `(env.X ?? '').trim()` 再判真值(butler-voice / -hearing / -seeing /
    // -embedder 各自的 *FromEnv),所以 `X=` 与「从没设过」对它们逐字节同义。
    // 少了这一条,人能在设置页把音色打开却再也关不掉——判据 3(改回去等于没
    // 发生过)当场失效。其余旋钮不走这个校验器,它们的「改回去」是写回默认值。
    if (t.length === 0) return { ok: true, value: '' }
    if (t.length > 96) return { ok: false, reason: `${what} is too long (max 96 chars)` }
    for (const ch of t) {
      const c = ch.codePointAt(0)!
      if (c < 0x20 || c === 0x7f) return { ok: false, reason: `${what} must not contain control characters` }
    }
    return { ok: true, value: t }
  }
}

/**
 * 节律(毫秒)。**上下界与 butler-env 的 `cadence()` 钳位逐字同界**——于是
 * 「过了校验」等价于「逐字生效」:一个通过这里的值永远不会在下游被悄悄钳成
 * 另一个数。同界这件事不靠我在两处抄对,靠 `ops-config-write.test.ts` 里那条
 * 跨模块门(把边界值真喂给 `parseButlerEnv`,断言原样出来)。
 *
 * 顺手收人话单位:`30m` / `6h` / `90s` 都行,存下去的是毫秒——`always`→`true` 同款,
 * 界面上让人读得懂,盘上仍是 host 真正会解析的那个值。
 */
function cadenceMs(minMs: number, maxMs: number): (raw: string) => KnobVerdict {
  const human = (ms: number): string => (ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${ms / 60_000}m`)
  return (raw) => {
    const t = raw.trim().toLowerCase()
    const m = /^(\d+)(ms|s|m|h)?$/.exec(t)
    if (!m) return { ok: false, reason: `must be a duration like 30m / 6h / 90s (range ${human(minMs)}–${human(maxMs)})` }
    const mult = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[m[2] ?? 'ms']!
    const ms = Number(m[1]) * mult
    if (!Number.isSafeInteger(ms) || ms < minMs || ms > maxMs) {
      return { ok: false, reason: `must be between ${human(minMs)} and ${human(maxMs)}` }
    }
    return { ok: true, value: String(ms) }
  }
}

/**
 * 有界非负整数(存储归档旋钮,STOR-M3b)。
 *
 * 空串 = **显式清除** —— 读侧两个 parse(parseTranscriptRetention /
 * parseRunRetention)对 `''` 都按「未设 = 不归档」处理,与感官旋钮的
 * `identifier()` 同一条理由;也是 defaultValue `''` 过得了自己校验器的前提。
 *
 * 上下界**严格窄于** boot 解析域,方向不可反:那两个 parse 对坏值是**抛错拒启**
 * (不是钳位)。校验器比 parse 严,坏值到不了盘;反过来松一寸,写下去的就是一颗
 * 重启炸弹——一个过了这里却过不了 parse 的值,会让下一次 boot 起不来。这层包含
 * 关系不靠两处抄对,靠跨模块 containment 门把每个校验通过的值真喂给 parse
 * (ops-config-write.test.ts)。
 */
function boundedInt(what: string, min: number, max: number): (raw: string) => KnobVerdict {
  return (raw) => {
    const t = raw.trim()
    if (t.length === 0) return { ok: true, value: '' }
    if (!/^\d+$/.test(t)) return { ok: false, reason: `${what} must be a whole number in ${min}–${max}` }
    const n = Number(t)
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      return { ok: false, reason: `${what} must be a whole number in ${min}–${max}` }
    }
    return { ok: true, value: String(n) }
  }
}

/**
 * 可改旋钮的白名单 —— 这份名单**同时**是四样东西:阿同 `set_hub_config` 的参数
 * 枚举(M3c)、环境提案 `apply.key` 的类型(M4)、写入方的查表、以及 boot 读回
 * `<space>/gotong.env` 时认的那一份(UXCFG-M1)。加一行,四处一起长。
 *
 * ## 收什么(UXCFG-M2,三条判据全部满足才收)
 *
 *   1. **值域封闭或有界** —— 枚举 / 布尔 / 带上下界的时长 / 有长度和字符约束的
 *      标识符。这条同时是 `set_hub_config` 当初能进 `IM_APPROVABLE_TOOLS` 的
 *      理由:审批卡上那行字**结构上就长不了**。
 *   2. **改错了不删数据、不放松安全闸、不把人锁在外面。**
 *   3. **改回去等于没发生过。**
 *
 * ## 刻意拒掉的(每一条都被逐个核过,不是漏了)
 *
 *   - `GOTONG_BUTLER` —— 关掉管家就等于关掉手机上唯一那条能把它开回来的路
 *     (`/setting` 命令台的 config-write 恒 false)。判据 2 的「锁在外面」。
 *   - `GOTONG_BUTLER_GOVERNED` —— 那是审批闸本身。一句话关掉全部审批,判据 2。
 *   - `GOTONG_HOST` —— 想开放到公网就得同时设好 `GOTONG_ALLOWED_HOSTS` 与
 *     `GOTONG_COOKIE_SECURE`,否则 `auditBootSecurity` 两条 **fatal** 直接拒启,
 *     而救它要的旋钮此刻已经够不着了。**闭集救不了它:`0.0.0.0` 本身就是那把锁,
 *     不是打错的字。** 这件事该长成一个带前置检查的「开放到公网」引导动作
 *     (一次原子地设好四个),那是另一个里程碑,不是这份名单里的一行。
 *   - `GOTONG_SPACE_NAME` —— `Space.openOrInit` 对已存在的 space 直接走
 *     `Space.open()`,`opts.name` **整个被忽略**;它只在首次 init 落一次盘。
 *     收一个改了不生效的旋钮,比不收更坏(界面会替它撒谎)。
 *   - `GOTONG_LOG_LEVEL` / `_FORMAT` —— `createLogger('host')` 在模块顶层求值,
 *     虽然 UXCFG-M1 的注入排在它前面一行,但那个顺序脆弱到一次 import 重排就会
 *     静默失效。没有门守得住的生效性,不收。
 *   - identity 保留期(`GOTONG_LEDGER/AUDIT/PEER_SUMMARY/ALERT_FIRINGS_KEEP_DAYS`)
 *     —— 机制是 SQL `DELETE`,调小一次 sweep 行就没了,判据 2/3 的正反面。
 *     transcript/run 的四个**归档**旋钮不再在此列(STOR-M3b 收进名单):它们只
 *     rename 进 archive/,一个字节不销毁,归档段/归档 run 仍可读——「调小」最坏
 *     是搬早了,改回去就不再搬,已搬的照读。同为保留期,分界在机制不在名字。
 *   - 安全闸类(`ALLOW_INSECURE` / `COOKIE_SECURE` / `TRUST_PROXY` /
 *     `ALLOWED_HOSTS` / `PROTOCOL_STRICT` / `GATING`)—— 判据 2。
 *   - 路径类(`GOTONG_SPACE` / `_BACKUP_DIR` / `_WORKFLOWS_DIR`)—— 改了等于换一
 *     台 hub,数据还在旧路径下但界面上看不见,判据 3。
 *   - 一切凭证 —— 在查这份名单**之前**就被 `isSecretKey` 拒掉,秘密只进金库。
 *     顺带:IM 桥没有开关旋钮,host 是按凭证在不在决定开不开桥的——发明一个
 *     toggle 等于写一个 host 从来不读的 env。
 */
export const ENV_KNOBS = [
  // ── 基础 ──
  { key: 'GOTONG_MODE', summary: 'Personal vs team mode (auto-detected when unset).', defaultValue: 'personal', validate: validateMode },
  { key: 'GOTONG_WEB_PORT', summary: 'Admin UI / API port.', defaultValue: '3000', validate: validatePort },
  { key: 'GOTONG_WS_PORT', summary: 'Agent WebSocket port.', defaultValue: '4000', validate: validatePort },
  { key: 'GOTONG_OPEN_BROWSER', summary: 'First-run browser auto-open behaviour.', defaultValue: 'auto', validate: validateOpenBrowser },
  { key: 'GOTONG_DEFAULT_LANG', summary: 'Default UI language for new sessions.', defaultValue: 'zh', validate: oneOf('zh', 'en') },
  { key: 'GOTONG_PROFILE', summary: 'Which view the console foregrounds: one hub, or a federation of hubs. Presentation only — never changes behaviour.', defaultValue: 'hub', validate: oneOf('hub', 'federation') },

  // ── 阿同的后台节律:开关 ──
  // 三个 opt-out(默认开)。刻意不收总开关 GOTONG_BUTLER 与审批闸 _GOVERNED,见上。
  { key: 'GOTONG_BUTLER_MAINTENANCE', summary: 'Butler background memory upkeep (every 6h). Turning this OFF also stops the memory extras below.', defaultValue: 'true', validate: validateBool },
  { key: 'GOTONG_BUTLER_PROACTIVE', summary: 'Butler proactive daily brief.', defaultValue: 'true', validate: validateBool },
  { key: 'GOTONG_BUTLER_RUN_BROADCAST', summary: 'Butler announcing workflow run outcomes.', defaultValue: 'true', validate: validateBool },
  // 四个 opt-in(默认关)。前三个是 6h 扫描里的活,级联在 _MAINTENANCE 之下 ——
  // summary 必须说出来,否则有人关了维护再来开图书馆员,会得到一个「开了但不跑」
  // 的旋钮。_MEMORY_LINKS 刻意**不**级联(它只挂在 GOTONG_BUTLER 上:召回扩一跳
  // 不需要扫描先跑过),所以它的 summary 也不该跟着写那句话。
  { key: 'GOTONG_BUTLER_MEMORY_GIT', summary: 'Snapshot each member memory tree into git on upkeep (needs butler upkeep ON).', defaultValue: 'false', validate: validateBool },
  { key: 'GOTONG_BUTLER_MEMORY_LIBRARIAN', summary: 'Let the butler file topical facts into knowledge/ notes on upkeep (needs butler upkeep ON).', defaultValue: 'false', validate: validateBool },
  { key: 'GOTONG_BUTLER_MEMORY_RECONCILE', summary: 'Let the butler retire stale/contradicting facts on upkeep (needs butler upkeep ON).', defaultValue: 'false', validate: validateBool },
  { key: 'GOTONG_BUTLER_MEMORY_LINKS', summary: 'Build an association graph across memories, widening recall by one hop.', defaultValue: 'false', validate: validateBool },

  // ── 阿同的后台节律:周期 ──
  // 上下界与 butler-env 的 cadence() 钳位同界 ⇒ 过了校验 = 逐字生效,不会被悄悄钳走。
  { key: 'GOTONG_BUTLER_MAINTENANCE_MS', summary: 'How often butler memory upkeep runs.', defaultValue: '6h', validate: cadenceMs(60_000, 24 * 60 * 60 * 1000) },
  { key: 'GOTONG_BUTLER_PROACTIVE_MS', summary: 'How often the butler checks whether a proactive brief is due.', defaultValue: '15m', validate: cadenceMs(5 * 60 * 1000, 60 * 60 * 1000) },
  { key: 'GOTONG_BUTLER_RUN_BROADCAST_MS', summary: 'How often the butler checks for finished runs to announce.', defaultValue: '1m', validate: cadenceMs(60_000, 60 * 60 * 1000) },

  // ── 阿同的感官:模型名 ──
  // 凭证(_URL / _KEY)不在这里 —— 那两个走金库。这里只有「用哪个模型 / 哪个音色」,
  // 每一个都是非密的短标识符,写错了那项能力诚实退回文字,改回去即恢复。
  { key: 'GOTONG_BUTLER_VOICE_MODEL', summary: 'Text-to-speech model the butler replies with (needs the voice endpoint + key set).', defaultValue: '', validate: identifier('model name') },
  { key: 'GOTONG_BUTLER_VOICE_VOICE', summary: 'Vendor system voice id for replies (official system voices only — never a cloned real person).', defaultValue: '', validate: identifier('voice id') },
  { key: 'GOTONG_BUTLER_ASR_MODEL', summary: 'Speech-to-text model for incoming voice messages.', defaultValue: '', validate: identifier('model name') },
  { key: 'GOTONG_BUTLER_VISION_MODEL', summary: 'Vision model for incoming images.', defaultValue: '', validate: identifier('model name') },
  { key: 'GOTONG_BUTLER_EMBEDDER_MODEL', summary: 'Embeddings model for semantic memory recall.', defaultValue: '', validate: identifier('model name') },

  // ── 存储归档(类②滚动历史,STOR-M3b) ──
  // 四个都只把旧数据原子 rename 进 archive/,一个字节不销毁:归档段经
  // FileStorage.loadAll()、归档 run 经 RunStore.readArchived 照读。这正是它们
  // 能进名单而 identity 四个 *_KEEP_DAYS(SQL DELETE)进不来的分界(见上)。
  // boot 时读,改完下次重启生效。空串 = 不归档(与从没设过同义)。
  { key: 'GOTONG_TRANSCRIPT_KEEP_SEGMENTS', summary: 'Sealed transcript segments kept active; older ones MOVE to archive/ (never deleted, still readable). Applies at next restart.', defaultValue: '', validate: boundedInt('segment count', 0, 10_000) },
  { key: 'GOTONG_TRANSCRIPT_ARCHIVE_DAYS', summary: 'Sealed transcript segments older than this many days MOVE to archive/ (never deleted). Applies at next restart.', defaultValue: '', validate: boundedInt('day count', 1, 3650) },
  { key: 'GOTONG_RUN_KEEP', summary: 'Finished workflow runs kept active; older ones MOVE to runs/archive/ (never deleted, still readable). Applies at next restart.', defaultValue: '', validate: boundedInt('run count', 0, 10_000) },
  { key: 'GOTONG_RUN_ARCHIVE_DAYS', summary: 'Finished workflow runs older than this many days MOVE to runs/archive/ (never deleted). Applies at next restart.', defaultValue: '', validate: boundedInt('day count', 1, 3650) },

  // ── 其它 opt-in ──
  { key: 'GOTONG_UPDATE_CHECK', summary: 'Daily check for a newer Gotong release (one outbound request/day; off = no network, no timer).', defaultValue: 'false', validate: validateBool },
  { key: 'GOTONG_A2A_SIGN_CARD', summary: 'Sign this hub\'s public agent card (ES256). Off by default; the signing key is kept across on/off.', defaultValue: 'false', validate: validateBool },
  // `as const satisfies` 而不是 `: readonly EnvKnobSpec[]`——注解会把每个 key 拓宽成
  // `string`,那样下面那个联合类型就只是 `string`,什么也约束不住。
] as const satisfies readonly EnvKnobSpec[]

/**
 * 可改旋钮的**键名联合**——一份定义,四处执法。M3c 的工具 schema 用它当 enum、
 * M4 的提案用它当 `apply.key` 的类型、写入方用它查表:谁都不再自己抄一份名字。
 * 抄一份的代价不是丑,是**编译器不再问问题**——ENV_KNOBS 加一项而某处手抄名单
 * 没跟上,那一项就在那个面上凭空不存在,而没有任何东西会红。
 */
export type EnvKnobKey = (typeof ENV_KNOBS)[number]['key']

/**
 * 编译期自检——**这就是那条窄类型的门**。
 *
 * 上面那个 `as const satisfies` 如果被谁换回 `: readonly EnvKnobSpec[]`,
 * `EnvKnobKey` 会静默塌成 `string`,而两个消费点(`KNOB_KEYS`、
 * `HubEnvProposal.apply.key`)照旧编译通过——没有任何东西会红。那时下面这行
 * 就成了合法赋值,`@ts-expect-error` 变成「未使用的指令」⇒ tsc 当场红。
 *
 * 刻意放在 src 里而不是测试里:本包的 tsconfig 只 include `src/**\/*.ts`,而
 * vitest 走 esbuild 直接把类型剥掉——写在测试里的 `@ts-expect-error` 两边都没人看,
 * 是一条永远绿的假门。
 */
// @ts-expect-error 'nope' 不是一个旋钮名——它**必须**不是
const _envKnobKeyMustStayNarrow: EnvKnobKey = 'nope'
void _envKnobKeyMustStayNarrow
export const ENV_KNOB_KEYS: readonly EnvKnobKey[] = ENV_KNOBS.map((k) => k.key)

function knobSpec(key: string): EnvKnobSpec | undefined {
  return ENV_KNOBS.find((k) => k.key === key)
}

/**
 * Does `key` look like a secret? Belt-and-suspenders over the whitelist: a
 * config-set for a secret-name key is refused with a clear reason BEFORE the
 * whitelist lookup, so the operator is told "secrets never go here" rather than
 * a bare "unknown knob". Matches the `*_TOKEN`/`*_SECRET`/`*_KEY`/`*_PASSWORD`
 * suffixes plus any master-key / password mention.
 */
export function isSecretKey(key: string): boolean {
  const k = key.toUpperCase()
  return /_(TOKEN|SECRET|KEY|PASSWORD)$/.test(k) || k.includes('MASTER_KEY') || k.includes('PASSWORD')
}

// ───────────────────────────────────────────────────────────────────────────
// Managed env file (`<space>/gotong.env`) — parse / serialize
// ───────────────────────────────────────────────────────────────────────────

/**
 * Parse a managed `gotong.env` — simple `KEY=value` lines, `#` comments and
 * blanks ignored. We OWN this file (the editor writes it), so the grammar is
 * deliberately minimal; no shell expansion, no quoting games.
 */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key) out.set(key, value)
  }
  return out
}

const ENV_FILE_HEADER = [
  '# Gotong managed environment — written by `setting config-set`.',
  '# Read by the host itself at boot (managed-env.ts), whitelist-scoped to the knobs',
  '# below; anything already set in the real environment WINS over this file.',
  '# Changes take effect on NEXT restart.',
  '# Only NON-SECRET knobs live here. Secrets (API keys, bridge tokens, the master',
  '# key) NEVER go here — use the vault / setup wizard / `setting rotate-master-key`.',
  '',
].join('\n')

/** Serialize a knob map back to `gotong.env`, keys sorted for a clean diff. */
export function serializeEnvFile(map: Map<string, string> | Record<string, string>): string {
  const entries = map instanceof Map ? [...map.entries()] : Object.entries(map)
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const body = entries.map(([k, v]) => `${k}=${v}`).join('\n')
  return `${ENV_FILE_HEADER}${body}${body ? '\n' : ''}`
}

/** A validated env template (all knobs commented out at their defaults). */
export function generateEnvTemplate(): string {
  const lines = ENV_KNOBS.map((k) => `# ${k.key}=${k.defaultValue}    # ${k.summary}`)
  return `${ENV_FILE_HEADER}${lines.join('\n')}\n`
}

// ───────────────────────────────────────────────────────────────────────────
// Shared write deps + audit seam
// ───────────────────────────────────────────────────────────────────────────

/**
 * Best-effort audit sink — the surface binds the actor context (CLI = system,
 * web owner = their session). ops-config-write only supplies the per-write
 * metadata; it NEVER blocks a (already-validated) write on an audit fault and
 * NEVER puts a secret value in `metadata`.
 */
export type ConfigWriteAuditSink = (metadata: Record<string, unknown>) => void

interface FsWriteSeams {
  readFileImpl?: (p: string) => Promise<string>
  writeFileImpl?: (p: string, data: string) => Promise<void>
  mkdirpImpl?: (p: string) => Promise<void>
}

/**
 * Read a managed file for a read-merge-write. **Only ENOENT falls back** — an
 * unreadable-but-writable file (EACCES, EIO, a directory in the way) must NOT
 * be read as "empty", because the very next step serializes the merged map back
 * over it: swallowing the read error turns "set one knob" into "erase every
 * other knob", and the approval card the operator said yes to promised exactly
 * one key. Absent is a state we can honestly merge onto; unreadable is not.
 */
async function readFileOr(path: string, fallback: string, seams: FsWriteSeams): Promise<string> {
  const impl = seams.readFileImpl ?? ((p: string) => readFile(p, 'utf8'))
  try {
    return await impl(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return fallback
    throw new OpsError(
      'config_file_unreadable',
      `cannot read ${path} (${(err as NodeJS.ErrnoException)?.code ?? String(err)}) — refusing to overwrite a file I could not read.`,
    )
  }
}

/**
 * 同一进程内、同一个文件的写**排队**。read-merge-write 之间 await 了两次,两个
 * 并发的 config-set 会双双读到旧内容、后写的那个把前一个的键**悄悄丢掉**;而两
 * 边各自都拿到过一次人的批准。跨进程(CLI 另起一个)不在这把锁的射程内——那需要
 * 文件锁,而那是另一件事;这里先把**一台 hub 里三个入口**(网页/阿同/setting 台)
 * 的并发关掉。
 */
const writeChains = new Map<string, Promise<unknown>>()
function serializeByPath<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(path) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  // 链子只用来排队,不用来传播失败:一次写失败不该让后面每一次写都跟着炸。
  writeChains.set(path, next.then(() => undefined, () => undefined))
  return next
}

async function writeFileAt(path: string, data: string, seams: FsWriteSeams): Promise<void> {
  const mkdirp = seams.mkdirpImpl ?? ((p: string) => mkdir(p, { recursive: true }).then(() => undefined))
  // 缺省走**原子写**(tmp + rename):这个文件是下次启动读的那一份,半截的它会让
  // hub 起不来,而写到一半的窗口正是断电/OOM 落在的地方。
  const write = seams.writeFileImpl ?? ((p: string, d: string) => writeFileAtomic(p, d))
  await mkdirp(dirname(path))
  await write(path, data)
}

export interface ConfigWriteResult {
  lines: string[]
  data: Record<string, unknown>
}

// ───────────────────────────────────────────────────────────────────────────
// config-write: set a managed env knob
// ───────────────────────────────────────────────────────────────────────────

export interface EnvKnobWriteDeps extends FsWriteSeams {
  /** Absolute path to the managed env file (`<space>/gotong.env`). */
  envFilePath: string
  /** Surface label for the audit row (cli/web). */
  surface: string
  audit?: ConfigWriteAuditSink
}

/**
 * Set one whitelisted, non-secret env knob in `<space>/gotong.env`. Order is:
 * secret-name hard-refuse → whitelist lookup → deterministic validate → read-
 * merge-write the managed file → best-effort audit. Throws `OpsError` (no write,
 * no success audit) on any refusal.
 */
export async function applyEnvKnob(
  input: { key: string; value: string },
  deps: EnvKnobWriteDeps,
): Promise<ConfigWriteResult> {
  const key = (input.key ?? '').trim()
  if (!key) throw new OpsError('invalid_input', 'a config key is required.')

  // 1. Secret-name keys are refused outright — they never belong in this file.
  if (isSecretKey(key)) {
    throw new OpsError(
      'secret_key_refused',
      `'${key}' looks like a secret — secrets never go in the managed env file. Use the vault / setup wizard / \`setting rotate-master-key\`.`,
    )
  }
  // 2. Must be on the whitelist.
  const spec = knobSpec(key)
  if (!spec) {
    const allowed = ENV_KNOBS.map((k) => k.key).join(', ')
    throw new OpsError('unknown_knob', `'${key}' is not a settable config knob. Settable: ${allowed}.`)
  }
  // 3. Deterministic validation BEFORE any write.
  const verdict = spec.validate(input.value ?? '')
  if (!verdict.ok) {
    throw new OpsError('invalid_value', `'${key}': ${verdict.reason}; got ${JSON.stringify(input.value)}.`)
  }

  // 4. Read-merge-write the managed file — the whole cycle inside one queue slot
  //    (see `serializeByPath`: the two awaits below are where a concurrent write
  //    would slip in and lose the other one's key).
  await serializeByPath(deps.envFilePath, async () => {
    const current = parseEnvFile(await readFileOr(deps.envFilePath, '', deps))
    current.set(key, verdict.value)
    await writeFileAt(deps.envFilePath, serializeEnvFile(current), deps)
  })

  // 5. Best-effort audit (never a secret value — just the key + new value, which
  //    for a whitelisted non-secret knob is safe to record).
  try {
    deps.audit?.({ kind: 'env', surface: deps.surface, key, value: verdict.value, takesEffectOnRestart: true })
  } catch {
    // never mask a succeeded write on an audit fault
  }

  return {
    lines: [
      `set ${key}=${verdict.value} in ${deps.envFilePath}`,
      'takes effect on the NEXT host restart (no hot-reload).',
    ],
    data: { kind: 'env', key, value: verdict.value, path: deps.envFilePath, takesEffectOnRestart: true },
  }
}

/**
 * Remove one whitelisted env knob from `<space>/gotong.env` so the host falls
 * back to its built-in default on the next restart.
 *
 * This is a distinct OPERATION rather than "set it to the default value", and
 * the distinction is load-bearing. Writing the default leaves a line on disk, so
 * the file keeps claiming the operator pinned that knob: the settings page then
 * has to go on reporting "you set this" about a knob they just asked to stop
 * setting, and the pin silently freezes the default of the day even after a
 * later release changes it. Nor can a value stand in for the operation — the
 * empty string already means "explicitly cleared" for the five sensory knobs
 * (see `identifier`), and a free-text knob may legitimately hold any string, so
 * there is no value that means "no value".
 *
 * Same refusal order as `applyEnvKnob` minus the value check (there is no value
 * to validate): secret-name hard-refuse → whitelist lookup → read-merge-write.
 * An absent key is success with `removed:false` and ZERO bytes written — being
 * asked to unset something already unset is the requested state, not a failure,
 * and it must not conjure a managed file onto a hub that never had one.
 */
export async function unsetEnvKnob(
  input: { key: string },
  deps: EnvKnobWriteDeps,
): Promise<ConfigWriteResult> {
  const key = (input.key ?? '').trim()
  if (!key) throw new OpsError('invalid_input', 'a config key is required.')

  // Secret names are refused on this door too. Not because removing a line could
  // leak anything, but because the editor must have exactly ONE answer to "which
  // keys do you touch" — a second, laxer door is how a whitelist rots.
  if (isSecretKey(key)) {
    throw new OpsError(
      'secret_key_refused',
      `'${key}' looks like a secret — secrets never go in the managed env file. Use the vault / setup wizard / \`setting rotate-master-key\`.`,
    )
  }
  const spec = knobSpec(key)
  if (!spec) {
    const allowed = ENV_KNOBS.map((k) => k.key).join(', ')
    throw new OpsError('unknown_knob', `'${key}' is not a settable config knob. Settable: ${allowed}.`)
  }

  // Read-merge-write inside one queue slot, exactly like the setter: a delete has
  // the same lost-update window as a set.
  const removed = await serializeByPath(deps.envFilePath, async () => {
    const current = parseEnvFile(await readFileOr(deps.envFilePath, '', deps))
    if (!current.has(key)) return false
    current.delete(key)
    await writeFileAt(deps.envFilePath, serializeEnvFile(current), deps)
    return true
  })

  try {
    deps.audit?.({ kind: 'env-unset', surface: deps.surface, key, removed, takesEffectOnRestart: true })
  } catch {
    // never mask a succeeded write on an audit fault
  }

  const fallback = spec.defaultValue === '' ? 'unset' : spec.defaultValue
  return {
    lines: removed
      ? [
          `removed ${key} from ${deps.envFilePath} (falls back to the built-in default: ${fallback})`,
          'takes effect on the NEXT host restart (no hot-reload).',
        ]
      : [`${key} was not set in ${deps.envFilePath} — already on the built-in default: ${fallback}. Nothing written.`],
    data: {
      kind: 'env-unset',
      key,
      removed,
      defaultValue: spec.defaultValue,
      path: deps.envFilePath,
      takesEffectOnRestart: true,
    },
  }
}

// ───────────────────────────────────────────────────────────────────────────
// config-write: upsert a pricing.json override
// ───────────────────────────────────────────────────────────────────────────

export interface PricingWriteDeps extends FsWriteSeams {
  /** Absolute path to `<space>/pricing.json`. */
  pricingPath: string
  surface: string
  audit?: ConfigWriteAuditSink
}

/**
 * Upsert one model's price override in `<space>/pricing.json`. The new entry is
 * validated through `validatePricingTable` (the boot-path shape authority), then
 * merged into the existing OWN overrides and the WHOLE merged table is re-
 * validated, so a corrupt existing file or a bad new entry is refused BEFORE the
 * write. Throws `OpsError` on any refusal.
 */
export async function applyPricingUpsert(
  input: { model: string; price: unknown },
  deps: PricingWriteDeps,
): Promise<ConfigWriteResult> {
  const model = (input.model ?? '').trim()
  if (!model) throw new OpsError('invalid_input', 'a model id is required.')

  // Validate the single new entry first (clear per-entry error if it's bad).
  let entry: ModelPrice
  try {
    const validated = validatePricingTable({ [model]: input.price }, 'pricing.json')
    entry = validated[model]!
  } catch (e) {
    throw new OpsError('invalid_price', (e as Error).message)
  }

  // Read-merge-write, one queue slot for the whole cycle (same reason as the
  // env file above: two concurrent upserts would each drop the other's model).
  await serializeByPath(deps.pricingPath, async () => {
    // Read existing OWN overrides (ENOENT → empty object; unreadable → refuse).
    const rawExisting = await readFileOr(deps.pricingPath, '{}', deps)
    let parsed: unknown
    try {
      parsed = JSON.parse(rawExisting)
    } catch (e) {
      throw new OpsError(
        'pricing_corrupt',
        `${deps.pricingPath} is not valid JSON (${(e as Error).message}); fix or remove it before editing prices here.`,
      )
    }
    // Re-validate the whole merged own-table so a pre-existing bad entry surfaces
    // now rather than at the next boot.
    let own: Record<string, ModelPrice>
    try {
      own = validatePricingTable(parsed, deps.pricingPath)
    } catch (e) {
      throw new OpsError('pricing_corrupt', (e as Error).message)
    }
    own[model] = entry

    await writeFileAt(deps.pricingPath, `${JSON.stringify(own, null, 2)}\n`, deps)
  })

  try {
    deps.audit?.({ kind: 'pricing', surface: deps.surface, model, takesEffectOnRestart: true })
  } catch {
    // never mask a succeeded write
  }

  return {
    lines: [
      `upserted price for "${model}" in ${deps.pricingPath}`,
      `  inputPer1M=${entry.inputPer1M} outputPer1M=${entry.outputPer1M}`,
      'takes effect on the NEXT host restart (the table is read at boot).',
    ],
    data: { kind: 'pricing', model, price: entry, path: deps.pricingPath, takesEffectOnRestart: true },
  }
}

// ───────────────────────────────────────────────────────────────────────────
// read: effective-config view (token-redacted)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Secret env vars the host genuinely reads — shown set/unset in the read view,
 * NEVER by value. Curated (not a scan of all env) so we surface exactly the
 * known secret knobs and don't dump unrelated env-var names.
 */
export const SECRET_ENV_VARS: readonly string[] = [
  'GOTONG_MASTER_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GOTONG_TELEGRAM_BOT_TOKEN',
  'GOTONG_QQ_BOT_SECRET',
  'GOTONG_LARK_APP_SECRET',
  'GOTONG_SLACK_APP_TOKEN',
  'GOTONG_SLACK_BOT_TOKEN',
]

export interface EffectiveKnobView {
  key: string
  summary: string
  default: string
  /** Value in the managed `gotong.env` (null when not set there). */
  fileValue: string | null
  /**
   * Value set in the environment from OUTSIDE this hub (null when unset).
   *
   * NOT simply `process.env[key]`. UXCFG-M1 made the host read the managed env
   * file at boot and inject it into `process.env` itself, so the raw lookup
   * would report the hub's own file as an environment override — every knob
   * would read "set by the environment" one restart after anyone saved, and the
   * settings page locks those controls. See `EffectiveConfigDeps.envInjectedKeys`.
   */
  envValue: string | null
}

export interface EffectiveConfigView {
  /**
   * The managed env file this hub reads at boot (UXCFG-M1) and writes on
   * `config-set` — the absolute path, not a `<space>/…` stand-in.
   *
   * It is in the view because it is the settings page's whole thesis: what you
   * change here lands in THIS file, and you can go read it. Without the field a
   * UI has two options, and both are worse — print a placeholder that is not a
   * path anyone can `cat`, or reconstruct one from `pricing.path`, which is only
   * right as long as nobody overrides one of the two seams independently.
   */
  envFilePath: string
  /** The whitelisted knobs, file-vs-live so the operator sees pending-vs-active. */
  knobs: EffectiveKnobView[]
  /** Secret env vars: name + set/unset ONLY. */
  secrets: Array<{ key: string; set: boolean }>
  pricing: { path: string; present: boolean; overrideModels: number; corrupt?: boolean }
  /** A validated env template the operator can copy / apply manually. */
  envTemplate: string
}

export interface EffectiveConfigDeps extends FsWriteSeams {
  spaceDir: string
  env: Record<string, string | undefined>
  /** Defaults to `<space>/gotong.env`. */
  envFilePath?: string
  /** Defaults to `<space>/pricing.json`. */
  pricingPath?: string
  /**
   * Keys THIS host injected into `process.env` at boot from the managed env
   * file (`loadManagedEnv().applied`). They are subtracted from the environment
   * when computing `envValue`, because the hub echoing its own file back is not
   * an external override — and the settings page disables any control it
   * believes the environment owns.
   *
   * Safe by construction: `loadManagedEnv` puts a key in `applied` only when it
   * actually wrote it, and a variable the real environment already had lands in
   * `shadowed` instead (the environment wins, the file stands down). So a
   * genuine external override can never be hidden by this subtraction.
   *
   * Absent → no subtraction (the pre-boot CLI path, where nothing was injected).
   */
  envInjectedKeys?: readonly string[]
}

/** Build the read-only effective-config view (read tier). */
export async function readEffectiveConfig(deps: EffectiveConfigDeps): Promise<EffectiveConfigView> {
  const envFilePath = deps.envFilePath ?? join(deps.spaceDir, 'gotong.env')
  const pricingPath = deps.pricingPath ?? join(deps.spaceDir, 'pricing.json')

  const fileMap = parseEnvFile(await readFileOr(envFilePath, '', deps))
  const injected = new Set(deps.envInjectedKeys ?? [])
  const knobs: EffectiveKnobView[] = ENV_KNOBS.map((k) => ({
    key: k.key,
    summary: k.summary,
    default: k.defaultValue,
    fileValue: fileMap.get(k.key) ?? null,
    envValue: injected.has(k.key) ? null : (deps.env[k.key] ?? null),
  }))

  const secrets = SECRET_ENV_VARS.map((key) => ({ key, set: !!deps.env[key]?.trim() }))

  // Pricing presence + override count (best-effort; corrupt is reported honestly).
  let pricing: EffectiveConfigView['pricing'] = { path: pricingPath, present: false, overrideModels: 0 }
  const rawPricing = await readFileOr(pricingPath, '', deps)
  if (rawPricing.trim()) {
    try {
      const own = validatePricingTable(JSON.parse(rawPricing), pricingPath)
      pricing = { path: pricingPath, present: true, overrideModels: Object.keys(own).length }
    } catch {
      pricing = { path: pricingPath, present: true, overrideModels: 0, corrupt: true }
    }
  }

  return { envFilePath, knobs, secrets, pricing, envTemplate: generateEnvTemplate() }
}
