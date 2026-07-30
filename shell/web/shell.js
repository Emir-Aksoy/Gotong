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
      notifyOn: '开启通知',
      notifyOff: '关闭',
      notifyStateOff: '有新消息时提醒这台设备',
      notifyStateOn: '通知已开启',
      notifyDenied: '系统未授权通知 —— 到 iOS 设置里为 Gotong 打开后再试。',
      notifyErrHub: '这台 hub 未启用原生推送(服务端没配 apns.json)。',
      notifyErrReg: '开启失败,稍后再试。',
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
      notifyOn: 'Enable notifications',
      notifyOff: 'Disable',
      notifyStateOff: 'Alert this device on new messages',
      notifyStateOn: 'Notifications on',
      notifyDenied: 'Notifications not authorized — enable Gotong in iOS Settings, then retry.',
      notifyErrHub: 'This hub has no native push (no apns.json on the server).',
      notifyErrReg: 'Could not enable — try again later.',
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
    renderNotify()
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

  // --- 通知(SHELL-M6/M6A) -------------------------------------------------
  //
  // 纪律三条:①绝不在启动时自动弹权限 —— 「开启」是成员按按钮的动作;②通知
  // 永远是低信息 tap(正文在 hub 侧结构性上不了推送),收到只代表「有新消息」;
  // ③断开前先尽力把 token 从 hub 删掉 —— 设备凭证按 userId 存 token,不删的话
  // 要等 Apple/Google 答「token 已死」才会被 hub 剪掉。
  // 同一份代码跑 iOS(APNs)与 Android(FCM):平台自报 Capacitor.getPlatform(),
  // hub 只收自己有腿的平台(native.platforms 守门)。

  var NOTIFY_KEY = 'gotong-shell-notify'
  var NOTIFY_TOKEN_KEY = 'gotong-shell-push-token'

  function pushPlugin() {
    var cap = window.Capacitor
    if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return null
    return (cap.Plugins && cap.Plugins.PushNotifications) || null
  }

  /** 'ios' | 'android' —— pushPlugin() 非空才有意义(web 平台拿不到插件)。 */
  function shellPlatform() {
    var cap = window.Capacitor
    return cap && typeof cap.getPlatform === 'function' ? cap.getPlatform() : 'web'
  }

  function notifyEnabled() {
    try {
      return localStorage.getItem(NOTIFY_KEY) === '1'
    } catch (_) {
      return false
    }
  }

  function setNotify(on, token) {
    try {
      if (on) localStorage.setItem(NOTIFY_KEY, '1')
      else localStorage.removeItem(NOTIFY_KEY)
      if (token) localStorage.setItem(NOTIFY_TOKEN_KEY, token)
      else if (!on) localStorage.removeItem(NOTIFY_TOKEN_KEY)
    } catch (_) {}
  }

  function renderNotify() {
    var row = $('notify-row')
    row.hidden = true
    if (!pushPlugin() || !window.GotongHub.base()) return
    // 行只在 hub 真有本平台的腿时出现:探一次 GET /api/me/push 的 additive
    // native 键。探不到/答 available:false/platforms 不含本平台 ⇒ 行保持隐藏,
    // 不摆按不动的按钮(iOS 壳对 FCM-only hub 不该看到开关,反之亦然)。
    // platforms 键缺席 = M6 时代的旧 hub(只有 APNs 腿),按 ios 兜底判。
    fetch('/api/me/push')
      .then(function (res) {
        return res.ok ? res.json() : null
      })
      .then(function (d) {
        if (!d || !d.native || !d.native.available) return
        var served = Array.isArray(d.native.platforms) ? d.native.platforms : ['ios']
        if (served.indexOf(shellPlatform()) < 0) return
        row.hidden = false
        $('notify-state').textContent = notifyEnabled() ? t('notifyStateOn') : t('notifyStateOff')
        $('notify-btn').textContent = notifyEnabled() ? t('notifyOff') : t('notifyOn')
      })
      .catch(function () {})
  }

  /** registration 事件的唯一出口:把 token 交给 hub。失败即回退开关,不留半态。 */
  function onPushToken(token) {
    fetch('/api/me/push/native/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: token, platform: shellPlatform() }),
    })
      .then(function (res) {
        if (res.status === 503) throw { kind: 'hub' }
        if (!res.ok) throw { kind: 'reg' }
        setNotify(true, token)
        renderNotify()
      })
      .catch(function (err) {
        setNotify(false)
        renderNotify()
        note(err && err.kind === 'hub' ? t('notifyErrHub') : t('notifyErrReg'))
      })
  }

  function wirePush() {
    var push = pushPlugin()
    if (!push) return
    try {
      push.addListener('registration', function (ev) {
        if (ev && ev.value) onPushToken(ev.value)
      })
      push.addListener('registrationError', function () {
        setNotify(false)
        renderNotify()
        note(t('notifyErrReg'))
      })
      // 推送到达/被点开 ⇒ 只刷新面板数据(推送≠授权:除了「去看一眼」什么都不做)。
      var refresh = function () {
        if (handle && !$('screen-panel').hidden) handle.render()
      }
      push.addListener('pushNotificationReceived', refresh)
      push.addListener('pushNotificationActionPerformed', refresh)
      // 已开启过的设备:静默重注册(APNs token 会轮换,权限早已给过不会弹窗)。
      if (notifyEnabled() && window.GotongHub.base()) {
        push.register().catch(function () {})
      }
    } catch (_) {}
  }

  function toggleNotify() {
    var push = pushPlugin()
    if (!push) return
    if (notifyEnabled()) {
      var tok = null
      try {
        tok = localStorage.getItem(NOTIFY_TOKEN_KEY)
      } catch (_) {}
      if (tok) {
        fetch('/api/me/push/native/unregister', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: tok }),
        }).catch(function () {})
      }
      if (typeof push.unregister === 'function') push.unregister().catch(function () {})
      setNotify(false)
      renderNotify()
      return
    }
    push
      .requestPermissions()
      .then(function (r) {
        if (!r || r.receive !== 'granted') {
          note(t('notifyDenied'))
          return
        }
        return push.register()
      })
      .catch(function () {
        note(t('notifyErrReg'))
      })
  }

  // --- 断开 ---------------------------------------------------------------

  function doDisconnect() {
    if (!window.confirm(t('confirmDisconnect'))) return
    // 尽力先把推送 token 从 hub 删掉(fire-and-forget):token 按 userId 存,
    // 光在网页端撤设备凭证停不掉它,要等 Apple/Google 答「token 已死」才自愈。
    var tok = null
    try {
      tok = localStorage.getItem(NOTIFY_TOKEN_KEY)
    } catch (_) {}
    if (tok) {
      fetch('/api/me/push/native/unregister', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: tok }),
      }).catch(function () {})
    }
    setNotify(false)
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
  $('notify-btn').addEventListener('click', toggleNotify)
  $('lang-btn').addEventListener('click', function () {
    lang = lang === 'zh' ? 'en' : 'zh'
    try {
      localStorage.setItem(LANG_KEY, lang)
    } catch (_) {}
    renderStrings()
    if (!$('screen-panel').hidden) {
      renderNotify()
      if (handle) handle.render()
    }
  })

  wireDeepLink()
  wirePush()
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
