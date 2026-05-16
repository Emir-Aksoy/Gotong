/**
 * Tiny extension → mime guesser. Intentionally short: agents most
 * commonly write `.md`, `.json`, `.txt`, `.csv`, and occasionally
 * images. For anything unrecognised the caller's `opts.mime` wins.
 *
 * Not pulling a dep (`mime-types`) for ~12 extensions.
 */

const TABLE: Readonly<Record<string, string>> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
}

const DEFAULT_MIME = 'application/octet-stream'

/**
 * Guess the mime from a relative path's extension. Always returns
 * a string — falls back to `application/octet-stream`.
 *
 *   guessMime('reports/q1.md')         → 'text/markdown'
 *   guessMime('data.csv')              → 'text/csv'
 *   guessMime('weird.zzz')             → 'application/octet-stream'
 */
export function guessMime(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return DEFAULT_MIME
  const ext = path.slice(dot).toLowerCase()
  return TABLE[ext] ?? DEFAULT_MIME
}
