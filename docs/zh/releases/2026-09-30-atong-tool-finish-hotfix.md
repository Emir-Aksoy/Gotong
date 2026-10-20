# Atong 工具终止状态与空消息热修复

方向: 维护。日期按操作者 America/Los_Angeles 时区记为 2026-09-30。

## 现场证据与边界

- 两次 IM 任务均持久化了工具请求，但最终为 `end_turn`、工具执行轮数为零、回复正文为零字节。
- 飞书拒绝空消息，返回 `230001 / invalid message content`，随后 IM 入口发出通用内部错误提示。
- 独立的小请求及工具往返可以成功，因此接口连通性不是完整聊天链路正常的充分证据。
- 合成复现证明 `tool_calls` 终止后附加 `stop` 会覆盖状态，得到上述同形态故障。现场原始 SSE 未保存，不能声称已证实网关具体发出了哪种帧序列。

## 修复

- 完整且合法的工具请求遇到普通 `stop`，仍进入原有工具循环；后续空终止帧不能覆盖工具意图。
- `error` / `max_tokens` 保持阻断，不提升为可执行调用。
- 拒绝缺失 ID/name、重复 ID、同一 index 的身份变化、空/缺失/非对象参数、终止后的新增工具数据、EOF 残留工具缓冲。
- 原有审批逻辑不变。新增复现覆盖同 ID 不同参数导致审批判定覆盖的风险，要求零执行。
- IM 空白正文改为明确的未生成回复提示，记录不含正文的诊断；不自动重试，不合成语音，窗口记录与发出的提示一致。
- 不改模型分工、provider 地址、凭据或真实用户记忆；不重放失败的用户请求。

## 验证

- 修前新增用例已观察到 `end_turn` 覆盖、空消息拒发，以及重复 ID 导致两次执行；修后均通过。
- `llm-openai`: 95 passed，2 个既有 live 测试跳过。
- `personal-butler`: 428 passed。
- IM、会话窗口、断供提示、审批专项: 60 passed。
- Host 全量最终复跑: 3737 passed，31 skipped，2 failed；两项均为 `personal-butler-coder` 的本地子进程用例，在提取的未修改 HEAD 源码基线上复现相同失败，不表述为全量全绿。
- 两包构建、Host 类型检查、四项仓库 guard、`git diff --check` 通过。

## 发布状态

- 服务器部署于 `2026-10-01T01:07:50.667Z` 完成。运行状态为基线 `64aba60e` 加本次四文件热补丁，尚未 commit / push GitHub；不是新的 Git 提交版本。
- 现场 provider 与 Host 构建、provider 95 项测试、IM/审批专项 60 项测试通过。
- `fast` / `thinking` 分别通过真实模型调用、一次无副作用测试工具执行、真实阿同工具循环、IM 路由及飞书文本消息序列化验证，结果均为 `PROBE_OK`。飞书客户端在发送边界被测试客户端替换，未实际向飞书投递，不能视作真实飞书收发验收。
- `/healthz`、`/readyz` 均为 200；Gotong 与 watchdog active，`NRestarts=0`。重启后日志统计 error=0，warn=1；不宣称无警告。
- 模型配置及加密凭据文件指纹未变；nanobot / nginx 进程 ID 未变；未操作真实用户记忆或重放历史请求。
- 私有部署证据及回滚包: `/home/ubuntu/gotong-deployments/im-tool-finish-2026-10-01T01-06-59.647Z/`，包含 `result.json`、构建/测试日志和 `rollback.tgz`。
- 四文件部署包 SHA-256: `860fb3bdb871b7b9106d22089ca1d063c8ed7dd43b0e91c0af7c44faafb7afc1`。
- 首次打包包含 macOS 元数据，部署前精确文件列表检查拒绝该包；当时未停止服务或修改服务器源码。去除元数据重新打包后部署成功。
- 2026-10-20 入库：四个文件与服务器 `/opt/gotong` 上的补丁逐字节一致（逐文件 SHA-256 核对），以独立提交进入 `main`，随生活档案一起以 bundle 部署。

实际飞书收发验收仍需用户发送一条新的普通消息或只读工具请求确认；涉及外发、付款或修改的旧请求不自动重试。

## 后续配置切换：全部 Thinking

- 用户反馈仍无响应，并要求 Atong 所有任务改用同一 provider 的 `thinking`。本次仅执行指定配置切换，不将其表述为已证明解决无响应。
- `2026-10-01T01:19:12.884Z` 完成：`assistant.managed.model`、`maintenanceModel`、`longRunModels.compactor.model` 从 `fast` 改为 `thinking`；长任务 synthesizer 与 expert 本来已为 `thinking`。五个入口现均为 `thinking`。
- provider 地址保持 `https://ai.ultarbrothers.online:8443/v1`，凭据及所有其他配置字段不变；独立的 `alpha-capital` 保持原样。未修改产品源码，未提交或推送 GitHub。
- 私有原配置备份和验证结果在 `/home/ubuntu/gotong-deployments/all-thinking-2026-10-01T01-18-54.109Z/`；精确结构比较确认只修改上述三个字段。
- 重启后主对话与专家入口分别通过真实 `thinking` 模型、一次无副作用测试工具执行、IM 路由与飞书消息格式验证；未实际向飞书投递。未触发真实用户的记忆整理或长任务，二者仅核验配置。
- health / ready 均为 200，Gotong / watchdog active，NRestarts=0；nanobot / nginx 进程未变。
- 切换前半小时日志未发现 error；唯一 warn 是既有 `workflow-assistant: no API key resolved`，未据此认定本次无响应原因。实际飞书收发仍待确认。

