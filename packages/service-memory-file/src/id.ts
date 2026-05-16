/**
 * Memory entry id generation.
 *
 * Format: `<timestamp36>-<random6>` (e.g. `lpw9pmqf-1k4m9q`).
 *   - `timestamp36`: base-36 epoch ms, 8-9 chars, sortable
 *   - `random6`: 6 chars from a base-36 alphabet
 *
 * Sortable-by-creation is a feature: scanning the jsonl in reverse
 * gives newest-first without parsing the `ts` field. Length stays under
 * 20 chars so admin UI columns stay narrow.
 *
 * Random suffix size: 6 chars from a 36-character alphabet gives
 * 2,176,782,336 unique ids per millisecond. The plugin's per-owner
 * write queue serializes calls, so two `remember` calls within the
 * same ms within the same owner is impossible — collisions are only
 * a concern if two hosts share the same owner directory, which is
 * out of scope for the file backend.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const SUFFIX_LEN = 6

/** Generate a new entry id. `nowMs` is injectable for tests. */
export function generateEntryId(nowMs: number): string {
  const ts = Math.max(0, Math.floor(nowMs)).toString(36).padStart(8, '0')
  let suffix = ''
  for (let i = 0; i < SUFFIX_LEN; i++) {
    suffix += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  }
  return `${ts}-${suffix}`
}

/** True iff `id` looks like a {@link generateEntryId} output. Used for forget(). */
export function looksLikeEntryId(id: string): boolean {
  return /^[a-z0-9]{8,}-[a-z0-9]{6}$/.test(id)
}
