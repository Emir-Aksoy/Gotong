# smart-home-hub — 智能家居 (小米经 Home Assistant)

一个**小而完整**的智能家居 hub:一个**家居管家**经 Home Assistant 控制你的小米设备,
跑一条「晚安例程」。它演示的不是「能不能控制设备」(Home Assistant 早就能),而是
Gotong 加在上面的那一层 **治理**:

> **可逆的动作直接做,不可逆的物理动作要人确认。**
> 关灯、空调切睡眠 —— 随手可逆,直接做。
> 锁门、布防 —— 可能把人锁在外、是安全决策,挂起等住户在收件箱确认。

这正是北极星「框架只提议,人审阅/确认;凭证、数据各归各家」落到一个家里的样子。

---

## 设备怎么进来(米家 → Home Assistant → Gotong)

```
  小米设备  ──(官方 ha_xiaomi_home 集成)──▶  Home Assistant
                                                  │
                                          (HA「MCP Server」集成, SSE)
                                                  │
                                        mcp-proxy 桥成 stdio
                                                  │
                                                  ▼
                              home-steward 的 tool-use 循环
                     (HassTurnOff / HassClimateSetTemperature / lock.lock / arm …)
```

也就是说:**凡是能进 Home Assistant 的设备,就能连这个 hub。** 不止小米 —— 特斯拉
(HA 官方 Tesla Fleet 集成)、美的(社区 `midea_ac_lan`)、以及任何有 HA 集成的设备
/ 机器人,都能用同一条路接进来。这个模板用小米举例,因为 `ha_xiaomi_home` 是官方
维护、最省心的一条。

---

## 跑一下(确定性,无需 API key / 无需真 Home Assistant / 无需小米账号)

```bash
pnpm demo:smart-home-hub            # 可跑 demo:两个剧情自断言
pnpm demo:smart-home-hub:template   # 载入模板预览(config-preview)
```

`demo:smart-home-hub` 用一个确定性的 home-steward stand-in 服务设备能力,跑两个剧情:

| 剧情 | 发生了什么 |
|---|---|
| **[A] 批准** | 晚安例程 → 客厅/厨房灯关、卧室空调切睡眠(可逆,直接做)→ 跑到「睡前安防确认」**挂起** → 住户在 `/me` 收件箱**批准** → 大门锁、安防布防。 |
| **[B] 拒绝** | 同一条例程(隔天)→ 灯照样关 → 挂起 → 住户**拒绝** → `secure` 步被 `when` 跳过 → **门保持不锁**(fail-closed:拦下一个动作,不外溢到别的)。 |

[B] 是关键:住户拒绝,不可逆的物理动作(锁门/布防)就**真的不发生**,而可逆的关灯照常。

---

## 模版 / 框架分离(这个模板没有 KB 槽位,是有意的)

| 装进模板的 | 不装进模板的 |
|---|---|
| 1 个托管 agent(家居管家)+ 它服务的两条能力 | 你接**哪个** Home Assistant、用**哪个**令牌 → 运行时配置 `${HA_MCP_SSE_URL}` / `${HA_TOKEN}` |
| 1 条声明式工作流(晚安例程,含 `human:` 安防确认步) | 你**有哪些**设备 → Home Assistant 里的实时状态,经 MCP server 拿 |
| Home Assistant MCP server 的**接线**(命令 + ${ENV} 占位) | 令牌的**明文** → 只以环境变量名存在,永不写进模板 |

智能家居的「知识」就是 HA 里的实时设备状态(经 MCP 拿),没有单独的 Obsidian 知识库要
带 —— 所以这个模板**没有 KB 槽位**,比组织模板更小。工作流的步骤只点名 capability
(`home.apply-scene` / `home.secure`),**从不点名某一个设备或某一台 HA** → 换一套设备、
换一个家,工作流一个字不用改。

---

## 对比 cafe-ops 的 `human:` 审批

cafe-ops 的加班审批是「LLM 建议金额,人定钱」;这里是「可逆动作直接做,**不可逆的
物理动作**人确认」。同一个 Phase 16 收件箱机制,落在不同的判断点上:

- cafe-ops:`assess`(助手给建议)→ `manager-approval`(human:)→ 人定。
- smart-home:`wind-down`(可逆,直接做)→ `confirm-lock`(human:)→ `secure`(批准才跑)。

不同的是这里多一道 `when:` 闸 —— 审批要**真能拦住**不可逆的那一步,下一步必须读审批
结果(`when: $confirm-lock.output.approved == true`)。没有它,收件箱里点「拒绝」也只是
把 `{approved:false}` 往下流,门照样锁 = 工作流层 fail-OPEN。

---

## 真接 Home Assistant(可选)

把模板导入真 host(`gotong start` + admin UI →「模板画廊 / 导入」),然后:

1. 在 Home Assistant 装两个官方集成:`ha_xiaomi_home`(接小米设备)+「MCP Server」
   (暴露 `/mcp_server/sse` 端点)。
2. 在 HA 里建一个长期访问令牌。
3. 填运行时配置:`HA_MCP_SSE_URL=http://<你的HA>:8123/mcp_server/sse`、`HA_TOKEN=<令牌>`、
   以及 home-steward 的 DeepSeek key(导入时一次性提示)。

之后 `/me` 里点「跑晚安例程」,锁门那步会落到你的收件箱等你确认。

---

## 安全边界(诚实声明)

- **可逆动作直接做、物理/安防动作要人确认** 是这个 example 的核心立场 —— 但它是
  **运行时接线的 example 代码**(`src/standins.ts` 是确定性替身;真用时是挂了 HA MCP
  server 的 LlmAgent)。把这套闸 fold 进生产 host 是 example-first 的后续(同其它案例)。
- 真接设备时,**`home.secure` 这类不可逆动作必须经 `human:` 闸**;别把它接成无人确认
  的自动步。模板里 home-steward 的 prompt 也明说「不被派到 `home.secure` 时不主动锁门
  布防」。
- 这是个**智能家居控制**示例,不是安防系统认证产品 —— 别拿它当唯一的家庭安防依赖。
