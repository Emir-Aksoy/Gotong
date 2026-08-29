/* Gotong — 设置台 (UXCFG-M3)
 *
 * 这个文件替换掉了一个「一行 argv 输入框 + 一堆按钮」的面板。换掉它的理由不是
 * 不好看,是那个形状把**掌控权交给了知道语法的人**:要改端口,你得先知道旋钮叫
 * `GOTONG_WEB_PORT`、知道它接什么值、还得记得空格分隔;而屏幕上没有任何东西
 * 会告诉你这些。一个不告诉你能改什么的设置页,和没有设置页的区别只是它占了
 * 一个标签。
 *
 * ## 「掌控感」在这里的四条具体含义(每条都对着一个渲染决定)
 *
 * 1. **看得见全部** —— 23 个旋钮全部摊开成有标签的控件,按「你想干什么」分组,
 *    而不是按引擎的 tier 分组。tier 是给闸看的,不是给人看的。
 * 2. **每个值知道自己从哪来** —— 默认 / 你设的 / **被环境覆盖**。第三种是新的,
 *    也是最要紧的一种:它是这个面板唯一会说「这一行你此刻管不着」的地方,
 *    而说得出来才叫掌控——一个假装什么都能改的界面,在改不动的那一刻会把
 *    责任推给用户。
 * 3. **文件在哪写出来** —— `<space>/gotong.env` 的真实绝对路径就印在最上面。
 *    file-first 是这个项目的立场,那就让它看得见:你可以去 `cat` 它。
 * 4. **危险的东西隔离但不隐藏** —— 冷启动 / 从备份恢复 / 轮换主钥列在最下面,
 *    没有按钮,但把该在服务器上敲的那条命令原样印出来。藏起来不等于安全,
 *    只等于你在需要它的那天找不到它。
 *
 * ## provenance 是**推导**出来的,不是读出来的(这一段是承重的)
 *
 * UXCFG-M1 之后,host 在 boot 时会把 `gotong.env` 里的值注入 `process.env`。
 * 于是 `envValue != null` 不再等于「有人在这个页面之外设了它」——它可能就是
 * 这个文件自己刚被注入的那一份。判据只能这么写:
 *
 *   - `envValue` 非空 且 `fileValue != null` 且**两者不同**  ⇒ 确定被环境覆盖
 *     (注入路径下两者必然相同;不同就只可能是 `process.env` 先赢了)
 *   - `envValue` 非空 且 `fileValue == null`                  ⇒ 只有环境有它
 *   - 其余                                                     ⇒ 文件或默认,可改
 *
 * 空串一律不算「环境设了」——`env()` 与 `loadManagedEnv` 都把 `FOO=` 当未设,
 * 这里跟着它们走,否则同一个旋钮会在两处得到两种解释。
 *
 * 唯一不准的情况:文件和 systemd 恰好设成**同一个值**——那会显示成「你设的」。
 * 这个不准是**自愈**的:一旦有人在这里改成别的值再保存,两边就不同了,下次打开
 * 立刻变成「被环境覆盖」。反方向的方案(把 boot 时的 `applied[]` 传下来)才是
 * 危险的那个:那是一张 boot 快照,文件在 boot 之后被改过它就开始撒谎,而且
 * **不会自愈**。
 *
 * ## 「恢复默认」为什么仍然要按保存
 *
 * 写入方没有「删掉这一行」这种操作:`applyEnvKnob` 永远是 `set(key, value)`。
 * 所以恢复默认 = 把控件填回默认值,由你按保存。只有一条写路径、不新开 API,
 * 而且事后那一行显示「你设的」是**诚实的**——文件里确实多了那一行。
 *
 * ## 分组表是第二份手抄名单,所以它有一道门
 *
 * `KNOB_UI` 把 `ENV_KNOBS` 的键又抄了一遍(为了给每个键配中文标签与分组)。
 * 手抄名单会漂:host 加一个旋钮而这里没跟上,那个旋钮就在这个页面上凭空不
 * 存在,不会有任何东西变红。两道防线:
 *   - 兜底组「其他」—— 认不出分组的旋钮照样渲染成文本框。**宁可丑,不可漏**。
 *   - `packages/host/tests/setting-ui-contract.test.ts` 断言两份名单逐键相等。
 *     门放在 host 是因为 host 是唯一同时依赖 web 的包(web 不许 import host)。
 *
 * ## 文案住在这里(sdui-ui 判例)
 *
 * 这个面板自己的话放在本文件的 `L` 里,而不是 app-core.js 的共享词典——它们
 * 只有一个消费者,搬进共享词典只是多一个漂移源(SHELL-M4 把 140 个 sdui* 词条
 * 搬出来正是这个理由)。既有的 `settingOpsCmd`(每条命令的名字与说明)仍从
 * `AH.t` 读:那份文案是对的、已双语、且被别处引用,复制一份才是错的。
 */
