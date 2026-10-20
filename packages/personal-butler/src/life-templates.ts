/**
 * life-templates.ts — LIFE-M1。生活档案的**预置模板**:领域、流水字段、规程、提醒规则。
 *
 * # 为什么结构是常量而不是让阿同自建
 *
 * LIB track 的知识库是「目录学不预设」——层级全由阿同自己编排。生产里阿同自建的
 * 身体档案证明了那条路的代价:两个月才成型、结构会走样、防串规程是记混后才补的、
 * 每次更新整篇重写。用户 2026-10-20 拍板对核心生活领域反转这一条:**结构归模板,
 * 内容归阿同,规程归成员**。所以这里是代码常量:
 *
 *   - 分区与字段由数据结构保证,阿同写不出游离段落;
 *   - 规程(怎么记/怎么答/怎么判断/何时提醒/边界)随档案卡下发,打开哪本带哪本;
 *     阿同只能**提议**补充条款,成员原话确认才生效(见 life-store.ts)。
 *   - 模板升级只改这里;成员确认过的补充条款存在各自 dossier.json,不被覆盖。
 *
 * 数字口径(单位、取值范围、必填)也在这里——写入时校验,把「72.4」和「72.4 斤」
 * 这种口径事故挡在落盘之前,而不是靠模型每次记得。
 */

export const LIFE_TEMPLATE_VERSION = 1

export type LifeFieldType = 'number' | 'integer' | 'text' | 'enum' | 'date' | 'time' | 'boolean'

export interface LifeFieldSpec {
  readonly name: string
  readonly label: string
  readonly type: LifeFieldType
  readonly unit?: string
  readonly min?: number
  readonly max?: number
  /** number 的小数位上限(写入时四舍五入到这一位)。 */
  readonly decimals?: number
  readonly values?: readonly string[]
  readonly required?: boolean
  /** 条件必填:另一字段等于某值时本字段必填(如项目「搁置」必须写恢复条件)。 */
  readonly requiredWhen?: { readonly field: string; readonly equals: string }
  /** text 字段的字符上限(默认 200)。 */
  readonly maxChars?: number
  /** 缺省值(未给时自动填,如币种)。 */
  readonly default?: string | number | boolean
}

export interface LifeStreamSpec {
  /** 流水 id,在领域内唯一;工具里写成 `<domain>.<stream>`。 */
  readonly id: string
  readonly label: string
  readonly fields: readonly LifeFieldSpec[]
  /**
   * 主数值字段:聚合不指定字段时用它(体重的 kg、收支的 amount)。缺席 = 这条流水
   * 只计数(如训练、伤病)。
   */
  readonly primary?: string
  /**
   * 状态型流水的键字段:同键只取最新一条为「当前状态」(项目、承诺、决定、账户)。
   * 缺席 = 事件型流水,每条都是一次事件。
   */
  readonly key?: string
  /** 至少要有其中一个字段(心境三分可只报一项)。 */
  readonly requireAny?: readonly string[]
  /** 聚合时按某字段取负(账户余额里的负债)。 */
  readonly negateWhen?: { readonly field: string; readonly values: readonly string[] }
  /** 金额类流水:sum/avg 只在同一币种内进行(不擅自换算)。 */
  readonly currencyField?: string
}

/** 档案卡「现状」里由代码算出的一行。 */
export interface LifeStatusMetric {
  readonly label: string
  readonly stream: string
  readonly agg: LifeStatusAgg
  readonly field?: string
  readonly where?: Readonly<Record<string, string>>
  readonly unit?: string
}

export type LifeStatusAgg =
  /** 最新一条的主字段值 + 日期。 */
  | 'latest'
  /** 截至今天的 7 日均值。 */
  | 'ma7'
  /** 近 28 天的周斜率(每周变化量)。 */
  | 'trend28'
  /** 本周(周一起)条数。 */
  | 'week_count'
  /** 本周主字段合计。 */
  | 'week_sum'
  /** 本月主字段合计。 */
  | 'month_sum'
  /** 近 7 天主字段均值(只算有记录的天)。 */
  | 'avg7'
  /** 状态型流水:按键取最新后、按某字段计数(如「进行 3 / 搁置 2」)。 */
  | 'current_by'
  /** 状态型流水:按键取最新后主字段合计(净资产)。 */
  | 'current_sum'

