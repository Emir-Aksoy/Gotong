# 模板画廊一键安装 (Template Gallery)

> Track G (Gallery). 给 admin 控制台的「工作流」面板补一个**模板画廊**:
> 点「模板画廊」按钮,弹出随框架附带的一批开箱即用模板卡片(每张显示
> agent / 工作流 / 知识库槽位数量 + 是否要 API key),点一张卡上的「安装」
> 就把这套结构装进当前 hub —— 复用早就存在的模板导入路径,**零新机制**。
>
> Last updated: 2026-06-21

---

## 一、为什么做(缺口性质 = 打包/呈现,不是能力)

模板系统(v5 Stream B)早就能导入 `gotong.template/v1`:一个文件装 N agent +
N 工作流 + 可寻址 KB 槽位 + 一键 `apiKeyPrompt`。能力一直在,缺的是**可发现性 +
打包**:这些上手模板原本只散落在 `examples/*/template/*.template.yaml`,要装得自己
找文件、读 YAML、贴进「导入 bundle」框。画廊把它们**就地铺在 admin UI 里**,一眼看清
每套装什么、点一下就装好。**纯打包/呈现层,不碰执行、不碰存储、不碰 schema。**

**严守「模版与框架分离」**(Stream B 决策 #4):模板只带**结构 + 引用**(agent +
工作流接线 + KB 槽位指针),**永不带知识内容或人员**。安装把 agent 落地、工作流注册、
KB 槽位**只上报不自动接线**——使用者自己把知识库接到每个声明的槽位。

---

## 二、动了什么(一条纵切,core/protocol/identity/workflow-runner 零改)

| 层 | 改动 | 文件 |
|---|---|---|
| 构建 | **生成器**把 10 个精选 `examples/*/template/*.yaml` 嵌进一个 TS 模块 | `packages/web/scripts/build-builtin-templates.mjs` → `packages/web/src/builtin-templates.ts` |
| web | `GET /catalog`(预览,无 yaml)+ `GET /catalog/:id`(原始 yaml),都过真 `parseTemplate` 投影,admin 闸 | `packages/web/src/template-routes.ts` |
| 前端 | 「模板画廊」按钮 + modal + 卡片网格 + 安装(catalog → import 两步) | `packages/web/admin-src/main.js` · `static/app.html` · `static/app-core.js`(i18n) · `static/styles.css` |

**安装走的是早就存在的 `POST /api/admin/templates/import`**(Stream B B-M4),
一个字节不改。画廊只是把「拿 yaml → POST 给 import」这两步搬到 UI 上。

---

## 三、嵌入的模板目录(10 个,生成器精选)

生成器 `build-builtin-templates.mjs` 维护一张精选清单(按顺序):

| id | 来源 example | 类型 |
|---|---|---|
| `personal-coding-hub` | `examples/personal-coding-hub` | 个人 — 编码助手(Claude Code + Codex) |
| `codex-deepseek-hub` | `examples/codex-deepseek-hub` | 个人 — 编码助手(Codex + DeepSeek TUI) |
| `personal-research-hub` | `examples/personal-research-hub` | 个人 — 研究/知识中枢 |
| `morning-brief-hub` | `examples/morning-brief-hub` | 个人 — 我的晨报(定时工作流,LIFE-L2①;装完补一条调度即每早自动跑) |
| `battle-monk-training` | `examples/battle-monk-training` | 个人 — 成长计划(身/心/学三柱) |
| `smart-home-hub` | `examples/smart-home-hub` | 个人 — 智能家居中枢 |
| `cafe-ops` | `examples/cafe-ops` | 组织 — 门店运营(管理面 + HITL) |
| `warband-club` | `examples/warband-club` | 组织 — 同好会(协作面 + 共享档案库) |
| `tea-supply-link` | `examples/tea-supply-link`(`tea-shop.template.yaml`) | 组织 — 跨组织(门店→供货商) |
| `tea-chain-hq` | `examples/tea-chain-hq`(`chain-hq.template.yaml`) | 组织 — 跨组织(总部→门店) |
| `family-tutor` | `examples/family-learning-hub`(家长侧) | 组织 — 家庭学习(导师 + 审批闸) |
| `child-desk` | `examples/family-learning-hub`(孩子侧) | 个人 — 孩子学习桌(零订阅) |

每个嵌入条目形如 `{ id, sourceExample, yaml }`。`${ENV}` 占位符**原样保留**
(生成器用 `JSON.stringify` 而非反引号,不会被 shell 展开)。

