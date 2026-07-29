/* hub-target.js — SHELL-M2. 这个客户端跟哪台 hub 说话：唯一的一处咽喉。
 *
 * # 为什么要有这个文件
 *
 * 到 M1 为止，SPA 结构性绑死同源：227 处硬编码 `fetch('/api/…')` 加一个
 * `new EventSource('/api/stream')`，散在 25 个手写文件里，没有任何一处能回答
 * 「连哪台 hub」。真壳（SHELL-M0 拍板的形态）把这些 JS 装进设备本地，页面自己
 * 的 origin 变成 `capacitor://` 之类的东西，那 227 个相对路径就全指向壳内部，
 * 一个都打不到 hub。
 *
 * 收编的办法不是去改那 227 处 —— 改得完，但下一个人写第 228 处时又漏了。这里
 * 补的是**一层**：给 `window.fetch` 打一个全局补丁，把根相对的 `/api/*` 重写到
 * 目标 hub 上。227 个调用点一个字都不用动，而且**新写的调用点自动就是对的**。
 * SHELL-M0 边界②要的「一处咽喉」，只有这个形状能结构性地做到。
 *
 * # 三条不变量
 *
 *   1. **没配 = 逐字节今天**（边界④）。目标为空时补丁把原样的两个参数交回原生
 *      fetch，连 init 对象都不重新包一层。浏览器里正常登录使用的路径，从这个
 *      文件存在前后不产生任何差别。
 *   2. **只重写 hub 的 API 面**。`/api/` 才走 hub；`/styles.css`、
 *      `/builtin-bundles/*.yaml`、动态插的 `<script src>` 全是壳内本地资源，
 *      重写它们只会把本来就在本地的东西打到网上去。绝对 URL 一律不碰 —— 这也
 *      是设备凭证不可能被送去第三方的结构性原因。
 *   3. **不是旋钮**（边界⑤，116 冻结）。「连哪台 hub」是设备上的客户端状态，
 *      由成员扫码配对写进来，不是 hub 的环境变量。
 *
 * # 凭证为什么也在这
 *
 * 同源时 SPA 靠 cookie，一个 Authorization 头都不发。跨源时 cookie 不会跟车，
 * 必须换成 M1 配对拿到的 `aipk_` Bearer。把「用哪个凭证」拆到别处去，就等于承认
 * 有第二处地方也在回答「怎么跟 hub 说话」—— 那正是边界②禁止的。所以一处咽喉
 * 同时决定地址和凭证。
 *
 * 加载顺序：必须排在 app-core.js 之前（它的 connectStream 要用 hubUrl）。
 */