export type LifeAlertRule =
  | {
      readonly id: string
      readonly kind: 'no_record_days'
      readonly stream: string
      readonly days: number
      readonly text: string
      readonly push: boolean
    }
  | {
      /** 目标型提醒:dossier 里带 metric 的目标,达到阈值比例时提醒(预算 80%/100%)。 */
      readonly id: string
      readonly kind: 'goal_ratio'
      readonly ratios: readonly number[]
      readonly push: boolean
    }
  | {
      /** 日期字段到期:状态型流水里某日期字段在 N 天内到期(承诺截止、决定复盘)。 */
      readonly id: string
      readonly kind: 'due_within'
      readonly stream: string
      readonly field: string
      /** 只看这些状态(如承诺「待办」、决定「已决定」)。 */
      readonly activeWhen?: { readonly field: string; readonly values: readonly string[] }
      readonly days: number
      readonly text: string
      readonly push: boolean
    }
  | {
      /** 低分连击:最近 N 条某字段都 ≤ 阈值(心境连续低落)。 */
      readonly id: string
      readonly kind: 'low_run'
      readonly stream: string
      readonly field: string
      readonly threshold: number
      readonly count: number
      readonly text: string
      readonly push: boolean
    }
  | {
      /** 每月固定日:状态型流水里 dayOfMonth 字段在 N 天内到来(固定扣款)。 */
      readonly id: string
      readonly kind: 'monthly_day_within'
      readonly stream: string
      readonly field: string
      readonly activeWhen?: { readonly field: string; readonly values: readonly string[] }
      readonly days: number
      readonly text: string
      readonly push: boolean
    }

export interface LifeProtocol {
  readonly record: readonly string[]
  readonly answer: readonly string[]
  readonly judge: readonly string[]
  readonly remind: readonly string[]
  readonly bounds: readonly string[]
}

export interface LifeDomainTemplate {
  readonly id: string
  readonly label: string
  /** 驾驶舱卡上的一句「这本管什么」——阿同靠它判断该开哪本。 */
  readonly scope: string
  /** 敏感档案:不进自动记忆单,不被 search_memory 搜到,转派时只写必要结论。 */
  readonly sensitive: boolean
  readonly streams: readonly LifeStreamSpec[]
  readonly status: readonly LifeStatusMetric[]
  readonly protocol: LifeProtocol
  readonly alerts: readonly LifeAlertRule[]
}

const NOTE: LifeFieldSpec = { name: 'note', label: '备注', type: 'text', maxChars: 200 }

