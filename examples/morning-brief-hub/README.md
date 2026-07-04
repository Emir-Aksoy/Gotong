# 我的晨报 — 定时工作流开箱包

「让 hub 每天替我干活」的第一个开箱案例（LIFE-L2①）：每天早上 8 点，hub 替你跑一份
中文晨报，跑完由管家播到你的 IM。**调度环零 LLM**——唤醒/判定/派发全程确定性，模型
只在晨报工作流自己的步骤里跑。

```
每天 08:00（你的时区）
   │  调度 sweep（零 LLM，走与 /me「运行」完全同一道成员闸）
   ▼
morning-brief 工作流 → 晨报员(LLM) 写晨报
   ▼
run 归属你本人 → 管家运行播报（零 LLM）→ 你的 IM
```

## 装（三步）

1. **装模板**：admin →「工作流」→「模板画廊」→「我的晨报」→ 安装（提示填一次
   DeepSeek key）。或 curl 导入，见 [template/morning-brief-hub.template.yaml](template/morning-brief-hub.template.yaml) 文件头。
2. **建调度**：admin →「工作流」→「定时」卡新建（选 morning-brief + 成员 + 每天 8 点），或：
   ```bash
   curl -X POST -H "Authorization: Bearer <admin-token>" -H 'content-type: application/json' \
     -d '{"workflowId":"morning-brief","userId":"<成员id>","cadence":{"kind":"daily","hour":8},"enabled":true}' \
     http://127.0.0.1:8745/api/admin/workflow-schedules
   ```
   验收不想等明早：`POST /api/admin/workflow-schedules/<调度id>/fire` 立即试跑。
3. **开播报**（每成员默认关）：在 IM 里对管家说「打开运行播报」。

## 晨报的「料」

开箱状态晨报员基于 focus 主题按常识展开（诚实模式：拿不到你的日程就不会编造）。要读
真实日历 / 笔记，给晨报员挂对应 MCP server（运行时配置，模板不写死）——见
[docs/zh/MCP-CONNECTOR-DIRECTORY.md](../../docs/zh/MCP-CONNECTOR-DIRECTORY.md)。

## 细节

调度文件格式 / 三种 cadence / 失败姿态 / API 全览：
[docs/zh/WORKFLOW-SCHEDULES.md](../../docs/zh/WORKFLOW-SCHEDULES.md)
