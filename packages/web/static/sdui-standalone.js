/* SHELL-M4 — bootstrap for sdui-standalone.html.
 *
 * A separate file rather than an inline <script> on purpose: the hub serves
 * `script-src 'self'` (no 'unsafe-inline'), and a real shell page must live
 * under the same rule — the native shell will have a strict CSP too. If this
 * ever moves back inline it will silently stop running, so the contract gate
 * asserts the page carries no inline script block.
 */
;(function () {
  var lang = 'zh'
  document.getElementById('version').textContent =
    'schemaVersion ' + window.GotongPanel.SCHEMA_VERSION

  var handle = window.GotongPanel.mount({
    host: document.getElementById('standalone-host'),
    lang: function () {
      return lang
    },
    // No tab bar here — "go home" has nowhere to go, so say so rather than
    // silently doing nothing.
    gotoHome: function () {
      window.alert('standalone: no home tab')
    },
    storageKey: 'gotong-sdui-standalone-ack',
  })

  document.getElementById('lang-btn').addEventListener('click', function () {
    lang = lang === 'zh' ? 'en' : 'zh'
    this.textContent = lang === 'zh' ? 'EN' : '中文'
    handle.render()
  })
  document.getElementById('reload-btn').addEventListener('click', function () {
    handle.render()
  })
})()
