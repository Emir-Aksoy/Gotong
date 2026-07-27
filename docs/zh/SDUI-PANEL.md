# SDUI 可编排面板 — 服务端驱动的家庭终端(M0 计划)

> **一句话**:终端(web/PWA/app)内置一套**封闭组件集**,每个成员的界面形态由一份
> **file-first 配置文件**自由编排;管家改得动界面,但**改不坏、瞒不住、退得回**
> (schema fail-closed + 保留区硬保护 + 响亮播报 + 一键还原;写姿态见岔口 E);
> 客户端与 hub 之间固定的只有 wire 协议 + UI schema 规范。同一个客户端,
> 父亲打开是农事关怀面,母亲打开是本地新闻面,operator 打开是全家看板。
>
> Track 代号:**SDUI**(Server-Driven UI)。Status: **M1–M4 已落(2026-07-26),M5 壳与分发待启**。
> 拍板记录:A=14 组件首批清单照 §六 / B=新增成员可见 tab,home 原样保留 /
> C=JSON / D=owner 直装、成员随时换回 / **E=E1 benign 直改+三重安全网**
> (保留区硬保护+每改响亮播报+改前快照一键还原;E2 提议→确认不做,单成员
> 确认开关 v1 也不做)。
> 落地指针:M1=panel-schema 纯核(`packages/personal-butler/src/panel-schema.ts`)/
> M2=渲染器+`GET /api/me/panel`(`packages/web/static/sdui-ui.js`+`panel-routes.ts`)/
> M3=per-member store+三预设+画廊「面板」资源类(`packages/host/src/me-panel-surface.ts`)/
> M4=管家编排一对工具+快照撤销+归因横幅(`packages/host/src/personal-butler-panel.ts`,
> 见 §九 M4 行)。
> Last updated: 2026-07-26

---

## 一、缘起:家庭生活管家要的终端

用户愿景(2026-07-26 四轮对话收敛):

- 家庭成员各有生活重心——父亲乡村务农(爱好),管家要**时刻关注身心健康、
  多交流农业心得**;母亲关注**当地新闻八卦**;管家还要有**调解家庭矛盾、
  增进整体和谐**的能力。
- 全家都是知识分子,app 无障碍;**多形态信息与可视化**(农事日历、天气面板、
  新闻卡片流、健康趋势)比 IM 纯文本消息好得多。
- 终端演进决策链(逐轮拍板):IM 通道降级为兜底 → 独立客户端连自己的 VPS →
  全球商店上架 + 大陆 APK 直发 → **app 本身要有极大可变性:内置大量组件,
  由设置文件自由编排,对不同的人不同形态;固定的是连接 VPS 的格式规范**。

最后一条就是本 track:它在业界有名字——**Server-Driven UI(SDUI)**,而且
与 Gotong 北极星同构得出奇地好(见 §三)。

**交付路径已定(三段式,一套 web UI 分批点亮)**:
1. 组件系统 + 渲染器在 **web/PWA 先建**(本 track M1–M4)——界面代码将来原样进壳;
2. **Capacitor 壳**上全球商店 + 大陆 APK 官网直发(M5);
3. 壳内按需接原生插件(HealthKit/Google Fit 健康数据、APNs 推送)——独立后续 track。

---

## 二、先查市面(2026-07-26 核)

| 先例 | 与我们的关系 | 关键事实 |
|---|---|---|
| **Home Assistant dashboards** | 最近的同类:自托管服务器 + 配置驱动面板 | dashboard→views→cards 三层;卡片是**封闭目录**,YAML 编排;**strategy** = 用逻辑动态生成整份 dashboard 配置(「管家生成面板配置」的先例同构物);视图/卡片支持 **per-user 可见性**。 |
| **Adaptive Cards**(微软) | 消息卡级 SDUI 的版本协商范本 | 元素级 `fallback`(降级替代或 drop)+ `requires`(能力+最低版本对);卡级 `version` 超出支持范围 ⇒ 渲染 `fallbackText`;**renderer MUST ignore unknown elements and continue**。 |
| **Slack Block Kit** | 同上,封闭 block 目录 + JSON 编排 | 客户端只认注册过的 block 类型。 |
| 苹果审核 3.3.2 | 下发**代码**受限,下发**配置**合规 | HA/Nextcloud 等配置驱动客户端长期在架;上架时需内置演示形态(纯「填服务器地址」空壳有 4.2 打回风险)。 |

结论:「**封闭组件集 + 声明式配置 + 版本化降级**」是被验证的正确切法;我们的
增量是**编排者除了人还有管家**(HA 的 strategy 是脚本,我们的 strategy 是
带安全网的 AI——schema 拒得住、保留区改不掉、每改可见可逆,见边界③/岔口 E)。

