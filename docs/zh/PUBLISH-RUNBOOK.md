# 发布 Runbook — npm + PyPI 真发布剧本（PUB-M3）

> 首次真发布与以后每次发版都走这一页。原则：**发布前所有门必须绿**（发布日
> 不做任何"应该没事"的跳过）；**失败回滚 = deprecate，绝不 unpublish**。
>
> 发布物：npm 侧 **36 个包**（35 个 `@gotong/*` + 1 个 unscoped 薄壳 `gotong`，
> 即 `packages/*` 全部——examples/root 是 private，pnpm 自动跳过）；PyPI 侧
> **1 个包**（`gotong`，源在 `python-sdk/`）。
>
> Last updated: 2026-07-06

---

## 〇、一次性前置（用户动作，防抢注，越早越好）

| # | 动作 | 说明 |
|---|---|---|
| 1 | npm 注册/登录账号，开 2FA | 发布时刻需要手机在场输 OTP |
| 2 | npm 建 **org `gotong`**（Add Organization，免费 public org） | `@gotong` scope 归属；不建 org 则 scope 归个人账号，以后迁移麻烦 |
| 3 | PyPI 注册账号 + 开 2FA + 生成 **API token** | 上传用 `__token__` 用户名 + token；token 只放 `~/.pypirc` 或环境变量，**不进仓库** |
| 4 | unscoped 名 `gotong`（npm / PyPI 各一个） | 不用预注册——**首次 publish/upload 即占名**（两边核查过均空） |

npm OTP 说明：36 包逐包发布，2FA 为 auth-and-writes 时会多次提示 OTP（同一
OTP 在有效窗口内可连续复用，过期就换新的再输）。想一次顺滑发完可用 npm
**granular access token**（Packages and scopes: Read and write，勾 bypass 2FA）
临时放 `~/.npmrc`（`//registry.npmjs.org/:_authToken=…`），**发完立刻删除并
revoke**。两条路都行，交互 OTP 更简单。

---

## 一、发布前门（每次发版，全绿才继续）

在干净的 `main` 上（`git status` 干净；pnpm publish 自带 git 检查，脏树会拒）：

```bash
pnpm install && pnpm build
pnpm test                      # 全量测试
pnpm check:guards              # 四门（内核依赖/旋钮注册/行数预算）
pnpm check:publish             # 发布就绪门：36 包元数据/闭包/bin/dist 全查
pnpm check:npx-smoke           # verdaccio 彩排：真发布→真安装→真启动，不碰真 npm
pnpm check:pypi-pack           # PyPI 侧：build 出 sdist+wheel + twine check
```

`check:npx-smoke` 首跑要冷拉全部外部依赖（马来西亚网络可超 10 分钟），建议
发布日早晨先跑掉。任何一门红 → 修完重来，不带病发布。

版本号：各包 `package.json` 里的就是要发的版本（workspace 各包独立版本）。
发新版先在对应包 bump（内部 `workspace:*` 引用由 pnpm 在发布时替换成真实
版本区间，无需手动改）。

---

## 二、npm 发布

```bash
npm login                      # 浏览器/OTP 流程，登录发布账号
npm whoami                     # 确认身份
pnpm -r publish                # 拓扑序自动；每包 prepack 自建 dist；private 自动跳过
```

- 提示 OTP 时输手机上的 6 位码；一批里过期了就输新的。
- `--provenance` 本机发布**不带**（需要 GitHub Actions OIDC 才有意义；以后
  迁 CI 发布再加）。
- **半途失败**（部分包已发）：不慌——已发的包是完好的；修复问题后把失败
  的包补发（`pnpm -r publish` 重跑会自动跳过已存在的版本）。若已发的版本
  本身有毒，走第四节回滚纪律。

发完核验（干净临时目录，不在仓库里）：

```bash
npm view gotong version                # 薄壳到位
npm view @gotong/host version          # 承重包到位
cd "$(mktemp -d)"
npx -y gotong@latest --version         # CLI 闭包能装能跑
npx -y gotong@latest doctor            # 预检
npx -y gotong@latest start             # 起完整 host，等 host-ready 横幅 + 浏览器向导
```

发布后补测（KIT-M3 注明的欠账）：npm 形态 `gotong update` 真测——
`npm i -g gotong@<旧版>` → `gotong update` → 断言更新到 latest。

---

## 三、PyPI 发布

```bash
cd python-sdk
.venv/bin/python -m build              # sdist + wheel（check:pypi-pack 已验证此步）
.venv/bin/python -m twine upload dist/*    # 用户名 __token__，密码 = API token
```

核验：

```bash
cd "$(mktemp -d)" && python3 -m venv v && v/bin/pip install gotong
v/bin/python -c "import gotong; print(gotong.__name__)"
```

---

## 四、回滚纪律（背下来）

- **绝不 `npm unpublish`**：破坏下游锁文件，且 72 小时后 npm 也不允许。
  PyPI 同理不删除已发版本。
- 发出去的版本有问题 → **前滚**：修复 + bump patch + 重发；坏版本打标记：

```bash
npm deprecate @gotong/host@1.0.0 "broken, use 1.0.1"
```

- PyPI 侧对应动作是在项目页 **yank** 该版本（pip 默认不再选中，但已锁定
  的安装不受影响）。

---

## 五、发完之后

1. 文档已带 npx 首选路径（README / QUICKSTART / GO-LIVE，随本 runbook 同批
   落地）——发布后这些命令即刻为真。
2. 生产机可从 git 形态继续 `gotong update`；新装机器多了
   `npm i -g gotong` / `npx gotong start` 两条路。
3. 把发布结果登记进 `docs/zh/PROGRESS-LEDGER.md`（PUB-M3 收口）。

## 六、npm provenance（构建来源证明）— 调研结论（FAM-M3，2026-07-09）

**现状：拿不到，且是结构性的。** npm 官方要求 provenance 只能在**受支持的云
CI**（GitHub Actions / GitLab CI 的云托管 runner）里构建发布时生成——本机手动
`npm publish`（我们现行模式，见 §二）**不支持**。所以 36 个包目前都没有
provenance 徽章，这不是疏忽，是发布模式决定的；威胁模型页
（[`THREAT-MODEL.md`](THREAT-MODEL.md) §四）已如实披露。

**启用路径（三步，将来要做时照抄）**：

1. 启用仓库 GitHub Actions（现仓库级禁用；仓库已公开，Actions 免费）；
2. npm 侧给各包配 **trusted publishing**（OIDC 信任 GitHub 仓库 + workflow 身份，
   发布不再走本机 OTP）——用 trusted publishing 时 provenance **自动生成**，
   连 `--provenance` 旗标都不用；
3. 写发布 workflow 盖 36 包（发布前门 §一 全部进 CI 复刻）。

**显式推迟，不并入 FAM-M3**：这是把整条发布流水线从「本机 + OTP」迁到
「CI + OIDC」的工程（36 包 workflow + 密钥治理 + 彩排），收益是供应链证明，
风险是发布通道复杂化。等下一次批量发版需求时作为 PUB track 新里程碑评估。
在那之前，介意供应链的用户按威胁模型页建议：从 GitHub 源码构建替代 npm 安装。