;(function () {
  'use strict'

  const AH = window.Gotong
  const API = '/api/admin/setting'

  // ── 旋钮词典 ───────────────────────────────────────────────────────────────
  // group: 分到哪张卡。ctl: 用哪种控件(服务端仍然是权威校验方——控件挑错了,
  // 保存时会被响亮拒绝,而不是被悄悄接受)。
  const KNOB_UI = {
    // ── 访问与界面 ──
    GOTONG_MODE: {
      group: 'access', ctl: { kind: 'select', options: ['personal', 'team'] },
      zh: ['使用模式', '个人 = 一个人的 hub;团队 = 多人 + 角色分工。不设的时候按现有成员数自动判断。'],
      en: ['Mode', 'personal = one person’s hub; team = several people with roles. Auto-detected when unset.'],
    },
    GOTONG_WEB_PORT: {
      group: 'access', ctl: { kind: 'port' },
      zh: ['网页端口', '就是你现在看的这个界面的端口。改完要重启,浏览器地址栏里的端口也要跟着改。'],
      en: ['Web port', 'The port serving this very page. Restart to apply, then update the port in your browser’s address bar too.'],
    },
    GOTONG_WS_PORT: {
      group: 'access', ctl: { kind: 'port' },
      zh: ['智能体连接端口', 'agent 与联邦对端连进来用的端口。改完要重启,已经配好的对端也要跟着改。'],
      en: ['Agent port', 'Where agents and federated peers connect in. Restart to apply; already-configured peers must be updated too.'],
    },
    GOTONG_OPEN_BROWSER: {
      group: 'access', ctl: { kind: 'select', options: ['auto', 'always', 'never'] },
      zh: ['启动时打开浏览器', 'auto = 只在像本机自用时打开。装在服务器上一般选 never。'],
      en: ['Open browser on start', 'auto = only when this looks like a local desktop run. On a server, never is usually right.'],
    },
    GOTONG_DEFAULT_LANG: {
      group: 'access', ctl: { kind: 'select', options: ['zh', 'en'] },
      zh: ['默认界面语言', '新会话第一次打开时用哪种语言。每个人之后都能自己切换。'],
      en: ['Default language', 'Which language a fresh session opens in. Everyone can still switch it themselves.'],
    },
    GOTONG_PROFILE: {
      group: 'access', ctl: { kind: 'select', options: ['hub', 'federation'] },
      zh: ['控制台视角', '先展示「一个 hub」还是「一片互联的 hub」。只影响呈现顺序,不改变任何行为。'],
      en: ['Console view', 'Foreground one hub, or a federation of hubs. Presentation only — it never changes behaviour.'],
    },

    // ── 阿同在后台做什么 ──
    GOTONG_BUTLER_MAINTENANCE: {
      group: 'butler', ctl: { kind: 'switch' },
      zh: ['整理记忆', '阿同每隔一段时间把零散对话蒸馏成长期记忆。关掉它,下面三项记忆增强也跟着不跑。'],
      en: ['Memory upkeep', 'The butler periodically distils scattered chat into long-term memory. Turning it off also stops the three extras below.'],
    },
    GOTONG_BUTLER_PROACTIVE: {
      group: 'butler', ctl: { kind: 'switch' },
      zh: ['主动发晨报', '每天主动给订阅了的成员发一份问候 + 今天要留意什么。没人订阅就不会发。'],
      en: ['Daily brief', 'Proactively sends subscribed members a morning greeting and what to watch today. Nobody subscribed = nothing sent.'],
    },
    GOTONG_BUTLER_RUN_BROADCAST: {
      group: 'butler', ctl: { kind: 'switch' },
      zh: ['播报工作流结果', '工作流跑完(成功或失败)在 IM 里说一声。这条播报不调用大模型。'],
      en: ['Announce run results', 'Says a word in IM when a workflow finishes, pass or fail. This announcement never calls a model.'],
    },
    GOTONG_BUTLER_MEMORY_GIT: {
      group: 'butler', ctl: { kind: 'switch' }, needs: 'GOTONG_BUTLER_MAINTENANCE',
      zh: ['给记忆存快照', '每次整理记忆时对每个人的记忆目录做一次 git 快照 —— 相当于给记忆一张后悔药。'],
      en: ['Snapshot memory to git', 'Takes a git snapshot of each member’s memory tree on every upkeep pass — an undo net for memory.'],
    },
    GOTONG_BUTLER_MEMORY_LIBRARIAN: {
      group: 'butler', ctl: { kind: 'switch' }, needs: 'GOTONG_BUTLER_MAINTENANCE',
      zh: ['把知识上架', '阿同把成体系的事实整理成 knowledge/ 里的笔记并自己写目录,常驻上下文因此不随知识量变长。'],
      en: ['File knowledge into notes', 'The butler files topical facts into knowledge/ notes and maintains their index, so its always-on context stops growing with what it knows.'],
    },
    GOTONG_BUTLER_MEMORY_RECONCILE: {
      group: 'butler', ctl: { kind: 'switch' }, needs: 'GOTONG_BUTLER_MAINTENANCE',
      zh: ['更正过时的记忆', '整理时把已经不成立或互相矛盾的旧事实翻篇。翻篇不是删除,原件仍留在盘上。'],
      en: ['Retire stale facts', 'Closes out facts that no longer hold or contradict each other. Closing is not deleting — the originals stay on disk.'],
    },
    GOTONG_BUTLER_MEMORY_LINKS: {
      group: 'butler', ctl: { kind: 'switch' },
      zh: ['记忆之间连线', '给记忆建一张联想图,回忆时多走一跳。这项不依赖上面的「整理记忆」。'],
      en: ['Link memories', 'Builds an association graph so recall can travel one hop further. This one does not depend on upkeep above.'],
    },

    // ── 多久做一次 ──
    GOTONG_BUTLER_MAINTENANCE_MS: {
      group: 'cadence', ctl: { kind: 'cadence' },
      zh: ['整理记忆的间隔', '可以写 6h / 90m / 3600000。范围 1 分钟 到 24 小时。'],
      en: ['Upkeep interval', 'Write 6h, 90m, or plain milliseconds. Between 1 minute and 24 hours.'],
    },
    GOTONG_BUTLER_PROACTIVE_MS: {
      group: 'cadence', ctl: { kind: 'cadence' },
      zh: ['多久查一次该不该发晨报', '这是「查一次」的间隔,不是发信频率 —— 该不该发由每个人自己的节律决定。范围 5 分钟 到 1 小时。'],
      en: ['Brief check interval', 'How often it CHECKS whether a brief is due — not how often one is sent; each member’s own rhythm decides that. Between 5 minutes and 1 hour.'],
    },
    GOTONG_BUTLER_RUN_BROADCAST_MS: {
      group: 'cadence', ctl: { kind: 'cadence' },
      zh: ['多久查一次跑完的工作流', '越短播报越及时,代价只是一次读盘。范围 1 分钟 到 1 小时。'],
      en: ['Run-announce interval', 'Shorter means faster announcements; the cost is one disk read. Between 1 minute and 1 hour.'],
    },

    // ── 阿同的感官 ──
    GOTONG_BUTLER_VOICE_MODEL: {
      group: 'senses', ctl: { kind: 'text' },
      zh: ['说话用的模型', '把回复合成成语音条的 TTS 模型名。'],
      en: ['Text-to-speech model', 'The TTS model that turns replies into a voice message.'],
    },
    GOTONG_BUTLER_VOICE_VOICE: {
      group: 'senses', ctl: { kind: 'text' },
      zh: ['音色', '厂商官方系统音色的 id。只接官方系统音色 —— 永远不接真人克隆声音。'],
      en: ['Voice', 'The vendor’s official system voice id. Official system voices only — never a cloned real person.'],
    },
    GOTONG_BUTLER_ASR_MODEL: {
      group: 'senses', ctl: { kind: 'text' },
      zh: ['听语音用的模型', '把收到的语音条转成文字的 ASR 模型名。转成文字之后与打字走同一条路。'],
      en: ['Speech-to-text model', 'Transcribes incoming voice messages. Once transcribed they travel the same path as typed text.'],
    },
    GOTONG_BUTLER_VISION_MODEL: {
      group: 'senses', ctl: { kind: 'text' },
      zh: ['看图用的模型', '识别收到的图片。看得懂 ≠ 有权限动手,动作照样要过审批。'],
      en: ['Vision model', 'Reads incoming images. Being able to see is not permission to act — actions still go through approval.'],
    },
    GOTONG_BUTLER_EMBEDDER_MODEL: {
      group: 'senses', ctl: { kind: 'text' },
      zh: ['语义检索用的模型', 'embeddings 模型名,用来按意思(而不只是按词)找回记忆。'],
      en: ['Embeddings model', 'Used to recall memories by meaning rather than by keyword alone.'],
    },

    // ── 存储归档(STOR-M3b;上下界与服务端校验器一致,权威仍在服务端) ──
    GOTONG_TRANSCRIPT_KEEP_SEGMENTS: {
      group: 'storage', ctl: { kind: 'number', min: 0, max: 10000 },
      zh: ['留几段活跃对话记录', '封存的对话段超过这个数,最旧的搬进 archive/。只搬不删,搬走的照样读得到。'],
      en: ['Active transcript segments', 'Sealed segments beyond this count move into archive/. Moved, never deleted — still readable.'],
    },
    GOTONG_TRANSCRIPT_ARCHIVE_DAYS: {
      group: 'storage', ctl: { kind: 'number', min: 1, max: 3650 },
      zh: ['对话记录几天后归档', '封存段超过这个天数就搬进 archive/。只搬不删。'],
      en: ['Archive transcripts after (days)', 'Sealed segments older than this move into archive/. Moved, never deleted.'],
    },
    GOTONG_RUN_KEEP: {
      group: 'storage', ctl: { kind: 'number', min: 0, max: 10000 },
      zh: ['留几条跑完的工作流', '跑完的 run 超过这个数,最旧的搬进 runs/archive/。只搬不删,正在跑的碰都不碰。'],
      en: ['Finished runs kept active', 'Finished runs beyond this count move into runs/archive/. Moved, never deleted; running ones are untouchable.'],
    },
    GOTONG_RUN_ARCHIVE_DAYS: {
      group: 'storage', ctl: { kind: 'number', min: 1, max: 3650 },
      zh: ['工作流记录几天后归档', '跑完的 run 超过这个天数就搬进 runs/archive/。只搬不删。'],
      en: ['Archive runs after (days)', 'Finished runs older than this move into runs/archive/. Moved, never deleted.'],
    },

    // ── 对外 ──
    GOTONG_UPDATE_CHECK: {
      group: 'outward', ctl: { kind: 'switch' },
      zh: ['每天查一次新版本', '一天一次对外请求,有新版在面板上提示一句。关着 = 不联网、连定时器都不起。'],
      en: ['Daily update check', 'One outbound request a day; a new release shows as a note on the dashboard. Off = no network and no timer at all.'],
    },
    GOTONG_A2A_SIGN_CARD: {
      group: 'outward', ctl: { kind: 'switch' },
      zh: ['给对外名片签名', '别人取到这台 hub 的公开名片时可以验完整性。签名只证「没被改过」,不证明发名片的是谁。关掉再打开,用的还是同一把钥匙。'],
      en: ['Sign the public agent card', 'Lets anyone fetching this hub’s public card verify integrity. A signature proves the card was not altered — not who sent it. The key survives turning this off and on.'],
    },
  }

  const GROUPS = ['access', 'butler', 'cadence', 'senses', 'storage', 'outward', 'other']

  // 这个面板自己的话。见文件头「文案住在这里」。
  const L = {
    zh: {
      title: '设置',
      lede: '这里改的每一项都写进下面那个文件,重启后生效。凭证不在这里 —— 它们只进金库。',
      fileLabel: '配置文件',
      fileNote: '这台 hub 每次启动都会读它。你可以直接打开看,里面就是下面这些行。',
      loading: '正在读取当前配置…',
      loadFailed: (e) => '读不到当前配置:' + e,
      notEnabled: '这台 hub 没有启用设置台。',
      gAccess: '访问与界面',
      gAccessNote: '端口、语言、以及这个控制台先展示什么。改端口要重启。',
      gButler: '阿同在后台做什么',
      gButlerNote: '都是无人值守时自己跑的活。关掉任何一项,这台 hub 只是少做这件事,不会少一分能力。',
      gCadence: '多久做一次',
      gCadenceNote: '可以写 6h / 90m,也可以写毫秒。超出允许范围会被拒绝,不会被悄悄改成别的值。',
      gSenses: '阿同的感官',
      gSensesNote: '这里只有「用哪个模型」。端点地址和 key 是凭证,只进金库,不在这个页面上。留空 = 这项能力不开。',
      gStorage: '存储归档',
      gStorageNote: '旧对话段和跑完的工作流,超过多少就搬进 archive/。四项都只搬不删——归档的照样读得到。留空 = 不归档。改完要重启才生效。',
      gOutward: '对外',
      gOutwardNote: '会不会主动往外发请求。两项默认都是关的。',
      gOther: '其他',
      gOtherNote: '这台 hub 认得、但这个页面还没为它写标签的旋钮。仍然可以改。',
      needsOff: (n) => '要先打开「' + n + '」这项才会跑。',
      provDefault: '默认',
      provFile: '你设的',
      provEnv: '被环境覆盖',
      provDirty: '未保存',
      envNote: '这个值由启动这台 hub 的环境(systemd / compose / shell)决定,压过配置文件。要改它得改那里。',
      envOnlyNote: '这个值只存在于启动环境里。在这里写会被它盖住,所以先去那边改。',
      resetOne: '改回默认',
      provWillReset: '将改回默认',
      cancelReset: '撤销',
      dirtyCount: (n) => '有 ' + n + ' 项改动还没保存',
      save: '保存',
      saving: '正在保存…',
      discard: '放弃改动',
      savedOk: (n) => '已写入 ' + n + ' 项 —— 重启这台 hub 之后才会生效。',
      savedFail: (k, e) => k + ' 没写进去:' + e,
      secretsTitle: '凭证',
      secretsNote: '只显示有没有,永远不显示值。要改凭证去「智能体」或对阿同说 /setkey。',
      secretSet: '已设',
      secretUnset: '未设',
      pricingTitle: '模型价格',
      pricingNote: (p) => '账单按这张表算。没有覆盖时用内置价格。文件:' + p,
      pricingNone: '没有自定义价格,用的是内置价目。',
      pricingSome: (n) => '有 ' + n + ' 个模型用了自定义价格。',
      pricingCorrupt: '这个文件坏了 —— 不修好会在下次启动时报错。',
      priceModel: '模型名',
      priceIn: '输入 / 百万 token',
      priceOut: '输出 / 百万 token',
      priceCw: '缓存写 / 百万(可留空)',
      priceCr: '缓存读 / 百万(可留空)',
      priceSave: '写入价格',
      actionsTitle: '维护动作',
      actionsNote: '都是安全的:只读,或者做完还能再做一次也不出事。',
      run: '运行',
      running: '运行中…',
      runFailed: (e) => '没跑成:' + e,
      dangerTitle: '危险区',
      dangerNote: '这三件事发生在 hub 停着或正被替换的时候 —— 那时这个网页本身就不在跑,所以这里没有按钮,只有该敲的命令。',
      copyHint: '在服务器上敲这条:',
      langNote: null,
    },
    en: {
      title: 'Settings',
      lede: 'Everything you change here is written to the file below and takes effect on restart. Credentials are not here — they only go to the vault.',
      fileLabel: 'Config file',
      fileNote: 'This hub reads it on every start. You can open it yourself — it holds exactly the lines below.',
      loading: 'Reading current configuration…',
      loadFailed: (e) => 'Could not read the configuration: ' + e,
      notEnabled: 'The settings console is not enabled on this hub.',
      gAccess: 'Access & interface',
      gAccessNote: 'Ports, language, and what this console foregrounds. Port changes need a restart.',
      gButler: 'What the butler does in the background',
      gButlerNote: 'All unattended work. Turning any of it off makes this hub do less — never makes it able to do less.',
      gCadence: 'How often',
      gCadenceNote: 'Write 6h or 90m, or plain milliseconds. Out-of-range values are refused, never silently clamped to something else.',
      gSenses: 'The butler’s senses',
      gSensesNote: 'Only model names live here. Endpoints and keys are credentials — vault only, never this page. Blank = that sense is off.',
      gStorage: 'Storage archiving',
      gStorageNote: 'When old transcript segments and finished runs move into archive/. All four move, never delete — archived data stays readable. Blank = no archiving. Takes effect at next restart.',
      gOutward: 'Outbound',
      gOutwardNote: 'Whether this hub reaches out on its own. Both are off by default.',
      gOther: 'Other',
      gOtherNote: 'Knobs this hub knows about that this page has no label for yet. Still editable.',
      needsOff: (n) => 'Runs only once “' + n + '” is on.',
      provDefault: 'default',
      provFile: 'you set this',
      provEnv: 'set by the environment',
      provDirty: 'unsaved',
      envNote: 'This value comes from the environment that starts this hub (systemd / compose / shell) and wins over the config file. Change it there.',
      envOnlyNote: 'This value exists only in the start-up environment. Writing it here would be shadowed by it — change it there instead.',
      resetOne: 'reset to default',
      provWillReset: 'will reset to default',
      cancelReset: 'undo',
      dirtyCount: (n) => n + ' unsaved change' + (n === 1 ? '' : 's'),
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      savedOk: (n) => 'Wrote ' + n + ' setting' + (n === 1 ? '' : 's') + ' — applies after this hub restarts.',
      savedFail: (k, e) => k + ' was not written: ' + e,
      secretsTitle: 'Credentials',
      secretsNote: 'Set or unset only — never the value. Change them under Agents, or tell the butler /setkey.',
      secretSet: 'set',
      secretUnset: 'unset',
      pricingTitle: 'Model prices',
      pricingNote: (p) => 'Billing is computed from this table; built-in prices are used where you have no override. File: ' + p,
      pricingNone: 'No overrides — built-in prices are in use.',
      pricingSome: (n) => n + ' model' + (n === 1 ? '' : 's') + ' priced by you.',
      pricingCorrupt: 'This file is corrupt — fix it or boot will fail.',
      priceModel: 'Model',
      priceIn: 'Input / 1M tokens',
      priceOut: 'Output / 1M tokens',
      priceCw: 'Cache write / 1M (optional)',
      priceCr: 'Cache read / 1M (optional)',
      priceSave: 'Write price',
      actionsTitle: 'Maintenance',
      actionsNote: 'All safe: read-only, or harmless to run twice.',
      run: 'Run',
      running: 'Running…',
      runFailed: (e) => 'Did not run: ' + e,
      dangerTitle: 'Danger zone',
      dangerNote: 'These three happen while the hub is down or being replaced — this web page is not running then, so there are no buttons here, only the command to type.',
      copyHint: 'Run this on the server:',
      langNote: null,
    },
  }

  function lang() { return AH.lang === 'en' ? 'en' : 'zh' }
  function L2() { return L[lang()] }
  function knobText(key) {
    const ui = KNOB_UI[key]
    if (!ui) return [key, '']
    return ui[lang()] || ui.zh
  }

  // ── provenance(见文件头) ──────────────────────────────────────────────────
  function provenanceOf(k) {
    const env = k.envValue
    const envSet = typeof env === 'string' && env !== ''
    if (envSet && k.fileValue !== null && k.fileValue !== env) return 'env'
    if (envSet && k.fileValue === null) return 'env-only'
    if (k.fileValue !== null) return 'file'
    return 'default'
  }
  /** 控件里该显示什么:环境赢的时候显示环境的值,否则显示文件的值,再否则默认。 */
  function shownValue(k) {
    const p = provenanceOf(k)
    if (p === 'env' || p === 'env-only') return k.envValue
    return k.fileValue !== null ? k.fileValue : k.default
  }

  // ── DOM 助手(全程 textContent / createElement,零 innerHTML) ───────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined && text !== null) n.textContent = String(text)
    return n
  }

  // 「改回默认」暂存的是一个**动作**不是一个值。写默认值会在盘上留下一行,页面
  // 从此得管一个人刚说不要再管的旋钮叫「你设过」,而那一行还会把今天的默认值钉
  // 死到将来某个版本改了默认之后。空串也当不了这个哨兵:对五个感官旋钮它已经
  // 是「显式清除」的意思,而自由文本旋钮本来就能装任何串——没有哪个值能表示
  // 「没有值」。所以用一个 Symbol,它与任何旋钮值都不可能相等。
  const UNSET = Symbol('unset')

  // ── 状态 ──────────────────────────────────────────────────────────────────
  const state = {
    cfg: null,        // EffectiveConfigView
    cmds: [],         // SettingCommandInfo[]
    pending: new Map(), // key -> 待保存的值
    status: null,     // { text, kind }
    busy: false,
  }

  function panel() { return document.getElementById('setting-ops-panel') }

  async function readJson(res) {
    const text = await res.text()
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { /* 非 JSON:下面按状态码报 */ }
    if (!res.ok) {
      const msg = (body && (body.message || body.error)) || ('HTTP ' + res.status)
      throw new Error(msg)
    }
    return body
  }
  function apiCommands() {
    return fetch(API + '/commands', { credentials: 'same-origin' }).then(readJson)
  }
  function apiRun(id, args) {
    return fetch(API + '/run', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args && args.length ? { id, args } : { id }),
    }).then(readJson)
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  function renderProvBadge(row, prov) {
    const s = L2()
    const b = el('span', 'set-prov')
    if (prov === 'dirty') { b.classList.add('is-dirty'); b.textContent = s.provDirty }
    else if (prov === 'env' || prov === 'env-only') { b.classList.add('is-env'); b.textContent = s.provEnv }
    else if (prov === 'file') { b.classList.add('is-file'); b.textContent = s.provFile }
    else { b.classList.add('is-default'); b.textContent = s.provDefault }
    row.appendChild(b)
    return b
  }

  function makeControl(k, ui, locked, onChange) {
    const kind = (ui && ui.ctl && ui.ctl.kind) || 'text'
    // 暂存了「改回默认」时控件就预览默认值——保存后生效的正是它。
    const staged = state.pending.has(k.key) ? state.pending.get(k.key) : undefined
    const value = staged === undefined ? shownValue(k) : staged === UNSET ? k.default : staged

    if (kind === 'switch') {
      const wrap = el('label', 'set-switch')
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.checked = String(value) === 'true'
      input.disabled = locked
      const track = el('span', 'set-switch-track')
      wrap.appendChild(input)
      wrap.appendChild(track)
      input.addEventListener('change', () => onChange(input.checked ? 'true' : 'false'))
      return { node: wrap, focusable: input }
    }

    if (kind === 'select') {
      const sel = el('select', 'set-ctl')
      for (const opt of ui.ctl.options) {
        const o = el('option', null, opt)
        o.value = opt
        sel.appendChild(o)
      }
      // 值不在闭集里(手改过文件)也要照实显示,而不是悄悄跳到第一项。
      if (ui.ctl.options.indexOf(String(value)) === -1) {
        const o = el('option', null, String(value))
        o.value = String(value)
        sel.appendChild(o)
      }
      sel.value = String(value)
      sel.disabled = locked
      sel.addEventListener('change', () => onChange(sel.value))
      return { node: sel, focusable: sel }
    }

    const input = el('input', 'set-ctl')
    if (kind === 'port' || kind === 'number') {
      input.type = 'number'
      input.min = String(ui.ctl.min !== undefined ? ui.ctl.min : 1)
      input.max = String(ui.ctl.max !== undefined ? ui.ctl.max : 65535)
      input.inputMode = 'numeric'
    } else {
      input.type = 'text'
      input.autocomplete = 'off'
      input.spellcheck = false
    }
    input.value = String(value)
    input.disabled = locked
    input.addEventListener('input', () => onChange(input.value))
    return { node: input, focusable: input }
  }

  function knobRow(k) {
    const s = L2()
    const ui = KNOB_UI[k.key]
    const [label, help] = knobText(k.key)
    const prov = provenanceOf(k)
    const locked = prov === 'env' || prov === 'env-only'
    const dirty = state.pending.has(k.key)

    const row = el('div', 'set-row' + (dirty ? ' is-dirty' : ''))

    const left = el('div')
    left.appendChild(el('div', 'set-row-label', label))
    if (help) left.appendChild(el('div', 'set-row-help', help))
    // 依赖关系:级联在「整理记忆」下面的三项,在它关着的时候如实说清楚。
    if (ui && ui.needs) {
      const parent = state.cfg.knobs.filter((x) => x.key === ui.needs)[0]
      const parentOn = parent
        ? String(state.pending.has(parent.key) ? state.pending.get(parent.key) : shownValue(parent)) === 'true'
        : true
      if (!parentOn) left.appendChild(el('div', 'set-shadow-note', s.needsOff(knobText(ui.needs)[0])))
    }
    left.appendChild(el('code', 'set-row-key', k.key))

    const right = el('div', 'set-row-ctl')
    const ctl = makeControl(k, ui, locked, (v) => {
      // 已暂存「改回默认」时控件显示的就是默认值:再选中同一项什么也没改,不能
      // 让这一下把那个意图悄悄取消掉(取消有它自己那个按钮)。
      if (state.pending.get(k.key) === UNSET && v === k.default) return
      // 改回与盘上一致 ⇒ 不算改动(否则保存会写一行完全一样的值)。
      if (v === shownValue(k)) state.pending.delete(k.key)
      else state.pending.set(k.key, v)
      render()
      const again = document.getElementById('knob-' + k.key)
      if (again) again.focus()
    })
    ctl.focusable.id = 'knob-' + k.key
    right.appendChild(ctl.node)

    const willReset = state.pending.get(k.key) === UNSET
    const meta = el('div', 'set-meta')
    if (willReset) meta.appendChild(el('span', 'set-prov is-dirty', s.provWillReset))
    else renderProvBadge(meta, dirty ? 'dirty' : prov)
    // 出现的条件是**盘上真有一行**,不是「当前值不等于默认值」:后者在有人把默认值
    // 显式写进文件时会让按钮凭空消失,而那正是最需要它的那一刻。暂存后按钮换成
    // 「撤销」——保存之前每一步都退得回去。
    if (!locked && willReset) {
      const undo = el('button', 'set-linkbtn', s.cancelReset)
      undo.type = 'button'
      undo.addEventListener('click', () => { state.pending.delete(k.key); render() })
      meta.appendChild(undo)
    } else if (!locked && prov === 'file') {
      const reset = el('button', 'set-linkbtn', s.resetOne)
      reset.type = 'button'
      reset.addEventListener('click', () => {
        state.pending.set(k.key, UNSET)
        render()
      })
      meta.appendChild(reset)
    }
    right.appendChild(meta)
    if (locked) {
      right.appendChild(el('div', 'set-shadow-note', prov === 'env' ? s.envNote : s.envOnlyNote))
    }

    row.appendChild(left)
    row.appendChild(right)
    return row
  }

  function groupCard(id, title, note, rows) {
    if (!rows.length) return null
    const g = el('section', 'set-group')
    g.appendChild(el('h3', 'set-group-head', title))
    if (note) g.appendChild(el('p', 'set-group-note', note))
    for (const r of rows) g.appendChild(r)
    return g
  }

  function renderKnobs(root) {
    const s = L2()
    const titles = {
      access: [s.gAccess, s.gAccessNote],
      butler: [s.gButler, s.gButlerNote],
      cadence: [s.gCadence, s.gCadenceNote],
      senses: [s.gSenses, s.gSensesNote],
      storage: [s.gStorage, s.gStorageNote],
      outward: [s.gOutward, s.gOutwardNote],
      other: [s.gOther, s.gOtherNote],
    }
    const buckets = {}
    for (const g of GROUPS) buckets[g] = []
    for (const k of state.cfg.knobs) {
      const ui = KNOB_UI[k.key]
      // 兜底:没登记的旋钮照样出现在「其他」里。宁可丑,不可漏。
      const g = ui && buckets[ui.group] ? ui.group : 'other'
      buckets[g].push(knobRow(k))
    }
    for (const g of GROUPS) {
      const card = groupCard(g, titles[g][0], titles[g][1], buckets[g])
      if (card) root.appendChild(card)
    }
  }

  function renderSaveBar(root) {
    const s = L2()
    const bar = el('div', 'set-bar')
    if (state.pending.size === 0) { bar.hidden = true; root.appendChild(bar); return }
    bar.appendChild(el('span', null, s.dirtyCount(state.pending.size)))
    const spacer = el('span')
    spacer.style.flex = '1'
    bar.appendChild(spacer)
    const discard = el('button', 'set-btn', s.discard)
    discard.type = 'button'
    discard.disabled = state.busy
    discard.addEventListener('click', () => { state.pending.clear(); render() })
    const save = el('button', 'set-btn is-primary', state.busy ? s.saving : s.save)
    save.type = 'button'
    save.disabled = state.busy
    save.addEventListener('click', saveAll)
    bar.appendChild(discard)
    bar.appendChild(save)
    root.appendChild(bar)
  }

  async function saveAll() {
    state.busy = true
    state.status = null
    render()
    const entries = Array.from(state.pending.entries())
    let done = 0
    let failure = null
    for (const [key, value] of entries) {
      try {
        // 程序化传 [key, value]:值里的空格因此原样保留,不必让人去想引号。
        if (value === UNSET) await apiRun('config-unset', [key])
        else await apiRun('config-set', [key, value])
        state.pending.delete(key)
        done += 1
      } catch (err) {
        failure = { key, msg: err && err.message ? err.message : String(err) }
        break // 停在第一个失败上:后面的没写,页面接着显示它们仍未保存。
      }
    }
    state.busy = false
    // 存的是**怎么说这句话**,不是说好的那句话:切语言会整块重画,一句冻在旧
    // 语言里的回执会跟着周围每一个字一起换语言的界面对不上。
    state.status = failure
      ? { make: (s) => s.savedFail(failure.key, failure.msg), kind: 'error' }
      : { make: (s) => s.savedOk(done), kind: 'ok' }
    await reloadConfig()
  }

  function renderSecrets(root) {
    const s = L2()
    const g = el('section', 'set-group')
    g.appendChild(el('h3', 'set-group-head', s.secretsTitle))
    g.appendChild(el('p', 'set-group-note', s.secretsNote))
    const row = el('div', 'set-chiprow')
    for (const sec of state.cfg.secrets) {
      const chip = el('span', 'set-chip' + (sec.set ? ' is-set' : ''))
      chip.appendChild(el('code', null, sec.key))
      chip.appendChild(el('span', null, sec.set ? s.secretSet : s.secretUnset))
      row.appendChild(chip)
    }
    g.appendChild(row)
    root.appendChild(g)
  }

  function renderPricing(root) {
    const s = L2()
    const p = state.cfg.pricing
    const g = el('section', 'set-group')
    g.appendChild(el('h3', 'set-group-head', s.pricingTitle))
    g.appendChild(el('p', 'set-group-note', s.pricingNote(p.path)))
    const line = el('p', 'set-group-note')
    line.textContent = p.corrupt ? s.pricingCorrupt : (!p.present ? s.pricingNone : s.pricingSome(p.overrideModels))
    if (p.corrupt) line.className = 'set-alarm'
    g.appendChild(line)

    // config-price 是唯一剩下的自由形状写入。给它一张真正的表单,而不是让人
    // 去记 `<model> <in> <out> [cw] [cr]` 这个位置约定。
    const fields = [
      { id: 'model', label: s.priceModel, type: 'text' },
      { id: 'in', label: s.priceIn, type: 'number' },
      { id: 'out', label: s.priceOut, type: 'number' },
      { id: 'cw', label: s.priceCw, type: 'number' },
      { id: 'cr', label: s.priceCr, type: 'number' },
    ]
    const inputs = {}
    for (const f of fields) {
      const row = el('div', 'set-row')
      const left = el('div')
      left.appendChild(el('div', 'set-row-label', f.label))
      const right = el('div', 'set-row-ctl')
      const inp = el('input', 'set-ctl')
      inp.type = f.type
      inp.autocomplete = 'off'
      if (f.type === 'number') { inp.min = '0'; inp.step = 'any' }
      inputs[f.id] = inp
      right.appendChild(inp)
      row.appendChild(left)
      row.appendChild(right)
      g.appendChild(row)
    }
    const act = el('div', 'set-act')
    const btn = el('button', 'set-btn', s.priceSave)
    btn.type = 'button'
    const out = el('pre', 'set-out')
    out.hidden = true
    btn.addEventListener('click', async () => {
      const args = [inputs.model.value.trim(), inputs['in'].value.trim(), inputs.out.value.trim()]
      if (inputs.cw.value.trim()) args.push(inputs.cw.value.trim())
      if (inputs.cr.value.trim()) args.push(inputs.cr.value.trim())
      btn.disabled = true
      btn.textContent = s.running
      try {
        const body = await apiRun('config-price', args)
        out.hidden = false
        out.className = 'set-out'
        out.textContent = (body.result.lines || []).join('\n')
        await reloadConfig()
      } catch (err) {
        out.hidden = false
        out.className = 'set-out is-error'
        out.textContent = s.runFailed(err && err.message ? err.message : String(err))
      } finally {
        btn.disabled = false
        btn.textContent = s.priceSave
      }
    })
    act.appendChild(btn)
    g.appendChild(act)
    g.appendChild(out)
    root.appendChild(g)
  }

  // 这些命令由这个页面自己消费,不再是一颗给人按的按钮:
  //   config       —— 就是本页的数据源
  //   config-set   —— 保存按钮
  //   config-price —— 上面那张表单
  const CONSUMED = ['config', 'config-set', 'config-unset', 'config-price']

  function renderActions(root) {
    const s = L2()
    const t = AH.t
    const rows = state.cmds.filter((c) => c.tier !== 'destructive-offline' && CONSUMED.indexOf(c.id) === -1)
    if (!rows.length) return
    const g = el('section', 'set-group')
    g.appendChild(el('h3', 'set-group-head', s.actionsTitle))
    g.appendChild(el('p', 'set-group-note', s.actionsNote))
    for (const c of rows) {
      const copy = (t.settingOpsCmd && t.settingOpsCmd[c.id]) || null
      const row = el('div', 'set-act')
      const left = el('div')
      left.appendChild(el('div', 'set-act-name', copy ? copy.title : c.title))
      left.appendChild(el('div', 'set-act-note', copy ? copy.summary : c.summary))
      const out = el('pre', 'set-out')
      out.hidden = true
      const btn = el('button', 'set-btn', s.run)
      btn.type = 'button'
      btn.disabled = !c.runnableHere
      btn.addEventListener('click', async () => {
        btn.disabled = true
        btn.textContent = s.running
        try {
          const body = await apiRun(c.id, [])
          out.hidden = false
          out.className = 'set-out'
          out.textContent = (body.result.lines || []).join('\n')
        } catch (err) {
          out.hidden = false
          out.className = 'set-out is-error'
          out.textContent = s.runFailed(err && err.message ? err.message : String(err))
        } finally {
          btn.disabled = false
          btn.textContent = s.run
        }
      })
      row.appendChild(left)
      row.appendChild(btn)
      g.appendChild(row)
      g.appendChild(out)
    }
    root.appendChild(g)
  }

  function renderDanger(root) {
    const s = L2()
    const t = AH.t
    const rows = state.cmds.filter((c) => c.tier === 'destructive-offline')
    if (!rows.length) return
    const g = el('section', 'set-group is-danger')
    g.appendChild(el('h3', 'set-group-head', s.dangerTitle))
    g.appendChild(el('p', 'set-group-note', s.dangerNote))
    for (const c of rows) {
      const copy = (t.settingOpsCmd && t.settingOpsCmd[c.id]) || null
      const row = el('div', 'set-act')
      const left = el('div')
      left.appendChild(el('div', 'set-act-name', copy ? copy.title : c.title))
      left.appendChild(el('div', 'set-act-note', copy ? copy.summary : c.summary))
      // 指路,而不是藏起来:把该敲的那条命令原样印出来。
      left.appendChild(el('div', 'set-act-note', s.copyHint))
      left.appendChild(el('code', 'set-cli', 'gotong setting ' + c.id))
      row.appendChild(left)
      g.appendChild(row)
    }
    root.appendChild(g)
  }

  function render() {
    const host = panel()
    if (!host) return
    const s = L2()
    host.textContent = ''
    host.className = 'set-root'

    host.appendChild(el('h2', 'set-head', s.title))
    host.appendChild(el('p', 'set-lede', s.lede))

    if (state.status) {
      const st = el('p', 'set-status ' + (state.status.kind === 'error' ? 'is-error' : 'is-ok'), state.status.make(s))
      host.appendChild(st)
    }

    // 读不到配置时**仍然**渲染动作区与危险区。那正是你最需要「体检」和
    // 「补目录」的时刻——把诊断工具跟着故障一起藏起来是最坏的一种失败。
    if (state.cfg) {
      const file = el('div', 'set-file')
      file.appendChild(el('div', 'set-file-label', s.fileLabel))
      file.appendChild(el('code', 'set-file-path', state.cfg.envFilePath))
      file.appendChild(el('div', 'set-file-note', s.fileNote))
      host.appendChild(file)

      renderKnobs(host)
      renderSaveBar(host)
      renderSecrets(host)
      renderPricing(host)
    } else if (!state.status) {
      host.appendChild(el('p', 'set-status', s.loading))
    }

    renderActions(host)
    renderDanger(host)
  }

  async function reloadConfig() {
    try {
      const body = await apiRun('config', [])
      state.cfg = body.result.data
    } catch (err) {
      state.cfg = null
      const msg = err && err.message ? err.message : String(err)
      state.status = { make: (s) => s.loadFailed(msg), kind: 'error' }
    }
    render()
  }

  let loaded = false
  async function load() {
    const host = panel()
    if (!host) return
    // 目录先取:它决定这个面板存不存在。配置**分开**取,好让「配置读不出来」
    // 只吃掉配置那一半,而不是把整个面板连同诊断按钮一起吃掉。
    try {
      const cmds = await apiCommands()
      state.cmds = cmds.commands || []
    } catch (err) {
      const msg = err && err.message ? err.message : String(err)
      // 没启用(503)= 这台 hub 就是没有这个面板,安静地不显示比报一个错更诚实。
      if (/HTTP 503/.test(msg) || /not enabled/i.test(msg)) { host.hidden = true; return }
      host.hidden = false
      state.status = { make: (s) => s.loadFailed(msg), kind: 'error' }
      loaded = true
      render()
      return
    }
    host.hidden = false
    loaded = true
    await reloadConfig()
  }

  function init() {
    const host = panel()
    if (!host) return
    const maybeLoad = () => {
      if (document.body.dataset.activeTab === 'settings' && !loaded) load()
    }
    new MutationObserver(maybeLoad).observe(document.body, { attributes: true, attributeFilter: ['data-active-tab'] })
    maybeLoad()
    // 切语言:重画即可 —— 值全在 state 里,未保存的改动不会因为换个语言就丢。
    if (AH && typeof AH.onLangChange === 'function') AH.onLangChange(() => { if (loaded) render() })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