const HEALTH: LifeDomainTemplate = {
  id: 'health',
  label: '健康',
  scope: '体重体脂、训练、睡眠、伤病与体检',
  sensitive: false,
  streams: [
    {
      id: 'weight',
      label: '体重体脂',
      primary: 'kg',
      fields: [
        { name: 'kg', label: '体重', type: 'number', unit: 'kg', min: 20, max: 300, decimals: 1, required: true },
        { name: 'bodyFat', label: '体脂率', type: 'number', unit: '%', min: 2, max: 70, decimals: 1 },
        { name: 'condition', label: '称量条件', type: 'enum', values: ['晨起空腹', '其他'], default: '其他' },
        NOTE,
      ],
    },
    {
      id: 'workout',
      label: '训练',
      primary: 'minutes',
      fields: [
        { name: 'type', label: '项目', type: 'text', maxChars: 40, required: true },
        { name: 'minutes', label: '时长', type: 'integer', unit: '分钟', min: 1, max: 600 },
        { name: 'distanceKm', label: '距离', type: 'number', unit: 'km', min: 0, max: 500, decimals: 2 },
        { name: 'detail', label: '组数/配速等', type: 'text', maxChars: 120 },
        { name: 'rpe', label: '主观强度', type: 'integer', min: 1, max: 10 },
        NOTE,
      ],
    },
    {
      id: 'sleep',
      label: '睡眠',
      primary: 'hours',
      fields: [
        { name: 'hours', label: '睡眠时长', type: 'number', unit: '小时', min: 0, max: 24, decimals: 1, required: true },
        { name: 'bedtime', label: '入睡', type: 'time' },
        { name: 'wake', label: '起床', type: 'time' },
        { name: 'quality', label: '主观质量', type: 'integer', min: 1, max: 5 },
        NOTE,
      ],
    },
    {
      id: 'condition',
      label: '伤病与体检',
      fields: [
        { name: 'kind', label: '类别', type: 'enum', values: ['伤病', '不适', '体检', '其他'], required: true },
        { name: 'detail', label: '情况', type: 'text', maxChars: 200, required: true },
        NOTE,
      ],
    },
  ],
  status: [
    { label: '体重', stream: 'weight', agg: 'latest', unit: 'kg' },
    { label: '体重 7 日均值', stream: 'weight', agg: 'ma7', unit: 'kg' },
    { label: '体重近 4 周趋势', stream: 'weight', agg: 'trend28', unit: 'kg/周' },
    { label: '体脂', stream: 'weight', agg: 'latest', field: 'bodyFat', unit: '%' },
    { label: '本周训练', stream: 'workout', agg: 'week_count', unit: '次' },
    { label: '本周训练时长', stream: 'workout', agg: 'week_sum', unit: '分钟' },
    { label: '近 7 天睡眠', stream: 'sleep', agg: 'avg7', unit: '小时' },
  ],
  protocol: {
    record: [
      '体重 kg 一位小数，注明称量条件（晨起空腹/其他）；体脂注明设备写在备注。',
      '训练记项目、时长、距离或组数、主观强度 1–10；睡眠记时长，能问到就记入睡/起床/质量 1–5。',
      '成员说「昨天」「上周三」时把 at 写成对应日期，不要记成今天。',
    ],
    answer: [
      '体重问题用 7 日均值和近 4 周趋势回答；±1kg 以内的单日差视为波动，不下结论。',
      '训练看周汇总；伤病不做医疗判断，需要就医时明确说。',
    ],
    judge: [
      '先看体重趋势与目标速度（每周 0.5–1% 体重为合理区间），再看训练负荷（周增量不超过约 10%），再看恢复（睡眠、疲劳），最后看坚持度。',
    ],
    remind: ['非计划休息且多日无训练时问一句；7 日均值连续两周偏离目标方向时提出来。'],
    bounds: ['不诊断、不开药、不替代医生。'],
  },
  alerts: [
    {
      id: 'health-no-workout',
      kind: 'no_record_days',
      stream: 'workout',
      days: 4,
      text: '已经 {gap} 天没有训练记录（最近一次 {last}）',
      push: false,
    },
    { id: 'health-goal', kind: 'goal_ratio', ratios: [1], push: true },
  ],
}

