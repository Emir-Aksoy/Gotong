/* SHELL-M5 —— 壳自己的自举。
 *
 * 只做三件事:配对(公开 POST /api/devices/claim 用一次性码换 aipk_ 设备凭证)、
 * 把结果交给 hub-target 的唯一咽喉(GotongHub.setTarget —— 「连哪台 hub」全客户端
 * 只有那一个地方决定,壳不另记一份)、然后 GotongPanel.mount() 挂面板 —— 与 SPA
 * 自举、sdui-standalone 走同一个公开 API,没有侧门。
 *
 * 独立文件而非内联 <script>:壳页 CSP 与 hub 同姿态(script-src 'self'),内联块
 * 无声不跑,export 门对此有断言(M4 排错记①的结构性防复发)。
 *
 * 在纯浏览器里跨源打开时 claim 会被 CORS 拦住 —— 这不是 bug,是真壳存在的理由:
 * CapacitorHttp 把 fetch 挪到原生层执行,请求不带 Origin,问题域整个消失。浏览器
 * 里能验的只有回环/同源形态,跨源的真相属于模拟器与真机。
 */
;(function () {
  'use strict'

  var LANG_KEY = 'gotong-shell-lang'

  var STR = {
    zh: {
      lead: '连接你自己的 hub:在网页端「我的 → 设备」里生成配对码,扫二维码或把地址和码填进下面两格。',
      addrLabel: 'Hub 地址',
      codeLabel: '配对码',
      connect: '连接',
      connecting: '正在连接…',
      disconnect: '断开',
      confirmDisconnect: '断开后本机不再保存这台 hub 的地址与凭证。继续?',
      disconnectHint: '已在本机断开。要让这台设备的凭证真正失效,请到网页端「我的 → 设备」里移除它。',
      expired: '设备凭证已到期 —— 重新配对即可;hub 侧的旧凭证会显示「已过期」。',
      errAddr: '地址没被接受:要 https://…(只有本机调试才允许 http://localhost 一类回环地址)。',
      errClaim: '配对失败:码不对、已用过或已过期。回网页端重新生成一个。',
      errRate: '试得太频繁,稍等一分钟再来。',
      errNet: '连不上这个地址:检查网络与端口;若是在浏览器里打开本页,跨源请求只有装进壳 app 才通。',
      noHome: '壳里没有主页页签。',
      connectedPrefix: '已连接',
    },
    en: {
      lead: 'Connect your own hub: generate a pairing code under "Me → Devices" on the web, scan the QR or type both fields below.',
      addrLabel: 'Hub address',
      codeLabel: 'Pairing code',
      connect: 'Connect',
      connecting: 'Connecting…',
      disconnect: 'Disconnect',
      confirmDisconnect: 'This device will forget the hub address and credential. Continue?',
      disconnectHint: 'Disconnected locally. To actually revoke this device, remove it under "Me → Devices" on the web.',
      expired: 'Device credential expired — just pair again; the old one shows as "expired" on the hub.',
      errAddr: 'Address not accepted: use https://… (plain http only for loopback like http://localhost).',
      errClaim: 'Pairing failed: wrong, used or expired code. Generate a fresh one on the web.',
      errRate: 'Too many attempts — wait a minute and retry.',
      errNet: 'Cannot reach that address: check network and port; cross-origin only works inside the shell app, not a plain browser tab.',
      noHome: 'No home tab in the shell.',
      connectedPrefix: 'Connected',
    },
  }

  var lang = (function () {
    try {
      return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'zh'
    } catch (_) {
      return 'zh'
    }
  })()

  function t(key) {
    return (STR[lang] && STR[lang][key]) || STR.zh[key] || key
  }
  function $(id) {
    return document.getElementById(id)
  }

  var handle = null
  var noteTimer = null

  function renderStrings() {
    document.documentElement.lang = lang
    var nodes = document.querySelectorAll('[data-s]')
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = t(nodes[i].getAttribute('data-s'))
    $('lang-btn').textContent = lang === 'zh' ? 'EN' : '中文'
    var target = window.GotongHub
    if (target.base()) {
      $('conn-info').textContent =
        t('connectedPrefix') + ' · ' + target.base() + (target.userId() ? ' · ' + target.userId() : '')
    }
  }

  function note(text) {
    var el = $('panel-note')
    el.textContent = text
    el.hidden = false
    if (noteTimer) clearTimeout(noteTimer)
    noteTimer = setTimeout(function () {
      el.hidden = true
    }, 5000)
  }

  function showPair(msg) {
    $('screen-panel').hidden = true
    $('screen-pair').hidden = false
    $('pair-err').textContent = msg || ''
  }

  function showPanel() {
    $('screen-pair').hidden = true
    $('screen-panel').hidden = false
    renderStrings()
    if (!handle) {
      handle = window.GotongPanel.mount({
        host: $('shell-host'),
        lang: function () {
          return lang
        },
        gotoHome: function () {
          note(t('noHome'))
        },
        storageKey: 'gotong-shell-ack',
      })
    } else {
      handle.render()
    }
  }

  // --- 配对 ---------------------------------------------------------------

  /** 裸主机的便利层:补 scheme 逐个试,判官始终只有 normalizeHubBase 一个 ——
   * http:// 候选只有回环主机能通过它,便利层不会放宽任何规矩。 */
  function normalizeAddr(raw) {
    var s = String(raw || '').trim()
    if (!s) return ''
    var candidates = /:\/\//.test(s) ? [s] : ['https://' + s, 'http://' + s]
    for (var i = 0; i < candidates.length; i++) {
      var base = window.GotongHub.normalizeHubBase(candidates[i])
      if (base) return base
    }
    return ''
  }

  /** 展示形态是 ABCD-EFGH-JKMN-PQRS;剥掉分组符,大小写不敏感。 */
  function normalizeCode(raw) {
    return String(raw || '')
      .toUpperCase()
      .replace(/[^0-9A-Z]/g, '')
  }

  function deviceLabel() {
    var platform = 'web'
    try {
      if (window.Capacitor && typeof window.Capacitor.getPlatform === 'function') {
        platform = window.Capacitor.getPlatform()
      }
    } catch (_) {}
    return 'Gotong 壳 (' + platform + ')'
  }

  function doPair() {
    var base = normalizeAddr($('pair-addr').value)
    if (!base) {
      showPair(t('errAddr'))
      return
    }
    var code = normalizeCode($('pair-code').value)
    if (!code) {
      showPair(t('errClaim'))
      return
    }
    var btn = $('pair-btn')
    btn.disabled = true
    btn.textContent = t('connecting')
    // 绝对 URL + 显式 omit:此刻还没有目标,不走 hub-target 重写;码是这次请求
    // 唯一的凭证,这正是 claim 路由的设计(挂在 CSRF 门之前、无会话)。
    fetch(base + '/api/devices/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify({ code: code, deviceLabel: deviceLabel() }),
    })
      .then(function (res) {
        if (res.status === 429) throw { kind: 'rate' }
        if (!res.ok) throw { kind: 'claim' }
        return res.json()
      })
      .then(function (data) {
        // 唯一的写入口。setTarget 对坏地址抛错 —— 当场可见,不静默。
        window.GotongHub.setTarget({
          base: base,
          key: data.key,
          userId: data.userId,
          expiresAt: data.expiresAt,
        })
        $('pair-code').value = ''
        showPanel()
      })
      .catch(function (err) {
        var msg = err && err.kind === 'rate' ? t('errRate') : err && err.kind === 'claim' ? t('errClaim') : t('errNet')
        showPair(msg)
      })
      .then(function () {
        btn.disabled = false
        btn.textContent = t('connect')
      })
  }

  // --- 深链:gotong://pair?u=<origin>&c=<code>(device-routes pairingPayload) ---

  function applyPairUrl(raw) {
    var url
    try {
      url = new URL(raw)
    } catch (_) {
      return
    }
    if (url.protocol !== 'gotong:') return
    // 自定义 scheme 下 host/pathname 的落点浏览器间有差,两处都认。
    if (url.host !== 'pair' && url.pathname.replace(/^\/+/, '') !== 'pair') return
    var u = url.searchParams.get('u')
    var c = url.searchParams.get('c')
    if (u) $('pair-addr').value = u
    if (c) $('pair-code').value = c
    // 深链只预填,不自动提交:连接是把设备凭证交出去的动作,按钮留给人按。
    showPair('')
  }

  function wireDeepLink() {
    var cap = window.Capacitor
    if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return
    var app = cap.Plugins && cap.Plugins.App
    if (!app) return
    try {
      app.addListener('appUrlOpen', function (ev) {
        if (ev && ev.url) applyPairUrl(ev.url)
      })
      // 冷启动:app 是被深链拉起来的,事件早于监听器,补一次查询。
      if (typeof app.getLaunchUrl === 'function') {
        app.getLaunchUrl()
          .then(function (r) {
            if (r && r.url) applyPairUrl(r.url)
          })
          .catch(function () {})
      }
    } catch (_) {}
  }

  // --- 断开 ---------------------------------------------------------------

  function doDisconnect() {
    if (!window.confirm(t('confirmDisconnect'))) return
    // 只忘本机。撤销凭证是 hub 侧「我的 → 设备」的事 —— 壳拿不到自己的
    // credentialId(claim 刻意不返回它),而且「设备丢了去网页端踢它」这条
    // 路本来就必须独立于设备本身存在。
    window.GotongHub.clearTarget()
    showPair(t('disconnectHint'))
  }

  // --- boot ---------------------------------------------------------------

  $('pair-btn').addEventListener('click', doPair)
  $('pair-code').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') doPair()
  })
  $('disconnect-btn').addEventListener('click', doDisconnect)
  $('lang-btn').addEventListener('click', function () {
    lang = lang === 'zh' ? 'en' : 'zh'
    try {
      localStorage.setItem(LANG_KEY, lang)
    } catch (_) {}
    renderStrings()
    if (handle && !$('screen-panel').hidden) handle.render()
  })

  wireDeepLink()
  renderStrings()

  var expiresAt = window.GotongHub.expiresAt()
  if (window.GotongHub.base() && expiresAt && expiresAt <= Date.now()) {
    // 到期就直说,别让成员盯着一屏 401 猜。旧目标先留着(地址可预填),真正的
    // 清写发生在下一次成功 setTarget 覆盖时。
    $('pair-addr').value = window.GotongHub.base()
    showPair(t('expired'))
  } else if (window.GotongHub.base()) {
    showPanel()
  } else {
    showPair('')
  }
})()
