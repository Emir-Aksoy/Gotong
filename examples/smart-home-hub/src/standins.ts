/**
 * Deterministic stand-in for the smart-home-hub runnable demo.
 *
 * In the loadable template the home capabilities are served by a KB-... no — by a
 * managed `LlmAgent` (家居管家 / home-steward) that has the Home Assistant MCP
 * server attached. When dispatched a task it uses its tool-use loop to call HA
 * tools (HassTurnOff / HassClimateSetTemperature / lock.lock / alarm arm) which
 * HA in turn routes to your **Xiaomi devices** through the official ha_xiaomi_home
 * integration (米家设备 → Home Assistant → HA MCP Server → AipeHub).
 *
 * Here we substitute a deterministic stand-in that serves the SAME capabilities
 * against a tiny in-memory device table — so the demo runs with no API key, no
 * Home Assistant, and no Xiaomi account, while the hub wiring (a workflow step
 * dispatches a capability, a participant answers) is identical to production.
 * Swap this for the real home-steward LlmAgent + HA MCP server and nothing in the
 * workflow YAML or the hub changes.
 *
 * The point the demo makes: a reversible action (turn lights off, set the AC)
 * fires directly; a physical / security action (lock the door, arm the alarm) is
 * held behind a `human:` confirmation — because locking up is not free to undo
 * (it can lock someone out), and arming/disarming is a security decision. That is
 * the AipeHub governance thesis applied to a home: 提议直接做的可逆动作, 人确认
 * 不可逆的物理动作.
 */

import { AgentParticipant, type Task } from '@aipehub/core'

/** A Xiaomi device as it appears in Home Assistant (entity_id + a little state). */
type Device =
  | { kind: 'light'; name: string; on: boolean }
  | { kind: 'climate'; name: string; mode: string; temp: number }
  | { kind: 'lock'; name: string; locked: boolean }
  | { kind: 'alarm'; name: string; armed: boolean }

/** The home as HA would expose it — a handful of 米家 devices behind ha_xiaomi_home. */
function freshHome(): Record<string, Device> {
  return {
    'light.living_room': { kind: 'light', name: '客厅灯', on: true },
    'light.kitchen': { kind: 'light', name: '厨房灯', on: true },
    'climate.bedroom_ac': { kind: 'climate', name: '卧室空调', mode: 'cool', temp: 24 },
    'lock.front_door': { kind: 'lock', name: '大门锁', locked: false },
    'alarm_control_panel.home': { kind: 'alarm', name: '家庭安防', armed: false },
  }
}

/**
 * Serves `home.apply-scene` (reversible) and `home.secure` (physical/security).
 *
 * Stands in for the home-steward LlmAgent calling HA MCP tools. Money has no part
 * here, but the same principle as cafe-ops applies: the deterministic action is
 * done by code we can assert, not by an LLM guessing — and the irreversible one
 * waits for a human.
 */
export class HomeStewardStandin extends AgentParticipant {
  /** Live device state — the demo asserts against this (the door locked or not). */
  readonly devices: Record<string, Device> = freshHome()

  constructor() {
    super({ id: 'home-steward', capabilities: ['home.apply-scene', 'home.secure'] })
  }

  /** Simulate "the next day" — devices return to their daytime state. */
  resetToDaytime(): void {
    Object.assign(this.devices, freshHome())
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const cap = task.strategy?.kind === 'capability' ? task.strategy.capabilities?.[0] : undefined
    if (cap === 'home.secure') return this.secure(task)
    return this.applyScene(task)
  }

  /**
   * `home.apply-scene` — reversible comfort actions. The home-steward would call
   * HA `HassTurnOff` on the lights and `HassClimateSetTemperature` on the AC; we
   * mutate the device table the same way and report exactly what changed.
   */
  private applyScene(task: Task): unknown {
    const { scene } = (task.payload ?? {}) as { scene?: string }
    const actions: string[] = []
    // 晚安场景: 关掉公共区域的灯, 把卧室空调切到睡眠温度 (26°C) —— 都可逆。
    for (const id of ['light.living_room', 'light.kitchen']) {
      const d = this.devices[id]
      if (d?.kind === 'light' && d.on) {
        d.on = false
        actions.push(`关闭 ${d.name}`)
      }
    }
    const ac = this.devices['climate.bedroom_ac']
    if (ac?.kind === 'climate') {
      ac.mode = 'sleep'
      ac.temp = 26
      actions.push(`${ac.name} → 睡眠模式 26°C`)
    }
    return {
      scene: scene ?? 'goodnight',
      reversible: true,
      actions,
      note: `已执行可逆动作 (${actions.length} 项): ${actions.join('、')}。`,
    }
  }

  /**
   * `home.secure` — the physical / security action. Only reached AFTER the human
   * approval step in the workflow. The home-steward would call HA `lock.lock` and
   * `alarm_control_panel.alarm_arm_away`; if this never runs (the resident
   * rejected), the door simply stays unlocked — fail-closed.
   */
  private secure(_task: Task): unknown {
    const actions: string[] = []
    const lock = this.devices['lock.front_door']
    if (lock?.kind === 'lock' && !lock.locked) {
      lock.locked = true
      actions.push(`锁好 ${lock.name}`)
    }
    const alarm = this.devices['alarm_control_panel.home']
    if (alarm?.kind === 'alarm' && !alarm.armed) {
      alarm.armed = true
      actions.push(`${alarm.name} → 布防`)
    }
    return {
      secured: true,
      actions,
      note: `已执行安防动作 (经你确认): ${actions.join('、')}。`,
    }
  }
}
