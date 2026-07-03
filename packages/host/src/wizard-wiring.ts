/**
 * wizard-wiring.ts — WIZ-M4. 把建流向导接到活 hub 上的装配胶水：五个活源 →
 * `CatalogInputs` → `WorkflowWizardService`。
 *
 * 为什么单独成文件而不写进 main.ts：目录聚合有真实逻辑（五源投影 + 模板卡片
 * 降维 + 逐源容错），main.ts 有行数预算棘轮（GUARD-M2），装配逻辑能下沉就
 * 下沉——main.ts 只留「把活对象递进来」的几行。
 *
 * 依赖全鸭子（host 纪律）：真实来源分别是 hub.participants() /
 * space.mcpServers() / RES-M1 resourceInventory.inventory() / web 模板画廊的
 * 卡片投影（与安装路径同一 parseTemplate，预览不会漂）/ BUILTIN_MCP_CONNECTORS。
 * light fake 可单测，不拉起 hub / LLM / 磁盘。
 *
 * 逐源容错：单个源抛错只丢那一角（目录宁缺一角，不整体不可用）——资源探测
 * 挂了不该让「用已有 agent 搭流」也跟着 503。
 */

import { buildComponentCatalog, type CatalogInputs, type ComponentEntry } from './component-catalog.js'
import { WorkflowWizardService, type WizardAssistView } from './workflow-wizard.js'

// ── 五源的鸭子投影 ──────────────────────────────────────────────────────────

export interface WizardCatalogSources {
  /** hub.participants() —— 人和 agent 同列（kind 由 Participant 自带）。 */
  participants: () => ReadonlyArray<{ id: string; kind: string; capabilities: readonly string[] }>
  /** space.mcpServers() —— 已装 MCP 注册表行。 */
  mcpServers: () => Promise<ReadonlyArray<{ spec: { name: string; description?: string } }>>
  /** RES-M1 探测（只读零 LLM；行形状与 CatalogInputs.resources 同构）。 */
  inventory: () => Promise<{
    llmKeys: ReadonlyArray<{ provider: string; envSet: boolean; vaultConfigured: boolean }>
    localEndpoints: ReadonlyArray<{ label: string; url: string; reachable: boolean }>
    cliAgents: ReadonlyArray<{ command: string; label: string; found: boolean }>
  }>
  /** web 模板画廊卡片（buildTemplateCatalog 的投影——带逐 agent 能力集）。 */
  templateCards: () => ReadonlyArray<{
    id: string
    name?: string
    description?: string
    agents?: ReadonlyArray<{ id: string; displayName?: string; capabilities: readonly string[] }>
  }>
  /** BUILTIN_MCP_CONNECTORS 的投影（specName 用于已装去重）。 */
  connectors: () => ReadonlyArray<{
    id: string
    name: string
    whatFor?: string
    needsEnv?: readonly string[]
    spec: { name: string }
  }>
}

/**
 * 五源 → CatalogInputs。逐源 best-effort：抛错的源按空处理，绝不整体失败。
 * 模板卡片的 agent 用 displayName 优先作「名字」——那是给人看的名，装后的
 * participant id 由安装路径分配（缺口补法的措辞已按此写诚实话术）。
 */
export async function collectCatalogInputs(src: WizardCatalogSources): Promise<CatalogInputs> {
  const participants = tryOr(() => src.participants(), [])
  const mcpRows = await tryOrAsync(() => src.mcpServers(), [])
  const inv = await tryOrAsync(() => src.inventory(), null)
  const cards = tryOr(() => src.templateCards(), [])
  const connectors = tryOr(() => src.connectors(), [])

  return {
    participants: participants.map((p) => ({
      id: p.id,
      kind: p.kind,
      capabilities: [...p.capabilities],
    })),
    installedMcpServers: mcpRows.map((r) => ({
      name: r.spec.name,
      ...(r.spec.description ? { description: r.spec.description } : {}),
    })),
    ...(inv
      ? {
          resources: {
            llmKeys: inv.llmKeys.map((k) => ({
              provider: k.provider,
              envSet: k.envSet,
              vaultConfigured: k.vaultConfigured,
            })),
            localEndpoints: inv.localEndpoints.map((e) => ({
              label: e.label,
              url: e.url,
              reachable: e.reachable,
            })),
            cliAgents: inv.cliAgents.map((c) => ({
              command: c.command,
              label: c.label,
              found: c.found,
            })),
          },
        }
      : {}),
    presetTemplates: cards.map((t) => ({
      id: t.id,
      ...(t.name ? { name: t.name } : {}),
      ...(t.description ? { description: t.description } : {}),
      agents: (t.agents ?? []).map((a) => ({
        name: a.displayName ?? a.id,
        capabilities: [...a.capabilities],
      })),
    })),
    presetConnectors: connectors.map((c) => ({
      id: c.id,
      name: c.name,
      ...(c.whatFor ? { whatFor: c.whatFor } : {}),
      specName: c.spec.name,
      ...(c.needsEnv && c.needsEnv.length > 0 ? { needsEnv: [...c.needsEnv] } : {}),
    })),
  }
}

// ── service 工厂 ────────────────────────────────────────────────────────────

export interface CreateWorkflowWizardDeps {
  /** Phase 13 assist 面（真 WorkflowAssistSurface 结构满足）。 */
  assist: WizardAssistView
  sources: WizardCatalogSources
  /** 已有工作流 id（防撞提示用，best-effort）。 */
  existingWorkflowIds?: () => Promise<ReadonlyArray<string>>
  maxRepairRounds?: number
}

/**
 * 组一个接到活源上的向导 service。目录每次调用现聚合——组件目录必须反映当下
 * 事实（新 spawn 的 agent / 刚装的 MCP 下一次 prepare 就要在场）。
 */
export function createWorkflowWizard(deps: CreateWorkflowWizardDeps): WorkflowWizardService {
  return new WorkflowWizardService({
    assist: deps.assist,
    catalog: async (): Promise<ReadonlyArray<ComponentEntry>> =>
      buildComponentCatalog(await collectCatalogInputs(deps.sources)),
    ...(deps.existingWorkflowIds
      ? { existingWorkflowIds: () => tryOrAsync(() => deps.existingWorkflowIds!(), []) }
      : {}),
    ...(deps.maxRepairRounds !== undefined ? { maxRepairRounds: deps.maxRepairRounds } : {}),
  })
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

function tryOr<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

async function tryOrAsync<T>(fn: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}
