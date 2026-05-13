import type { Participant, ParticipantId, ParticipantKind } from './types.js'

/**
 * Registry tracks who is online, what they can do, and how loaded they are.
 * It is intentionally synchronous and in-memory — the persistent layer (Storage)
 * holds a *journal* of join/leave events, not the live runtime state.
 */

export interface RegistryEvents {
  onJoin: (handler: (p: Participant) => void) => () => void
  onLeave: (handler: (id: ParticipantId) => void) => () => void
}

export class Registry implements RegistryEvents {
  private participants = new Map<ParticipantId, Participant>()
  private load = new Map<ParticipantId, number>()
  private joinHandlers: Array<(p: Participant) => void> = []
  private leaveHandlers: Array<(id: ParticipantId) => void> = []

  register(p: Participant): void {
    if (this.participants.has(p.id)) {
      throw new Error(`participant ${p.id} already registered`)
    }
    this.participants.set(p.id, p)
    this.load.set(p.id, 0)
    for (const h of this.joinHandlers) {
      try {
        h(p)
      } catch (err) {
        console.error('[registry] join handler threw:', err)
      }
    }
  }

  unregister(id: ParticipantId): Participant | undefined {
    const p = this.participants.get(id)
    if (!p) return undefined
    this.participants.delete(id)
    this.load.delete(id)
    for (const h of this.leaveHandlers) {
      try {
        h(id)
      } catch (err) {
        console.error('[registry] leave handler threw:', err)
      }
    }
    return p
  }

  get(id: ParticipantId): Participant | undefined {
    return this.participants.get(id)
  }

  has(id: ParticipantId): boolean {
    return this.participants.has(id)
  }

  all(): Participant[] {
    return [...this.participants.values()]
  }

  byKind(kind: ParticipantKind): Participant[] {
    return this.all().filter((p) => p.kind === kind)
  }

  /**
   * Returns participants whose capabilities cover every required capability.
   * Empty `required` matches everyone.
   */
  byCapabilities(required: readonly string[]): Participant[] {
    if (required.length === 0) return this.all()
    return this.all().filter((p) => {
      const caps = new Set(p.capabilities)
      return required.every((c) => caps.has(c))
    })
  }

  incLoad(id: ParticipantId): void {
    this.load.set(id, (this.load.get(id) ?? 0) + 1)
  }

  decLoad(id: ParticipantId): void {
    const cur = this.load.get(id) ?? 0
    this.load.set(id, Math.max(0, cur - 1))
  }

  loadOf(id: ParticipantId): number {
    return this.load.get(id) ?? 0
  }

  onJoin(handler: (p: Participant) => void): () => void {
    this.joinHandlers.push(handler)
    return () => {
      const i = this.joinHandlers.indexOf(handler)
      if (i >= 0) this.joinHandlers.splice(i, 1)
    }
  }

  onLeave(handler: (id: ParticipantId) => void): () => void {
    this.leaveHandlers.push(handler)
    return () => {
      const i = this.leaveHandlers.indexOf(handler)
      if (i >= 0) this.leaveHandlers.splice(i, 1)
    }
  }
}