## 后续配置切换：关闭自动语音回复

- 用户确认先恢复纯文字，保留语音接收/识别。此前“五个模型入口全部 thinking”仅覆盖文字推理与记忆/长任务槽；独立 TTS 仍是 `mimo-v2.5-tts` / 冰糖，ASR 仍是 `mimo-v2.5-asr`，不应表述为所有模态模型均已替换。
- `2026-10-01T01:45:23.700Z` 完成：通过既有 `applyEnvKnob` 将非秘密配置 `GOTONG_BUTLER_VOICE_MODEL` 显式清空。只有该字段变化；不改共享语音 URL/key、ASR、vision、agents.json 或用户记忆。
- 重启后用实际进程环境及托管配置核验：`butlerVoiceFromEnv` 为 undefined，`butlerHearingFromEnv` 仍已构造；本次启动日志有语音收听披露，无语音回复披露。原有 IM 分支在无 voice 时发送文字，不合成音频。
- health / ready 均为 200，Gotong / watchdog active，NRestarts=0；nanobot / nginx 进程未变。未实际向飞书发测试消息，真实收发待用户确认；未诊断或声称修复原语音内容混乱的具体原因。
- 私有配置备份和验证结果：`/home/ubuntu/gotong-deployments/text-replies-2026-10-01T01-45-16.367Z/`。未修改产品源码，未 commit / push GitHub。

## 恢复自动语音回复

- 用户反馈模型侧问题已解决，明确要求恢复语音；此为用户反馈，不代表本次独立验证了原故障原因。
- `2026-10-01T01:53:00.682Z` 已恢复：从上次私有备份取得原语音模型，经既有配置入口将 `GOTONG_BUTLER_VOICE_MODEL` 恢复为 `mimo-v2.5-tts`，音色保持“冰糖”。只恢复这一字段，不覆盖整份历史配置。
- 重启后语音输出与语音识别均已启用，启动日志分别确认两者；agents.json、其他配置与凭据未变。health / ready 均为 200，Gotong / watchdog active，NRestarts=0，共享服务进程未变。
- 备份与验证结果：`/home/ubuntu/gotong-deployments/restore-voice-2026-10-01T01-52-53.373Z/`。未实际向飞书投递测试语音，未修改产品源码或推送 GitHub。本节覆盖前节的语音关闭状态。

## 后续配置切换：alpha-capital 改用网关 fast

- 用户发现 `mimo-v2.5` 仍有用量。用量账本显示近 7 天的 `mimo-v2.5` 调用全部来自 `alpha-capital`，由工作日 `alpha-daily-brief` 与周末 `alpha-weekend-industry` 两个 08:00 定时工作流触发；同期没有成员发图，看图通道未产生用量。用户要求把 `alpha-capital` 切到网关 `fast`。
- `2026-10-06T14:17:21Z` 完成：`alpha-capital.managed` 的 `model` 改为 `fast`、`baseURL` 改为 `https://ai.ultarbrothers.online:8443/v1`、`providerLabel` 改为 `Atong Gateway`，并去掉 `apiKeyEnv: MIMO_API_KEY`；其余字段（含 tavily 联网）不变。
- 凭据：经用户同意，把凭据库里 `assistant` 名下的网关密文原样复制给 `alpha-capital`，未解密、未显示。组织 key 池为空，若解密失败该 agent 会启动失败而不会改用其他 key。
- 结构比较确认：`agents.json` 只变上述四个字段；凭据库只新增 `alpha-capital` 一条，密文与 `assistant` 逐字段相同（`updatedAt` 除外），其余条目不变。两文件权限保持 600。
- 重启后 health 200，三个 agent 均已启动，7 个 sweep 就绪，自愈台账为干净启动；唯一 warn 仍是既有 `workflow-assistant: no API key resolved`。未手动触发简报工作流，真实调用以下一次 08:00 定时运行为准。
- 仍连 MiMo 的通道：看图（`mimo-v2.5`，仅在成员发图时调用）、语音回复（`mimo-v2.5-tts`）、语音转写（`mimo-v2.5-asr`）。
- 备份与核对结果：`/home/ubuntu/gotong-deployments/alpha-fast-2026-10-06T14-17-21Z/`。未修改产品源码，未 commit / push GitHub。
