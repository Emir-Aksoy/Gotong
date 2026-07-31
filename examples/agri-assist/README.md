# agri-assist — 农业辅助(家庭菜园/果园)

> 画廊第一个**三类资源同装**的组合包:一次安装同时落下 1 个分身 + 2 条
> 工作流 + 1 张 SDUI 面板形态。面向家庭菜园/果园尺度(阳台盆栽到几分地
> 果树),不是大田农业。配合 SHELL 真壳(Android/iOS)使用时,手机上装的
> 就是一个「菜园照看 app」——但它只是同一个 hub 的第 N 个渲染器,装 app
> 不多一分权限。

## 装完得到什么

| 资源 | id | 是什么 |
|---|---|---|
| 分身 | `garden-advisor` | 菜园顾问(capability `garden.advise`),两种活:出周安排 / 病虫害问诊 |
| 工作流 | `garden-weekly-plan` | 本周农事安排:说清种着什么,给一页「本周要做 / 浇水施肥 / 病虫害提防」;可配每周六早定时 |
| 工作流 | `garden-diagnose` | 病虫害问诊:描述症状,给「可能是什么 / 怎么处理 / 什么时候要找人」 |
| 面板形态 | `garden-care` | 菜园照看面:天气 + 农事周历 + 农活清单 + 顾问笔记卡 + 一键跑两条流 |

## 装法

1. 管理面板 → 模板画廊 → 「农业辅助(家庭菜园/果园)」一键安装,导入时
   填一次 API key(预填 DeepSeek;要接自己的模型,装完在 agent 面板改
   baseURL/model 即可,key 也可走 `apiKeyEnv` 环境变量名)。
2. 「定时」卡给 `garden-weekly-plan` 补人启用(每周六早 7 点),把建议
   inputs 里的 `crops` 改成自家真种的东西。
3. 成员打开「面板」标签底部「面板形态」,换上「菜园照看面」;手机壳里
   配对同一个 hub,看到的就是这张面。

## 设计要点

- **对话入口永远是管家阿同**:面板 chat 卡的契约只有 `chat.butler`,
  顾问刻意不带 `chat` capability(带了会被当成第二个管家)。问农事可以
  直接问阿同(它能用 `ask_my_agent` 请教顾问),要结构化产出就跑两条流。
- **农事周历是真的**:面板 calendar / schedule-list 绑 `schedules.mine`,
  定时启用后周历里是真实触发标记,不是装饰。
- **顾问笔记卡**(`content:garden-notes`)由阿同的 `write_panel_content`
  工具写:跟阿同说「把这周农事建议写到面板」,它整理后落卡,卡上固定
  标注出处与更新时间。

## 红线与诚实边界

- **农药/兽药绝不给具体剂量、配比、兑水倍数** —— 一律看产品包装说明、
  问当地农技站/农资店;剧毒禁用农药直接劝阻。人畜疑似误食农药只有一句
  建议:立即就医,带上包装。这条写死在顾问 system prompt 里。
- 顾问没有实时天气/土壤数据,**没有的不编**;天气卡走可选 `weather`
  连接器,不挂时如实显示未接入,面板其余部分照常。
- 建议文本不执行真实动作:真要对外操作(下单买资材等)由挂了连接器的
  agent 逐次过审批闸(接入 ≠ 授权行动)。

## 相关

- 防腐门:`packages/web/tests/agri-assist-template.test.ts`(结构 + 导入
  e2e)+ `packages/host/tests/agri-assist-template.test.ts`(面板 config
  过真 `validatePanelConfig`,quick-actions 只引用包内工作流)
- SDUI 协议:`docs/zh/SDUI-PANEL.md` · 真壳:`docs/zh/APP-SHELL.md`
- 姐妹包:`examples/family-panel-trio`(纯形态)/ `examples/family-hub`(家庭 bundle)
