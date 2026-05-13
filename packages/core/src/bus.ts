import { createLogger } from './logger.js'
import type { ChannelId, Message, ParticipantId } from './types.js'

const log = createLogger('bus')

/**
 * MessageBus owns the pub/sub graph (who subscribed to which channel) and
 * the dispatch loop. It does NOT know what a Participant is; the Hub injects
 * a `deliver` callback that knows how to actually invoke a participant's
 * onMessage. This keeps the bus a pure routing primitive.
 *
 * Delivery is asynchronous and per-subscriber isolated: one slow or throwing
 * subscriber cannot block or break delivery to the others. The sender does
 * not receive its own message back (no echo).
 */

export type Deliverer = (recipientId: ParticipantId, msg: Message) => void | Promise<void>

export class MessageBus {
  private subs = new Map<ChannelId, Set<ParticipantId>>()
  private publishObservers: Array<(msg: Message) => void> = []

  constructor(private readonly deliver: Deliverer) {}

  subscribe(participantId: ParticipantId, channel: ChannelId): void {
    let set = this.subs.get(channel)
    if (!set) {
      set = new Set()
      this.subs.set(channel, set)
    }
    set.add(participantId)
  }

  unsubscribe(participantId: ParticipantId, channel: ChannelId): void {
    const set = this.subs.get(channel)
    if (!set) return
    set.delete(participantId)
    if (set.size === 0) this.subs.delete(channel)
  }

  unsubscribeAll(participantId: ParticipantId): void {
    for (const [channel, set] of this.subs) {
      set.delete(participantId)
      if (set.size === 0) this.subs.delete(channel)
    }
  }

  subscribersOf(channel: ChannelId): ParticipantId[] {
    const set = this.subs.get(channel)
    return set ? [...set] : []
  }

  channels(): ChannelId[] {
    return [...this.subs.keys()]
  }

  /**
   * Publish a message. Observers are notified synchronously so the transcript
   * preserves causal order; subscribers are notified asynchronously and
   * independently.
   */
  publish(msg: Message): void {
    for (const obs of this.publishObservers) {
      try {
        obs(msg)
      } catch (err) {
        log.error('publish observer threw', { err })
      }
    }

    const subs = this.subs.get(msg.channel)
    if (!subs || subs.size === 0) return

    for (const sid of subs) {
      if (sid === msg.from) continue
      queueMicrotask(() => {
        try {
          const r = this.deliver(sid, msg)
          if (r && typeof (r as Promise<unknown>).catch === 'function') {
            ;(r as Promise<unknown>).catch((err) => {
              log.error('delivery failed', { to: sid, err })
            })
          }
        } catch (err) {
          log.error('delivery threw', { to: sid, err })
        }
      })
    }
  }

  onPublish(handler: (msg: Message) => void): () => void {
    this.publishObservers.push(handler)
    return () => {
      const i = this.publishObservers.indexOf(handler)
      if (i >= 0) this.publishObservers.splice(i, 1)
    }
  }
}