来源:[HA custom strategies](https://developers.home-assistant.io/docs/frontend/custom-ui/custom-strategy/) ·
[HA dashboards](https://www.home-assistant.io/dashboards/dashboards/) ·
[AC renderer 规范](https://learn.microsoft.com/en-us/adaptive-cards/rendering-cards/implement-a-renderer) ·
[AC versioning #6](https://github.com/microsoft/AdaptiveCards/issues/6)

---

## 三、为什么 SDUI 与北极星同构

| SDUI 要素 | Gotong 既有立场 |
|---|---|
| 界面配置 = `<space>` 下的 per-member 文件 | **file-first**:复制目录 = 搬走房间,连界面形态一起搬 |
| 每人不同形态,配置按 userId 归户 | SESS 会话窗 / TN 笔记本 / LIB 书架同一纪律 |
| 管家改界面 = 大白话 → 配置变更(响亮可逆,或先确认——岔口 E) | 管家 benign 写自己域(TN 笔记本/LIB 书架)与向导 compose/approve 两套先例都现成 |
| 「固定的是连接规范」= wire + UI schema 版本协商 | STD 标准对齐哲学的延伸;hub is dumb:**hub 只存配置不解释渲染** |
| 渲染是纯配置驱动,零现场 LLM | 热路径零 LLM |

---

## 四、五条不可破边界

1. **封闭组件集、开放编排(绝不下发代码)**。配置只能决定「放哪些组件、怎么排、
   绑哪个数据源、给什么参数」;组件实现随客户端版本发布。想要新组件 = 升级客户端;
   想要新形态 = 改配置。这同时满足苹果审核、注入面控制、可测性三件事。
2. **保留区原则:「编排≠伪装」**。审批卡、金额、对端身份等安全关键 UI 的
   **语义与形状硬编码在客户端**,配置只能决定其位置,永远不能改写内容、不能隐藏
   待批项(细节 §六)。镜像「治理闸不可绕」。
3. **AI 改界面:改得动,但改不坏、瞒不住、退得回**。不可破的是三件事,不是
   「每改必确认」:①schema 校验 fail-closed(未知组件/未知字段/越界值当场拒,
   幻觉配置落不了盘);②保留区结构性不受配置影响(边界②);③每次改动
   **响亮播报 + 一键还原**(改前快照,面板顶部横幅「阿同调整了你的面板
   [看变化] [撤销]」)。在此之上,管家的写姿态是岔口 E(§十一):按仓库
   benign 三段式论证(§12.3),面板配置=管家只写成员自己的展示编排、不执行
   任何真实动作、卡片引用的动作仍走各自治理闸——**推荐 benign 直改 + 上述
   三重安全网**,这才是「由 Gotong 自行调整」的字面兑现;保守备选=提议→
   本人确认(向导 compose/approve 两段形状,§12.2)。人(本人/owner 装模板)
   的修改不设 AI 那道闸——治理焦点在 AI 的写权,不在人上。
4. **file-first + 缺席=默认形态**。无配置文件 = 渲染内置默认面板(今天 /me 的
   等价物),行为与字节不变精神一致;坏文件隔离不销毁,渲染默认面板并响亮提示。
5. **协议版本协商 + 诚实降级**。配置顶层带 schemaVersion;客户端遇到不认识的
   组件类型渲染**占位卡**(「此组件需升级客户端」)——比 Adaptive Cards 的静默
   drop 更进一步:绝不空白、绝不崩、也绝不假装没有。

贯穿两条既有纪律:渲染热路径零 LLM(管家只在提议时用模型);内核零改动
(全部落在 web / host / personal-butler 层)。

---

## 五、UI schema v1 协议设计

### 5.1 配置文件

- **格式:JSON**(推荐,岔口 C)。理由:与 agents.json / tasks.json 家族一致;
  主要写者是渲染器(模板装入)与管家(diff 提议),不是人手;schema 校验直接。
- **落点:`<space>/butler/ui/user/<userId>/panel.json`**(侦察钉死,见 §12.3:
  记忆树的**兄弟目录**形态 B,镜像 A3 语言偏好的归户方式;刻意不进记忆树,
  这样 MU-M5 记忆 git 快照不会把面板配置卷进去)。归户 id 清洗走记忆层现成的
  `assertSafeOwnerId`(personal-memory/paths.ts:21,拒 `/` `..` 空串),
  不是 encodeURIComponent——同一层用同一把清洗刀。
- **写纪律**(全部是既有惯例,一条不新造):原子写走 core 公共件
  `writeJsonAtomic`(core/src/fs-atomic.ts:21,tmp+rename+fsync,绝不裸
  writeFile);目录懒创建在叶子函数里 mkdir;坏文件改名隔离 `.corrupt-<ts>`
  且**只有写者有隔离权**,只读观察者读坏了返回默认形态绝不 rename
  (TN-M2 钉过的双写者纪律);per-user promise 链串行写尾随
  `catch(()=>undefined)` 防断链(session-window.ts 同款);上限响亮拒
  (文件尺寸/组件数超限返回确切错误,绝不静默截断)。

### 5.2 顶层形状(草案)

```jsonc
{
  "schemaVersion": 1,
  "title": "爸爸的面板",            // 可选,顶栏标题
  "sections": [                      // 纵向分组;v1 不做 tabs,减复杂度
    {
      "heading": "今天",             // 可选
      "components": [
        { "type": "weather",  "source": "connector:weather", "params": { "days": 3 } },
        { "type": "calendar", "source": "schedules.mine",    "params": { "view": "week" } },
        { "type": "chat",     "params": { "placeholder": "和阿同聊聊今天的地里活…" } }
      ]
    },
    {
      "heading": "待办",
      "components": [
        { "type": "approval-inbox" },              // ★保留区组件:无 source 无 params 可篡
        { "type": "list", "source": "tasks.mine" }
      ]
    }
  ]
}
```

三个结构性约束:

- **`source` 只能是命名数据源**(白名单枚举,§5.3),配置里**写不进任意 URL**——
  数据外带 / SSRF 的结构性防线。
- **组件内容永远来自 hub API,不来自配置**。配置选组件、排布局、给显示参数;
  展示的数据(待批项、金额、新闻、天气)全部由渲染器按 `source` 现取。
  「配置伪造内容」因此结构性不可能——唯一例外 markdown-card 见 §六。
- **`params` 按组件白名单校验**,未知键当场拒(fail-closed)。

### 5.3 命名数据源(v1 白名单)

渲染器把命名数据源翻成既有 `/api/me/*` 调用,**不新增披露面**——每个数据源
必须映射到成员本就有权看的投影(SEN 纪律:披露 ⊆ 既有面):

| 数据源 | 映射 | 既有面 |
|---|---|---|
| `inbox.pending` | 待批项投影 | /me 收件箱 |
| `chat.butler` | 管家对话(含 NDJSON 流式) | quick-chat |
| `tasks.mine` | 任务笔记本 | TN 只读投影 |
| `schedules.mine` | 定时流(自己名下) | SEN-M4 |
| `usage.mine` | 用量 | 成员用量面 |
| `status.hub` | hub/管家状态 | SEN-M1/M3 同源 |
| `connector:weather` / `connector:news` / … | 只读连接器槽位 | MCP 目录(缺槽=组件渲染「未接入」占位) |
| `content:<fileId>` | 管家写的展示内容文件(markdown) | 见 §六 markdown-card |

### 5.4 版本协商与降级

- `GET /api/me/panel` 返回 `{ schemaVersion, config }`;客户端在请求头/参数里
  声明自己支持的 schemaVersion 与组件集版本。
- 客户端遇未知组件类型 ⇒ 占位卡(组件名 + 「需升级客户端」),其余照常渲染
  (Adaptive Cards「ignore & continue」的诚实版)。
- schemaVersion 高于客户端支持 ⇒ 整面板降级为默认面板 + 顶部响亮提示,绝不崩。

---

## 六、组件目录 v1(拍板清单,岔口 A)

首批 **14 个**(布局原语 2 + 数据组件 11 + 保留区 1),覆盖三个家庭预设面板的
全部需要:

| # | type | 一句话 | 数据源 |
|---|---|---|---|
| 1 | `section` / `heading` | 布局分组与标题(原语) | — |
| 2 | `divider` | 分隔(原语) | — |
| 3 | `chat` | 管家对话框,流式打字 | chat.butler |
| 4 | `approval-inbox` | 待批卡 **★保留区** | inbox.pending(强制) |
| 5 | `card-feed` | 卡片流(晨报/新闻) | connector:news 等 |
| 6 | `markdown-card` | 管家写的自由内容卡(农业心得笔记、关怀留言) | content:<fileId> |
| 7 | `chart` | 折线/柱状趋势(用量;将来健康) | usage.mine / 将来 health |
| 8 | `calendar` | 日历(农事、家庭日程) | schedules.mine / connector:calendar |
| 9 | `list` | 清单(待办/购物) | tasks.mine |
| 10 | `weather` | 天气卡 | connector:weather |
| 11 | `status-card` | hub/管家状态一眼 | status.hub |
| 12 | `schedule-list` | 定时流列表 | schedules.mine |
| 13 | `quick-actions` | 快捷动作按钮 | 动作白名单(见下) |
| 14 | `image-card` | 图片卡 | uploads / connector 相册 |

**quick-actions 的动作白名单**:按钮动作只能是预定义动词
(`open_chat` / `start_workflow:<id>` / `open_inbox` / `compose_brief`…),
配置写不进任意调用——与数据源白名单同一防线。

**保留区细节(边界②的落实)**:

- `approval-inbox` 的渲染逻辑硬编码:内容强制来自 `inbox.pending`,配置不可
  指定别的 source、不可注入文案模板;金额/对端身份/动作名的展示字段在组件内
  写死。配置能做的只有「放在哪个 section」。
- **待批徽章是渲染器固定件,不是组件**:面板顶栏的「N 件待批」徽章由渲染器
  无条件渲染,任何配置都不能移除或遮挡——即使某人的面板没摆 `approval-inbox`
  组件,待批事实也永远可见、一点即达。这是「编排≠伪装」的最强保证,
  UI 版的 A1 探针。
- `markdown-card` 是唯一「内容可由管家产出」的组件,两道防混淆:内容文件只能
  来自本成员的 content 目录(管家 benign 写自己的展示内容,同 LIB 书架边界);
  渲染时带固定来源角标(「阿同写的」),样式上结构性区别于保留区组件——
  markdown 卡**画不出**一张假审批卡。

**组件蔓延防线**:组件目录进防腐测试(清单双向核对,加组件不登记就红),
新组件的门槛 = 「至少两个预设面板用得上,或一个数据源没有任何既有组件能渲染」,
防止「每个需求一个新组件」侵蚀封闭集纪律。

---

## 七、编排权限模型

| 谁 | 权限 | 闸 |
|---|---|---|
| 本人 | 改自己的面板(装模板/将来手动编辑器) | 直接生效(人对自己的界面有完全主权) |
| owner/admin | 给成员装预设模板(家庭信任模型,岔口 D) | 直接生效,成员随时可换回 |
| **管家(AI)** | 改**本成员自己的**面板(岔口 E 定姿态) | schema fail-closed 恒在;推荐=benign 直改+三重安全网(播报/还原/保留区);备选=governed 提议→本人确认 |
| 工作流/其他 agent | 无 | 结构性无此工具 |

无论岔口 E 选哪边,**校验与落盘收口在一个服务**(`me-panel-config-service.ts`
之类,manifest.ts「one validator, no drift」惯例):手工 PUT、模板装入、管家
写入三个入口跑同一个 `validatePanelConfig`。若选备选(确认路线),形状照抄
向导两段式——compose 零副作用出 diff(`computeLineDiff`,
workflow-edit-diff.ts:33),approve 零 LLM 落用户看过的那份原样
(me-workflow-create-service.ts:308,理由见其 :300-307 注释);工具挂**独立**
`GovernedActionToolset`(personal-butler-workflow-create.ts:21-29 判例,
不进 StewardAction 词汇表),park 前先拒无效提议、批准后重新校验当前状态
(NET-M2 姿态,§12.2),且显式标 web-only(diff 在 IM 纯文本里看不清,
escalation 白名单按形状判会误放行,personal-butler-escalation.ts:88-97)。

---

## 八、三个家庭预设面板(M3 模板,愿景落地的样子)

- **父亲·农事关怀面**:weather(3 天)+ calendar(农事周视图)+ chat(农业
  话题引导语)+ markdown-card(阿同整理的农业心得笔记)+ list(农活清单)。
  关怀节律(主动问候/节气提醒)是服务端 track,推送到 chat 与通知,不依赖本 track。
- **母亲·本地生活面**:card-feed(本地新闻晨报)+ chat + weather +
  schedule-list(晨报节律可见)+ quick-actions(「今天的新闻」「提醒他吃药」)。
- **operator·全家看板**:status-card + approval-inbox + chart(用量)+
  schedule-list + chat + quick-actions(管理动线)。

三份模板随画廊一键装。侦察结论(§12.2):**扩「面板」资源类可行,FDE 有
三连同型先例**,成本约 8 处文件(manifest 子解析器/卡片投影/import sink/
ctx 穿线/host file-first store/main.ts 接线/例子+CURATED/测试);两个陷阱
要显式处理——空模板判定只认 agents/workflows/knowledgeBases 三类
(template-manifest.ts:308-312,「只带面板的模板」要改这行)、校验器必须
export 共享给三个写入口。这属于 M3 的工作量,不是 M0 要拍的岔口。

---

## 九、里程碑分解(待批)

| 段 | 内容 | 验收 |
|---|---|---|
| **M1 纯核** | panel-schema:类型 + `validatePanelConfig`(fail-closed)+ 默认面板常量 + 数据源/动作白名单;零 UI | 单测:未知组件/未知键/坏 source 全拒;默认面板过校验 |
| **M2 渲染器** | web 配置驱动渲染器 + 首批组件(chat/approval-inbox/占位卡先行)+ `GET /api/me/panel`;挂点按岔口 B | 真浏览器 round-trip:无配置=默认面板;坏配置=默认+响亮;未知组件=占位卡;待批徽章配置不可移除(防腐测试) |
| **M3 模板与归户** | per-member 配置文件 + 三预设模板 + 装入动线(owner 装/本人换) | 装模板→面板变形;复制 space=形态跟走 |
| **M4 管家编排 ✅(2026-07-26)** | 按 E1 落地:benign `get_my_panel`(现状+库+**从 `PANEL_COMPONENT_CONTRACTS` 派生的组件契约小抄**,零手抄漂移)+ benign `set_panel_layout` 四写法互斥(config/libraryId/reset/undo)全走 M3 store 同一校验咽喉。三重安全网:①改不坏=校验拒后文件字节不变;②瞒不住=每次管家写都带 `by:'butler'` 落快照槽 → `GET /api/me/panel` 带 `lastChange` → SPA 结构性渲染「阿同调整了你的面板 [撤销][知道了]」横幅(与模型嘴上说什么无关);③退得回=改前快照单槽 **swap 语义**(连撤两次来回换,永不销毁状态)。userId 闭包进 builder=成员结构性只能动自己的面板;AFR 注册三件套过;两工具进目录层(改布局是偶发动作) | 全过:幻觉组件名被拒+字节不变(单测逐字节断言);保留区 approval-inbox 带 params 被拒零落盘;真浏览器 round-trip=真 toolset 换形态→横幅出现→点撤销真还原+横幅结构性解除(`by:'human'`)+console 零错误。**round-trip 抓到真 bug**:store `applyLibrary` 实现吞掉 opts 参数,管家最常用写法归因静默落 'human'=横幅不亮,已修+两条钉死测试(每种写法都断言归因,不只 config) |
| **M5 壳与分发** | Capacitor 壳 + 全球商店 + 大陆 APK 直发(含演示形态过审) | 真机安装连自有 VPS round-trip |

**Codex 交叉审收口(2026-07-26,gpt-5.6-sol 独立审 M1–M4 四 commit,0H/5M/5L)**:
干净面先说——XSS(全 textContent 沉降)/路径穿越/鉴权绕过/其他被吞参数/徽章可移除,
五个重点方向零发现。10 条属实发现收 8 修 1 部分 1 记档:①快照解析收严成**唯一严格
解析器** `readPrevSnapshot`(槽文件缺 `config` 自有键=malformed:undo 响亮拒绝零触碰,
横幅不亮——绝不把残缺槽读成「当时是默认」然后替成员清空面板);②库 id 上限 64 字符
(id 即文件名,防 ENAMETOOLONG 中断安装循环);③`installPanels` 改**先写后清**+逐条
try/catch(一条写失败绝不再连坐后面的条目;崩溃中途留新旧并存可恢复,不再是清完旧的
写不进新的);④渲染器 chat 掉 `rows[0]` 盲回退(无 chat 能力=诚实「无 agent」态,
不抓随机专家);⑤校验器三补:isPlainObject 钉原型(构造对象走原型链夹带字段被拒)+
`HOSTILE_TEXT_RE` 拒控制字符/bidi 覆盖字符进 title/heading/字符串参数(内容仿冒面)+
保留区组件每份配置**至多一枚**;⑥web PUT 改 exactly-one 模式+拒未知键(双模式并存
不再静默按优先级挑赢家);⑦写者隔离扩到「可解析但非法」前任(证据不再被覆盖销毁);
⑧工具层 libraryId 判定统一(`{config, libraryId:""}` 不再错路由拒绝)。**部分修**:
M1 快照/写非事务窗口——不上锁(单进程 host+三写面共享 ONE store 实例,残余=崩在两写
之间丢一层 undo,有界),但补**幻影横幅抑制**:快照所记与当前所服务 deep-equal 时不亮
横幅(同形态重装/崩溃窗口两类幻影一起消)。**记档不修**:ack 毫秒时间戳理论撞车
(L9,需 changeId 不值当)。验收:personal-butler 137(+3)/web 1505(+2)/host 2521+5
skip(+8),四门 PASS(旋钮 115 零新增,main.ts 2725/2725)。

**相关但独立的 track(不塞进 SDUI)**:PUSH(Web Push/VAPID 通知)、
CARE-FAM(关怀节律引擎)、MED(跨成员调解披露治理)、HEALTH(HealthKit 原生插件,
M5 之后)。SDUI 是终端骨架,它们是住进来的能力。

---

## 十、显式不做 / 推迟

- **下发代码/任意 WebView**:永不(边界①;苹果 3.3.2 + 注入面 + 不可测)。
- **手动拖拽编辑器**:v1 编排靠模板 + 跟管家说一句话,可视化编辑器等真实需求信号。
- **tabs/多页面板**:v1 单页 sections,减 schema 面。
- **第三方终端协议开放**:UI schema 稳定(≥两个大版本)后再谈,先不承诺。
- **组件内任意 JS 表达式绑定**(Adaptive Cards 的 templating 语言):v1 params
  全静态,条件显隐等真实需求再议——每加一分表达力,校验器与保留区就多一分攻面。
- **快照+写的全事务化**(Codex M1):单进程 host + 三写面共享同一 store 实例 +
  per-user promise 链已消并发撕裂;剩的是崩溃窗口丢一层 undo(有界残余),幻影横幅
  已由 deep-equal 抑制盖住。上文件锁只为这个窗口不值当,记档等多进程形态再议。
- **模板 `template.id` 进库条目**(Codex M3):画廊是策展面,跨包同名 id 覆盖=
  「文件名即寻址键」的记档设计,不加第二把钥匙。
- **placeholder 白名单枚举化**(Codex M5):预设面刻意用自定义 placeholder 文案,
  枚举化会杀掉它;敌意文本已由 HOSTILE_TEXT_RE 拒,内容仿冒残余接受。
- **`lastChange` 加 changeId**(Codex L9):ack 毫秒戳同刻撞车是理论窗口,
  多一个字段不值当。

---

## 十一、岔口(待用户拍板)

- **A. 组件目录首批清单**(§六 14 个):增删?
- **B. 新面板挂点(侦察后推荐)**:统一 SPA 内**新增成员可见 tab「面板」**
  (`sdui-panel` section + 自包含 `sdui-ui.js`,走仓库已有的 11 模块 panel 协议;
  成员可见注入走 `workflow-graph.js` 同款无角色门 script 行)。今天的 home tab
  原样保留——SDUI 面板成熟后再讨论把 home 折进默认面板配置,**不一步到位改造
  首屏**(降爆炸半径;home 的 14 张卡正是未来组件化的素材库)。备选:直接改造
  home tab(激进,回滚面大,不推荐)。
- **C. 配置格式**:JSON(推荐,§5.1)还是 YAML?
- **D. owner 直装成员面板**:家庭信任模型下 owner 直接生效(推荐),
  还是也走成员确认?
- **E. 管家写面板的姿态**(侦察后新增,直接影响 M4 形状):
  - **E1 benign 直改 + 三重安全网(推荐)**:`set_panel_layout` 走 benign 面
    (仓库 benign 三段式论证成立,§12.3:只写成员自己的展示编排/不执行任何
    真实动作/卡片引用的动作各走各的治理闸——与 TN 记笔记、LIB 上架同域),
    安全网=保留区结构性硬保护 + 每改响亮播报 + 改前快照一键还原。
    「阿同,把天气挪到最上面」一句话就生效——这才是「由 Gotong 自行调整」
    的字面兑现;审批留给真正有后果的动作,不稀释审批的严肃性。
  - **E2 governed 提议→本人确认(保守备选)**:向导 compose/approve 两段
    形状(§12.2),diff 预览、不确认字节不变、web-only。代价=每次微调都要
    一次确认点击,长期会把「改界面」变成负担;工作量也更大(park/恢复/
    审批卡/IM 白名单排除四件事)。
  - 折中可选:E1 起步 + 单成员开关「面板改动需我确认」(默认关)——
    但 v1 建议先不做开关,少一个状态。

---

## 十二、现有资产侦察记录(2026-07-26,三路并行)

### 12.1 web 面现状(渲染器落点)

- **/me 已折进统一 SPA**:`GET /me` 301→`/`(server.ts:1113-1117),成员视角
  = `app.html` 的 `#home-panel`(app.html:263-534,272 行手写 DOM,14 张卡)+
  `app.js` `renderHome()`(app.js:897 起,约 2788 行 /me 逻辑,全文 4067 行)。
  布局纯静态硬编码 + `getElementById` 挂接 + innerHTML 拼接,**零组件化痕迹**
  ——SDUI 是绿地。
- **现成的「空壳 + 渲染器」范式**:仓库已有 **11 个自包含 panel 模块**
  (`setting-ops-ui.js` / `identity-ui.js` / `a2a-ui.js` …),契约 =
  空 `<section id="x-panel">` 宿主 + 自包含 IIFE +
  `MutationObserver(attributeFilter:['data-active-tab'])` 懒激活
  (协议头注 setting-ops-ui.js:1-33,激活 :318)。**SDUI 渲染器照此协议新建
  `sdui-ui.js`**;但 11 个先例全在 `loadAdminBundles()`(app.js:3878,
  `ADMIN_OR_OWNER` 门)里,成员拿不到——成员可见 bundle 的注入先例是
  `workflow-graph.js`(app.html:37-40,「member SPA 与 admin console 共用
  渲染器」),SDUI 走同一条无角色门的 `<script defer>` 行。
- **schema→控件已有雏形**:`renderField(f)`(app.js:1099-1136)按后端
  inputSchema 动态生成表单控件——仓库唯一现存的「服务端描述→前端渲染」代码,
  渲染器直接吃这套心智。
- **路由预算现实**:me-routes.ts **2872/2885(余 13 行)**、server.ts 2387/2395
  (余 8 行)。唯一正确姿势 = 抄 `wizard-routes.ts` 判例(me-routes.ts:481-483
  注释明书「实现在 wizard-routes.ts(控本文件行数预算)」):me-routes 里只加
  3-4 行派发块,全部 handler 落**新文件 `panel-routes.ts`**;server.ts **零改动**
  (`/api/me/` 前缀 server.ts:1139 已整体交给 handleMeRoute);鉴权白送
  (handleMeRoute 顶部 :437-453 已解析 v4 session,userId/role 透传)。
- **刷新通道**:admin SSE `/api/stream` 是 `requireAdminOrWorker` 硬边界
  (server.ts:917,全 Hub 火管不能放开给成员);/me 侧「no global stream,
  nothing to mis-scope」是明文珍视的安全属性(me-routes.ts:1212-1214)。
  **面板刷新走轮询**(抄 `scheduleMyRunsPoll` 骨架:退避+不可见即停+120s 硬顶
  +代际号,app.js:2367-2404),**AI 内容走 per-request NDJSON**
  (服务端模板 me-routes.ts:1216-1231 + 客户端 `readNdjsonStream` app.js:1950-1985)。
- **i18n**:双词典各约 1767 key(app-core.js zh :20 / en :2079);面板 spec 文案
  **推荐服务端下发已本地化串**(inline-bilingual 先例 `KEY_PROVIDER_GUIDES`
  app.js:129-146,注释 :120-121 认可「keeps the flat i18n dict lean」)——
  面板配置是数据,不污染静态字典;组件自身的 chrome 文案(按钮/占位)仍走字典。
- **PWA**:`manifest.webmanifest` + `sw.js`(network-first 导航 + SWR 静态 +
  `/api/*` 永不拦截——pwa.test.ts:84-95 把这条钉成回归断言)。新 bundle
  **不进 PRECACHE**,走 `.js` SWR 自动路径;若改 app-core/app.js 必须 bump
  `CACHE='gotong-shell-v3'`(sw.js:29)。**Web Push 完全绿地**(全仓无
  push/VAPID/showNotification 代码)——PUSH track 从零起建,与本 track 解耦。
- **构建管道**:新 bundle 需新 esbuild 入口(build-admin-ui.mjs 是单入口硬编码
  :32,复制一份 `build-sdui-ui.mjs` 挂进 `build:assets` 链 package.json:44),
  产物落 static/ 后必须重跑 build-static-assets.mjs(单文件二进制走内嵌资产,
  static-routes.ts:124-129)。

### 12.2 draft→confirm 缝与模板画廊(管家编排 / 模板落点)

- **「人确认」在仓库里有三种现成形态**,SDUI 若走确认路线该抄**向导 WIZ 两段式**:
  `compose` 只产草稿+缺口分析(**零副作用**)→ 用户点头 → `approve` **零 LLM**
  按用户看过的那份原样落盘(wizard-routes.ts:226/:248 +
  me-workflow-create-service.ts:308,注释 :300-307 明写为什么 approve 不能重跑
  生成)。对照:WFEDIT/ARCH 是一次调用直接落盘(自然语言=意图=确认,diff 是
  事后预览);steward 是 plan→卡片→apply。
- **可逐字节复用的原语**:NDJSON `stream:true` 分支(me-routes.ts:1215-1269,
  四处同形)+ 前端 `readNdjsonStream`(app.js:1951);`computeLineDiff` 文本
  diff 预览(workflow-edit-diff.ts:33)+ 前端渲染(app.js:1486/:1503);
  `draftStatus` 三态 `valid|no_yaml|invalid` + **深检只染黄不下调**
  (assistant.ts:158/:522/:567)——面板可直接抄成 `panelDraftStatus`;
  contextHints 纪律(提议必须喂 hub 真实存在的 id,否则模型会编,
  me-workflow-edit-service.ts:440-457)。
- **若走 governed 路线的判例**:面板动作**不进** `StewardAction` 词汇表——
  进 union 要牵七处(types/穷尽 Record/validate/tier 表/summarize/perform/
  审批文案);正确姿势是独立 `GovernedActionToolset`
  (personal-butler-workflow-create.ts:21-29 判例,`agent.ts:272 governedFor`
  天然支持多闸共存)。**三条不变式**都有先例背书:①服务端权威分级、客户端
  tier 永不采信(hub-steward-service.ts:626-632/:657-667);②**批准后姿态
  重解析**,配置在审批窗口期可能被别人改过,变了就诚实说「情况变了没落盘」
  (personal-butler-ask-peer.ts:217-232,NET-M2);③park 前先拒无效提议,
  不浪费成员一次审批(ask-peer.ts:197-211)。
- **注意**:escalation 的 IM 可批白名单**按形状判**
  (personal-butler-escalation.ts:88-97,`ask_peer` 与含 `__` 的才 web-only)
  ——面板提议若走 park,会自动允许 IM 审批;但 diff 预览在 IM 纯文本里看不清,
  若选确认路线应显式标 web-only。
- **模板画廊扩「面板」资源类:能,且有三连先例**(FDE-M1/M2/M3 同型扩展),
  成本 8 处文件(template-manifest 子解析器+挂载 / template-routes 卡片投影 /
  agents-routes import sink / server-types+server 穿 ctx / host 侧 ~150 行
  file-first store 照 template-connector-slots.ts / main.ts 接线 / 例子+CURATED /
  三个测试文件)。**陷阱**:空模板判定只认 agents/workflows/knowledgeBases
  三类(template-manifest.ts:308-312),「只带面板的模板」要显式改这行;
  闸收口纪律=**校验器 export 共享**,「手工 POST/PUT、模板导入、管家落盘」
  三个入口跑同一个函数(manifest.ts 惯例「one validator, no drift」)。

### 12.3 per-member 文件惯例与工具治理(配置文件落点)

- **落点钉死:`<space>/butler/ui/user/<userId>/panel.json`**(memory 树的
  **兄弟目录**,镜像 A2 presence / A3 prefs 出树先例
  personal-butler-factory.ts:303-316)。理由同源:面板配置是低频成员意图,
  **不该被 MU-M5 memory git 快照收编**;拼装照抄 A3 一行
  `join(ownerDir(join(dirname(memoryRoot),'ui'),{kind:'user',id}), 'panel.json')`,
  自动获得 `assertSafeOwnerId` 穿越防护(services-sdk owner.ts:225-238)。
  **不用 encodeURIComponent**——那是 SESS 群窗键含冒号的特例(session-window.ts:248-250)。
- **写纪律全套沿用**:`writeJsonAtomic`(core fs-atomic.ts:114,收敛动机在文件头
  :1-18——「让这个 bug 只有一个地方可以修」;**别抄** butler-outbox.ts:193 等四处
  裸 writeFile 的既有不一致)+ mkdir 归叶子(fs-atomic.ts:39)+ per-user promise
  链串行写(单文件单链抄 task-notebook.ts:146,185-190,`catch(()=>undefined)` 防
  楔死)+ 坏 JSON 写者隔离 `.corrupt-<ts>` 绝不销毁(task-notebook.ts:161-177 /
  session-window.ts:271-281)+ **只读观察者(渲染器/web GET)绝不隔离改名**
  (readTaskNotesSnapshot task-notebook.ts:504-520,隔离权归唯一写者)+
  上限响亮拒(TASK_NOTEBOOK_LIMITS 先例)+ **零新旋钮,常量即合同**。
- **工具分级(benign 三段式论证公式,仓库反复钉死的原文)**:①只动本人域内
  → 对别人零后果(personal-butler-language.ts:14-17「same class as
  set_reminder」);②只写配置/清单,**不执行任何真实动作**
  (knowledge-library.ts:21-22「知识≠授权」);③配置里「读到/点到」的对外动作
  仍各走各的 governed 闸(task-notebook.ts:18-21「Notebook ≠ authorization」)。
  面板工具按此落 **benign + AFR 目录长尾**(同 set_reply_language,
  butler-tool-tiers.ts:70-71「一次性配置类」);登记必须**三处同改**
  (tiers 名单 / 工厂 benignFlat+longTail 双数组 / 度量注册表),否则防腐门红
  (butler-tool-tiers.test.ts:213-244)。**若配置能声明「自动执行动作」则那部分
  必须 governed 或结构性禁止**——本设计选结构性禁止:配置只描述「显示什么」,
  动作永远是用户点击后的另一次调用(§六 quick-actions 动作白名单)。
- **尾卡判据**:面板布局是低频「状态」而非每轮「建议」→ 若做管家感知卡应进
  **stable 段**(agent.ts:92-107 判据「advice→volatile;state→stable」,
  LIB INDEX 卡先例);三件套同改(builder 命名正则 / STABLE_CARD_REGISTRY /
  注入点全文件唯一,butler-context-report.test.ts:500-505)。
- **web 读缝**:窄鸭子 `MePanelSurface` 照 `MeChatSessionSurface` 形状
  (me-routes-types.ts:768-771),host 在 main.ts 适配注入、surface 缺席=能力
  优雅缺席(main.ts:2381-2391 样板);**userId 由 session 强制、绝不取 client 值**
  (butler-memory-service.ts:9-13);web 类型从 `WebServerOptions['mePanel']`
  反向派生免重复(butler-memory-service.ts:48-51 先例)。
- **意图 vs 事实要分文件分写者**(若将来需要「成员配的布局」vs「管家渲染快照」
  两半):TN 的 tasks.json / tasks-nudges.json 先例
  (personal-butler-task-nudge.ts:51-52,「two writers can never race」)。