const MIND: LifeDomainTemplate = {
  id: 'mind',
  label: '心境与精力',
  scope: '情绪、压力、精力、恢复与触发事件',
  sensitive: true,
  streams: [
    {
      id: 'mood',
      label: '心境',
      primary: 'mood',
      requireAny: ['mood', 'stress', 'energy'],
      fields: [
        { name: 'mood', label: '情绪', type: 'integer', min: 1, max: 10 },
        { name: 'stress', label: '压力', type: 'integer', min: 1, max: 10 },
        { name: 'energy', label: '精力', type: 'integer', min: 1, max: 10 },
        { name: 'trigger', label: '触发事件', type: 'text', maxChars: 200 },
        NOTE,
      ],
    },
  ],
  status: [
    { label: '最近情绪', stream: 'mood', agg: 'latest', unit: '/10' },
    { label: '近 7 天情绪', stream: 'mood', agg: 'avg7', unit: '/10' },
    { label: '近 7 天压力', stream: 'mood', agg: 'avg7', field: 'stress', unit: '/10' },
    { label: '近 7 天精力', stream: 'mood', agg: 'avg7', field: 'energy', unit: '/10' },
  ],
  protocol: {
    record: [
      '情绪、压力、精力各 1–10（10 最好/压力最大/精力最足），加一句触发事件，优先用成员原话。',
      '不强迫打分：成员只说「今天很累」时可以记推断值并标 inferred。',
      '成员回复每晚的心境签到时，把回答记成一条 mind.mood。',
    ],
    answer: [
      '先回应感受，再谈分析，不说教。',
      '谈规律至少用两周数据，对照睡眠、训练、工作负荷；只说「同时出现」，不说因果。',
    ],
    judge: ['看负荷（压力源）与恢复（睡眠、运动、社交）是否平衡；回看过去哪些应对方式有效。'],
    remind: ['连续低分时温和关心一次，不追问；出现自伤等严重信号时，明确建议寻求专业帮助。'],
    bounds: ['不做心理诊断、不贴标签；内容不写进给专家的任务说明，除非成员要求，且只写必要结论。'],
  },
  alerts: [
    {
      id: 'mind-low-run',
      kind: 'low_run',
      stream: 'mood',
      field: 'mood',
      threshold: 4,
      count: 3,
      text: '最近 {count} 次情绪记录都在 {threshold} 分及以下',
      push: true,
    },
  ],
}

const FINANCE_CATEGORIES = [
  '餐饮', '交通', '居住', '日用', '服饰', '医疗健康', '学习', '娱乐', '人情', '数码',
  '旅行', '保险', '税费', '生意经营', '投资', '工资', '经营收入', '其他收入', '其他',
] as const

const CURRENCIES = ['CNY', 'MYR', 'USD', '其他'] as const

const FINANCE: LifeDomainTemplate = {
  id: 'finance',
  label: '财务',
  scope: '收支、预算、固定支出、资产负债（默认币种 CNY，个人与生意同一本账）',
  sensitive: true,
  streams: [
    {
      id: 'tx',
      label: '收支',
      primary: 'amount',
      currencyField: 'currency',
      fields: [
        { name: 'amount', label: '金额', type: 'number', min: 0.01, max: 100_000_000, decimals: 2, required: true },
        { name: 'direction', label: '方向', type: 'enum', values: ['支出', '收入'], required: true },
        { name: 'category', label: '类别', type: 'enum', values: FINANCE_CATEGORIES, required: true },
        { name: 'currency', label: '币种', type: 'enum', values: CURRENCIES, default: 'CNY' },
        { name: 'counterparty', label: '对象', type: 'text', maxChars: 60 },
        NOTE,
      ],
    },
    {
      id: 'balance',
      label: '资产负债快照',
      primary: 'amount',
      key: 'account',
      currencyField: 'currency',
      negateWhen: { field: 'kind', values: ['负债'] },
      fields: [
        { name: 'account', label: '账户名称（不要写账号）', type: 'text', maxChars: 40, required: true },
        { name: 'kind', label: '类型', type: 'enum', values: ['现金', '存款', '投资', '负债', '其他'], required: true },
        { name: 'amount', label: '金额', type: 'number', min: 0, max: 1_000_000_000, decimals: 2, required: true },
        { name: 'currency', label: '币种', type: 'enum', values: CURRENCIES, default: 'CNY' },
        NOTE,
      ],
    },
    {
      id: 'recurring',
      label: '固定支出',
      primary: 'amount',
      key: 'name',
      currencyField: 'currency',
      fields: [
        { name: 'name', label: '名称', type: 'text', maxChars: 40, required: true },
        { name: 'amount', label: '金额', type: 'number', min: 0.01, max: 100_000_000, decimals: 2, required: true },
        { name: 'dayOfMonth', label: '每月扣款日', type: 'integer', min: 1, max: 31, required: true },
        { name: 'category', label: '类别', type: 'enum', values: FINANCE_CATEGORIES, default: '其他' },
        { name: 'currency', label: '币种', type: 'enum', values: CURRENCIES, default: 'CNY' },
        { name: 'status', label: '状态', type: 'enum', values: ['有效', '已停'], default: '有效' },
        NOTE,
      ],
    },
  ],
  status: [
    { label: '本月支出', stream: 'tx', agg: 'month_sum', where: { direction: '支出', currency: 'CNY' }, unit: 'CNY' },
    { label: '本月收入', stream: 'tx', agg: 'month_sum', where: { direction: '收入', currency: 'CNY' }, unit: 'CNY' },
    { label: '资产负债合计', stream: 'balance', agg: 'current_sum', where: { currency: 'CNY' }, unit: 'CNY' },
    { label: '固定支出', stream: 'recurring', agg: 'current_sum', where: { status: '有效', currency: 'CNY' }, unit: 'CNY/月' },
  ],
  protocol: {
    record: [
      '金额精确到分；币种默认 CNY，其他币种照实记，不擅自换算；类别用固定类别。',
      '只记金额、类别、对象，不记卡号、账号、密码。',
      '资产负债按账户名称记最新余额（负债填正数、类型选负债）；固定支出记名称、金额、每月扣款日。',
    ],
    answer: [
      '月度收支、预算余量、类别占比用 query_records 算；跨币种只分别列出，换算要说明汇率口径。',
    ],
    judge: [
      '按顺序看：现金流 → 安全垫（能覆盖几个月支出）→ 负债 → 储蓄目标 → 投资；前一层不稳时，对后一层的风险要明说。',
    ],
    remind: ['预算达到 80% / 100% 时提出来；固定扣款到期前提醒；大额支出建议转入决策日志。'],
    bounds: ['只记账和分析，不碰任何转账或交易；市场研究归 alpha-capital，两边不共享档案。'],
  },
  alerts: [
    { id: 'finance-budget', kind: 'goal_ratio', ratios: [0.8, 1], push: true },
    {
      id: 'finance-recurring',
      kind: 'monthly_day_within',
      stream: 'recurring',
      field: 'dayOfMonth',
      activeWhen: { field: 'status', values: ['有效'] },
      days: 3,
      text: '固定支出「{key}」每月 {value} 号扣款，3 天内到期',
      push: true,
    },
  ],
}

