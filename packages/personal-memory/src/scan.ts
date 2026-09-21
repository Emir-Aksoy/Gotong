import type { MemoryEntry, MemoryHandle } from '@gotong/services-sdk'
import { PersonalMemoryError } from './errors.js'

/** A UI page is never a substitute for a complete maintenance inventory. */
export async function scanMemory(memory: MemoryHandle): Promise<MemoryEntry[]> {
  if (!memory.scan) throw new PersonalMemoryError('scan_unavailable', 'Complete memory scan is required; maintenance was not performed')
  return memory.scan()
}
