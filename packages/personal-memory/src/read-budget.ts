import { AsyncLocalStorage } from 'node:async_hooks'

export const MEMORY_READ_BYTES = 6000
export const MEMORY_READ_PAGE_BYTES = 2000

/**
 * Budget covers new memory payload per execution, not fixed control/error messages.
 *
 * The two sizes default to the memory lane's numbers; other bounded read lanes
 * (LIFE dossiers) construct their own instance with their own sizes so the two
 * lanes never crowd each other out.
 */
export class MemoryReadBudget {
  private readonly scope = new AsyncLocalStorage<{ id: string; left: number; seen: Set<string> }>()

  constructor(
    readonly totalBytes: number = MEMORY_READ_BYTES,
    readonly pageBytes: number = MEMORY_READ_PAGE_BYTES,
  ) {}

  runForTask<T>(task: { id: string }, fn: () => Promise<T>): Promise<T> {
    if (this.scope.getStore()?.id === task.id) return fn()
    return this.scope.run({ id: task.id, left: this.totalBytes, seen: new Set() }, fn)
  }

  remaining(): number { return this.scope.getStore()?.left ?? this.pageBytes }
  seen(key: string): boolean { return this.scope.getStore()?.seen.has(key) ?? false }

  consume(text: string, key?: string): boolean {
    const bytes = Buffer.byteLength(text, 'utf8')
    const state = this.scope.getStore()
    if (bytes > this.pageBytes || bytes > this.remaining() || (key && this.seen(key))) return false
    if (state) {
      state.left -= bytes
      if (key) state.seen.add(key)
    }
    return true
  }
}

/** Code-point-safe UTF-8 prefix; never invent a replacement character at a boundary. */
export function utf8Prefix(text: string, bytes: number): string {
  let out = ''
  let used = 0
  for (const c of text) {
    const n = Buffer.byteLength(c, 'utf8')
    if (used + n > bytes) break
    out += c
    used += n
  }
  return out
}