;(function () {
  'use strict'

  // 一个键，不是四个：地址和凭证要么一起有要么一起没有，分开存就会出现
  // 「有 key 没地址」这种半态。清除也只需要清一个。
  var STORE_KEY = 'gotong_hub_target'

  /** 回环判定 —— 明文 http 只在这些主机上放行，见 normalizeHubBase。 */
  function isLoopbackHost(hostname) {
    if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
    if (hostname.length > 10 && hostname.slice(-10) === '.localhost') return true
    // 127.0.0.0/8 整段，不只是 127.0.0.1
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  }

  /**
   * 把成员扫到的地址收成一个干净的 origin，收不成就返回 ''（= 视同没配）。
   *
   * 明文 http 只许回环，跟 `gotong model` 拒绝非回环明文端点是同一姿态：这里要
   * 长期驮着一把设备 Bearer 走，明文局域网 http 会把它一路裸奔出去。M7 的前置
   * 条件本来就是 VPS 上域名 + TLS，所以这条限制不是新增摩擦，是把既定计划提前
   * 在代码里说出来。
   */
  function normalizeHubBase(raw) {
    if (typeof raw !== 'string' || !raw) return ''
    var u
    try {
      u = new URL(raw)
    } catch (_) {
      return ''
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return ''
    // URL 里带用户名密码的形式一律不收 —— 那是另一种凭证通道，这里不认。
    if (u.username || u.password) return ''
    if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) return ''
    // .origin 顺手把 path/query/fragment 削掉、默认端口归一。存进去的东西
    // 因此永远是可以直接拼路径的形状。
    return u.origin
  }

  /** 读一次进内存：补丁在每个请求上跑，不能每次都去敲 localStorage。 */
  function load() {
    var raw
    try {
      raw = localStorage.getItem(STORE_KEY)
    } catch (_) {
      return null // 隐私模式/禁用存储 → 当作没配，同源照常工作
    }
    if (!raw) return null
    var parsed
    try {
      parsed = JSON.parse(raw)
    } catch (_) {
      return null
    }
    // 存进去时校验过，读出来再校验一次：盘上的东西可能是手改的，也可能是旧版本
    // 写的。校验不过就当没配，而不是半信半疑地用。
    var base = normalizeHubBase(parsed && parsed.base)
    if (!base) return null
    return {
      base: base,
      key: typeof parsed.key === 'string' && parsed.key ? parsed.key : '',
      userId: typeof parsed.userId === 'string' ? parsed.userId : '',
      expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0,
    }
  }

  var target = load()

  /**
   * 唯一的重写规则。两个消费者：下面的 fetch 补丁，和 app-core.js 的
   * EventSource（fetch 补丁盖不到它，所以它必须显式调这里）。
   */
  function hubUrl(path) {
    if (!target || typeof path !== 'string') return path
    if (path.slice(0, 5) !== '/api/') return path
    return target.base + path
  }

  /**
   * 写入口 —— M5 的配对领取流程调它。地址不合法就抛，不是静默忽略：配对当场
   * 失败要让成员看见，比事后「怎么连不上」好排查得多。
   */
  function setTarget(input) {
    var base = normalizeHubBase(input && input.base)
    if (!base) throw new Error('hub address not accepted: ' + String(input && input.base))
    var next = {
      base: base,
      key: typeof input.key === 'string' ? input.key : '',
      userId: typeof input.userId === 'string' ? input.userId : '',
      expiresAt: typeof input.expiresAt === 'number' ? input.expiresAt : 0,
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(next))
    target = next
    return next
  }

  function clearTarget() {
    try {
      localStorage.removeItem(STORE_KEY)
    } catch (_) {}
    target = null
  }

  // --- 全局 fetch 补丁 -----------------------------------------------------
  //
  // 与 CapacitorHttp 的 fetch 补丁可以任意先后顺序共存：我们只改 URL 和头，然后
  // 把活交给当时的 fetch；它拿到的是一个绝对 URL，正常走原生库。
  var nativeFetch = window.fetch
  window.fetch = function (input, init) {
    // 没配目标 → 原样两个参数交回去。这就是「逐字节今天」的字面实现。
    if (!target) return nativeFetch.call(this, input, init)
    // 只处理字符串/URL 形式。全仓 227 个调用点都是字符串；Request 对象一旦出现
    // 其相对 URL 早已按页面 origin 解析完，这里再改也晚了，所以如实放行不装作
    // 处理了。真要有那种调用点，得改成传字符串。
    var path = typeof input === 'string' ? input : input instanceof URL ? input.href : null
    if (path === null) return nativeFetch.call(this, input, init)
    var url = hubUrl(path)
    if (url === path) return nativeFetch.call(this, input, init)

    var next = {}
    if (init) for (var k in init) next[k] = init[k]
    // 跨源时 cookie 本来也不该跟车。显式 omit 是为了不触发浏览器的凭据模式
    // （那会要求对端回 Access-Control-Allow-Credentials），也为了让「凭证只有
    // Bearer 这一条」成为读代码就能看出来的事实。
    next.credentials = 'omit'
    var headers = new Headers((init && init.headers) || undefined)
    // 调用点自己带了 Authorization 就尊重它 —— 补丁是兜底，不是覆盖。
    if (target.key && !headers.has('authorization')) {
      headers.set('authorization', 'Bearer ' + target.key)
    }
    next.headers = headers
    return nativeFetch.call(this, url, next)
  }

  window.GotongHub = {
    /** 当前目标 hub 的 origin，'' = 同源（今天）。 */
    base: function () {
      return target ? target.base : ''
    },
    /** 配对时记下的成员 id，''=未配。壳里用来显示「以谁的身份连着」。 */
    userId: function () {
      return target ? target.userId : ''
    },
    /** 设备凭证到期时间戳，0=未配。到期后 hub 会 401，壳据此提示重新配对。 */
    expiresAt: function () {
      return target ? target.expiresAt : 0
    },
    hubUrl: hubUrl,
    setTarget: setTarget,
    clearTarget: clearTarget,
    // 导出供单测直接驱动的纯函数。
    normalizeHubBase: normalizeHubBase,
  }
})()