const CAREER: LifeDomainTemplate = {
  id: 'career',
  label: '事业',
  scope: '生意经营、项目组合、承诺与截止（下一步做什么在任务本里）',
  sensitive: false,
  streams: [
    {
      id: 'project',
      label: '项目',
      key: 'name',
      fields: [
        { name: 'name', label: '项目名', type: 'text', maxChars: 40, required: true },
        { name: 'status', label: '状态', type: 'enum', values: ['进行', '搁置', '完成', '放弃'], required: true },
        { name: 'priority', label: '优先级', type: 'enum', values: ['高', '中', '低'], default: '中' },
        {
          name: 'resumeWhen',
          label: '恢复条件',
          type: 'text',
          maxChars: 160,
          requiredWhen: { field: 'status', equals: '搁置' },
        },
        { name: 'why', label: '为什么做', type: 'text', maxChars: 160 },
        { name: 'next', label: '下一步', type: 'text', maxChars: 120 },
        NOTE,
      ],
    },
    {
      id: 'commitment',
      label: '承诺',
      key: 'what',
      fields: [
        { name: 'what', label: '承诺内容', type: 'text', maxChars: 120, required: true },
        { name: 'to', label: '对象', type: 'text', maxChars: 40 },
        { name: 'due', label: '截止', type: 'date' },
        { name: 'status', label: '状态', type: 'enum', values: ['待办', '完成', '取消'], default: '待办' },
        NOTE,
      ],
    },
  ],
  status: [
    { label: '项目', stream: 'project', agg: 'current_by', field: 'status' },
    { label: '承诺', stream: 'commitment', agg: 'current_by', field: 'status' },
  ],
  protocol: {
    record: [
      '项目一条一个名字，状态变化就记一条新状态；搁置必须写恢复条件。',
      '承诺带对象和截止日；关键决定转入决策日志；具体执行步骤放任务本，这里只记组合与优先级。',
    ],
    answer: [
      '「最近在忙什么」结合任务本与本档案；排优先级按影响 × 紧迫 × 是否有人在等。',
    ],
    judge: ['看精力分配是否和优先级一致；搁置项的恢复条件是否已满足；承诺是否超载。'],
    remind: ['截止前提醒；搁置项满足恢复条件时提出来；承诺逾期时说明。'],
    bounds: ['不替成员对外承诺或发送任何消息；对外动作照常走审批。'],
  },
  alerts: [
    {
      id: 'career-due',
      kind: 'due_within',
      stream: 'commitment',
      field: 'due',
      activeWhen: { field: 'status', values: ['待办'] },
      days: 2,
      text: '承诺「{key}」截止 {value}',
      push: true,
    },
  ],
}

