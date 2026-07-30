import type { CapacitorConfig } from '@capacitor/cli'

// SHELL-M5 —— 真壳的全部配置就这几行,两条是承重的:
//
//  - webDir 'www':由 scripts/export-webdir.mjs 现装,不是手维护的目录。渲染器
//    三件(hub-target.js / sdui-ui.js / sdui-ui.css)从 packages/web/static 原样
//    拷贝 —— 壳是第 N 个渲染器,不是第二份实现。
//
//  - CapacitorHttp enabled:window.fetch 被挪到原生层执行,请求不带浏览器
//    Origin,hub 的 checkOrigin 对无 Origin 请求直接放行,CORS 这个问题域整个
//    消失 —— 这就是「真壳」相对「瘦壳」的技术根据(docs/zh/APP-SHELL.md §二)。
//    它与 hub-target.js 的 fetch 补丁任意先后顺序可共存:hub-target 只改 URL
//    和头,然后把活交给当时的 fetch。
const config: CapacitorConfig = {
  appId: 'app.gotong.shell',
  appName: 'Gotong',
  webDir: 'www',
  plugins: {
    CapacitorHttp: { enabled: true },
    // SHELL-M6 —— 前台收到推送也显示横幅:tap 是低信息的(正文永不上通知),
    // 前台压掉横幅只会让「测试推送没反应」多一种解释,不省任何隐私。
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
}

export default config