---

## 四、catalog 路由(`template-routes.ts`)

两个 admin 闸后的 GET,都把嵌入 yaml 过**真 `parseTemplate`**(= 安装时用的同一个
解析器),所以预览永远不会跟实际落地的东西漂移:

```
GET /api/admin/templates/catalog       → { templates: [{ id, sourceExample, name,
                                            description?, version, agents[], workflows[],
                                            knowledgeBases[], apiKeyPrompt? }, …] }
                                          ← 精简预览,故意不带 raw yaml(列表保持轻量)

GET /api/admin/templates/catalog/:id    → { id, yaml }
                                          ← 那个模板的原始 manifest(前端 POST 给 import)
```

`buildTemplateCatalog()` 是 memoized 的(嵌入清单是静态的),逐条 try/catch
(一个模板解析坏了不拖垮整个列表)。未知 id → 404,无 token → 401。

---

## 五、安装路径(前端两步)

「安装」按钮做的事 = 一次性把字节从 catalog 搬到 import:

```
①  GET  /api/admin/templates/catalog/:id   → 拿这个模板的原始 yaml
②  POST /api/admin/templates/import         → { template: yaml }
                                              ← { ok, team:{created,skipped,spawnErrors},
                                                  workflows:[{id,ok}], knowledgeBases:[…] }
```

成功后人类摘要:**N 个 agent 新建 / M 个跳过(已存在)/ W 条工作流注册 /
K 个 KB 槽位待接线**。然后刷新 agents + workflows 两个列表让新到的露面。

**安装即配置 key 流**:画廊提示里写清——需要 API key 的 agent 安装后在「agent」
面板填。导入路由对 spawn 错误是**软上报**,所以带真 provider(如 DeepSeek)的模板
即使还没填 key 也能把 agent 落地成记录,稍后补 key 即可。

---

## 六、测试

| 层 | 测试 | 覆盖 |
|---|---|---|
| web | `tests/builtin-templates.test.ts`(G-M1) | **防腐**:每个嵌入 manifest 重过真 `parseTemplate`,改坏即红(child-desk 零 agent 也覆盖) |
| web | `tests/template-catalog-routes.test.ts`(G-M2) | `/catalog` 列 10 条(无 yaml)、cafe-ops 投影(2 agent/3 工作流/1 KB)、child-desk agents:[] 但 workflows>0、`/catalog/:id` 重解析、404、401 |
| web | `tests/template-gallery-install.test.ts`(G-M3) | **一键安装往返**:catalog → import,cafe-ops 落 2 agent + 转发 3 工作流 + 报 1 KB 槽位;**幂等**第二次装两个都 skipped 不克隆;child-desk 零 agent 工作流仍 land |

install 往返测试是整个 Track 的理由那一个:它在路由层证明前端「安装」按钮做的两步
**端到端真能把模板装进 hub**(catalog yaml 与 import 解析的是同一份字节)。

---

## 七、诚实边界(显式非目标)

- **不是模板编辑器**:画廊只装现成的随框架模板。改/造模板走 YAML import 或导出
  (Stream B `POST /api/admin/templates/export`)。
- **模版/框架分离不破**:安装永不还原知识内容或人员(决策 #4/#5)——KB 槽位**只上报
  不自动接线**,人员(`resource_grants`)永不跨 hub 还原,使用者自己接知识库、自己授权。
- **嵌入是构建期快照**:`builtin-templates.ts` 是生成产物;改了 `examples/*/template/`
  里的 yaml 要重跑 `build:templates` 才会反映到画廊(防腐测试是哨兵)。
- **不碰导入路由**:画廊复用 `POST /api/admin/templates/import` 一字不改——
  画廊只是它前面的一个发现/打包层。

---

## 八、跟「只读 DAG 可视化」(Track D)的关系

模板画廊(Track G)和只读流程图([`WORKFLOW-DAG-VIZ.md`](WORKFLOW-DAG-VIZ.md),
Track D)是同一轮**「呈现/打包」**收口的两半:都不加核心能力,都是把早就存在的东西
(模板导入 / `WorkflowDefinition` 那张 DAG)**铺到 admin UI 上让人一眼看清**,
core/protocol/identity/workflow-runner 全程零改。装进来 → 看清结构,正好接成一条
上手链:**画廊一键装 → 流程图看懂它怎么跑**。