const DECISIONS: LifeDomainTemplate = {
  id: 'decisions',
  label: '决策日志',
  scope: '重要决定的选项、理由、预期与复盘',
  sensitive: false,
  streams: [
    {
      id: 'decision',
      label: '决定',
      key: 'question',
      fields: [
        { name: 'question', label: '问题', type: 'text', maxChars: 120, required: true },
        { name: 'status', label: '状态', type: 'enum', values: ['考虑中', '已决定', '已复盘', '放弃'], required: true },
        { name: 'options', label: '选项与代价', type: 'text', maxChars: 600, required: true },
        { name: 'choice', label: '选择', type: 'text', maxChars: 160, requiredWhen: { field: 'status', equals: '已决定' } },
        { name: 'rationale', label: '理由', type: 'text', maxChars: 400 },
        { name: 'expected', label: '预期结果', type: 'text', maxChars: 200 },
        { name: 'reviewOn', label: '复盘日期', type: 'date' },
        { name: 'outcome', label: '实际结果', type: 'text', maxChars: 400, requiredWhen: { field: 'status', equals: '已复盘' } },
        NOTE,
      ],
    },
  ],
  status: [{ label: '决定', stream: 'decision', agg: 'current_by', field: 'status' }],
  protocol: {
    record: [
      '选项至少两个（含「不做」），每个写代价、可逆性、最坏情况；成员选定后记选择、理由、预期和复盘日期。',
      '复盘时对照预期写实际结果，把结论作为洞察写进相关档案。',
    ],
    answer: ['成员说「我在考虑…」「要不要…」且金额或影响较大时，先走这个模板，只问最关键的一个问题，不当场拍板。'],
    judge: ['重点看可逆性与最坏情况：可逆的小事快定，不可逆的大事慢想。'],
    remind: ['复盘日期临近时提醒成员回看。'],
    bounds: ['决定权在成员；阿同给选项与代价，不替成员拍板。'],
  },
  alerts: [
    {
      id: 'decisions-review',
      kind: 'due_within',
      stream: 'decision',
      field: 'reviewOn',
      activeWhen: { field: 'status', values: ['已决定'] },
      days: 0,
      text: '决定「{key}」到了复盘日期 {value}',
      push: true,
    },
  ],
}

/** 首批五本(2026-10-20 用户拍板)。顺序即驾驶舱卡的顺序。 */
export const LIFE_DOMAIN_TEMPLATES: readonly LifeDomainTemplate[] = [HEALTH, MIND, FINANCE, CAREER, DECISIONS]

export function findLifeDomain(id: string): LifeDomainTemplate | undefined {
  return LIFE_DOMAIN_TEMPLATES.find((d) => d.id === id)
}

/** `health.weight` → 模板与流水;找不到返回 undefined。 */
export function findLifeStream(ref: string): { domain: LifeDomainTemplate; stream: LifeStreamSpec } | undefined {
  const dot = ref.indexOf('.')
  if (dot <= 0) return undefined
  const domain = findLifeDomain(ref.slice(0, dot))
  const stream = domain?.streams.find((s) => s.id === ref.slice(dot + 1))
  return domain && stream ? { domain, stream } : undefined
}

/** 全部流水引用(`health.weight` …),给工具描述与报错列举用。 */
export function allLifeStreamRefs(): string[] {
  return LIFE_DOMAIN_TEMPLATES.flatMap((d) => d.streams.map((s) => `${d.id}.${s.id}`))
}
