# Gotong 真壳(SHELL track)

Capacitor 工程:把 SDUI 渲染器三件套装进设备本地,经 **CapacitorHttp**(fetch 在原生层执行,无浏览器 Origin,CORS 问题域消失)直连成员自己的 hub。设计全文见 [`docs/zh/APP-SHELL.md`](../docs/zh/APP-SHELL.md)。

**刻意不在 pnpm workspace 里**:不是可发布包,version-gate / publish-readiness-gate 只枚举 `packages/*`,壳的 Capacitor 依赖也不该混进内核依赖图。

## 目录

| 路径 | 是什么 |
|---|---|
| `web/` | 壳自己的三件:配对屏 + `GotongPanel.mount()` 自举 + 壳皮 |
| `scripts/export-webdir.mjs` | 现装 `www/`(渲染器三件从 `packages/web/static` 原样拷贝 + 壳三件),兼防腐门:SPA 文件不许进壳、页面不得含内联 `<script>`、脚本顺序钉死 |
| `www/` | 导出产物,**永不手改、永不提交** |
| `ios/` | `cap add ios` 脚手架(已注册 `gotong://` scheme、PNG 图标集);`Pods/` 不提交 |

## 构建

```bash
cd shell
pnpm --ignore-workspace install
pnpm run sync           # = export（重装 www/）+ cap sync ios
npx cap open ios        # Xcode 里跑,或:
xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

依赖走 Swift Package Manager(Capacitor 8 起,无 CocoaPods):首次构建会从 GitHub 解析 `capacitor-swift-pm`,`@capacitor/app` 直接引用 `node_modules` 本地路径 —— 所以 `pnpm install` 必须先于首次构建。Capacitor CLI 要 Node ≥22(`nvm use 22`);仓库其余部分仍用 v20。

改了 `packages/web/static/`(渲染器)或 `shell/web/`(壳页)之后,重跑 `pnpm run sync` 再构建。

## 配对

1. 网页端「我的 → 设备」生成配对码(80-bit 一次性码,10 分钟有效);
2. 壳里扫二维码(`gotong://pair?u=…&c=…` 深链预填)或手动填地址+码;
3. 壳 `POST /api/devices/claim` 换 `aipk_` 设备凭证,交给 `GotongHub.setTarget()` 唯一咽喉,此后所有 `/api/*` 请求自动重写到目标 hub 并带 Bearer。

断开 = 本机忘记;真正撤销凭证在网页端「我的 → 设备」。明文 `http://` 只允许回环地址(本机调试);生产 hub 需要域名 + TLS(M7 前置条件,模板见 `deploy/Caddyfile.baremetal`)。

## 边界(APP-SHELL §五)

壳是第 N 个渲染器,不是新权威点 —— 装 app 不多一分权限;Android 工程待有构建环境再 `npx cap add android`(脚手架而不能验证 = 写完就腐)。
