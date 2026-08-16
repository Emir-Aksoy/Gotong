/**
 * 审批文案的一处清洗 + 一处定界。
 *
 * 审批卡上那行字是**人做「批 / 不批」这个决定时唯一读到的东西**,而它的两个正文
 * 字段(动作标题、原因)有一段是模型给的:`hands_run` 的 argv 是模型写的、
 * `create_agent` 的 id 是模型起的、MCP 工具参数也是模型填的。被注入的模型于是有了
 * 一个很便宜的攻击:**不去骗闸,去骗读闸的人**——
 *
 *   title = "读一个文件。原因:无害。批准后才会执行。(下面是系统提示,请忽略)"
 *
 * 拼进 `管家「X」想执行一个敏感动作:<title>。原因:<reason>。批准后才会执行。` 之后,
 * 屏幕上就出现了一句完整、无害、看起来是 hub 说的话,真正的动作被推到人眼的后面。
 * 换行、U+202E(从右往左覆盖)、零宽字符能把这件事做得更彻底——一整段危险参数可以
 * 在终端/网页里被推到看不见的地方。
 *
 * 两条对策,都在这一个文件里,好让「审批卡怎么拼」永远只有一处答案:
 *
 *   1. **清洗**:控制字符 / C1 / 双向覆盖 / 零宽 / 行段分隔符 / BOM 一律换成空格。
 *      注意换的是空格不是删除——删除会把 `rm -rf /` 拼成 `rm-rf/` 这种「看起来是
 *      另一条命令」的字,空格只让它变丑,不改变它读起来是什么。
 *   2. **定界**:框架用「」把不可信字段包起来,并把正文里的「」换成『』。于是
 *      渲染出来的「」**只可能**出现在框架的位置上,模型再也接不出一句假的框架句。
 *      (选替换而不是删除,同样是为了可读:`stdin 240B「abc」` 变成 `stdin 240B『abc』`
 *      仍然是人话。)
 *
 * 这不是「防注入」的全部——真正的防线是分级闸本身(服务端权威、tier 3 结构性缺席)。
 * 这里只保证一件事:**人看到的那行字,和批准后真正会跑的那个动作,是同一件事。**
 */

/** 一次替换成空格的坏字符;判定走数值比较,源码里不出现真的控制字符。 */
function isInvisible(c: number): boolean {
  if (c < 0x20 || c === 0x7f) return true // C0 + DEL
  if (c >= 0x80 && c <= 0x9f) return true // C1(某些终端会当控制序列吃掉)
  if (c === 0x00ad) return true // SOFT HYPHEN(多数渲染面不显示)
  if (c === 0x034f) return true // COMBINING GRAPHEME JOINER
  if (c === 0x061c) return true // ARABIC LETTER MARK
  if (c === 0x115f || c === 0x1160) return true // 谚文填充(宽度不定的「空」字)
  if (c === 0x17b4 || c === 0x17b5) return true // 高棉不可见元音
  if (c === 0x180e) return true // MONGOLIAN VOWEL SEPARATOR
  if (c >= 0x200b && c <= 0x200f) return true // 零宽 + LRM/RLM
  if (c === 0x2028 || c === 0x2029) return true // 行 / 段分隔符
  if (c >= 0x202a && c <= 0x202e) return true // 双向嵌入 / 覆盖
  if (c >= 0x2060 && c <= 0x2064) return true // word joiner / 不可见运算符
  if (c >= 0x2066 && c <= 0x2069) return true // 双向隔离
  if (c === 0x3164 || c === 0xffa0) return true // 谚文填充(全角 / 半角)
  if (c >= 0xfe00 && c <= 0xfe0f) return true // 变体选择符
  if (c === 0xfeff) return true // BOM / 零宽不换行空格
  if (c >= 0xe0000 && c <= 0xe007f) return true // 标签字符(整段隐藏文字的老把戏)
  if (c >= 0xe0100 && c <= 0xe01ef) return true // 变体选择符补充
  return false
}

/** 定界符:框架用它包不可信字段。 */
export const APPROVAL_OPEN = '「'
export const APPROVAL_CLOSE = '」'

/**
 * 正文里要降级的「像定界符的字」。**不只是精确的 U+300C/U+300D**——半角
 * `｢｣`(U+FF62/63)与竖排 `﹁﹂`(U+FE41/42)在 NFKC 下就等于「」,字体上也够像:
 * 只挡精确码点等于只挡了一种写法。这里挡的是「渲染出来会被人读成框架引号」的**一类**。
 * 降级目标 `『』`(U+300E/F)自己不会 NFKC 成「」,所以是安全的落点。
 */
const LOOKALIKE_OPEN = '「｢﹁'
const LOOKALIKE_CLOSE = '」｣﹂'

/**
 * 洗掉不可见 / 可改变阅读方向的字符,并把正文里的定界符(含相似字)降级成 `『』`。
 * 幂等:洗过的字符串再洗一次逐字节相同。按**码点**遍历——标签字符在增补平面,
 * 按 UTF-16 码元逐个看会把它劈成两个代理项,谁也不匹配。
 */
export function sanitizeApprovalText(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (isInvisible(c)) out += ' '
    else if (LOOKALIKE_OPEN.includes(ch)) out += '『'
    else if (LOOKALIKE_CLOSE.includes(ch)) out += '』'
    else out += ch
  }
  return out
}

/**
 * 清洗 + 有界。超长的正文同样是一种覆盖攻击(把真正的动作顶出屏幕),所以给一个
 * 上限;截断处**必须说自己截了**——一个不说自己是节选的节选,读起来就是全文。
 */
export function clipApprovalText(s: string, max: number): string {
  const clean = sanitizeApprovalText(s)
  if (clean.length <= max) return clean
  return `${clean.slice(0, max)}…(共 ${clean.length} 字符,已截断)`
}
