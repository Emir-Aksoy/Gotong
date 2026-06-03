/**
 * monitoring-config.test.ts — Route B P0-M7-M2.
 *
 * The one-click monitoring stack (`monitoring/`) is config, not code — there's
 * no `promtool`/`amtool` in CI to lint it, and a broken cross-file reference
 * (a renamed scrape job, a severity with no route, a route pointing at a
 * receiver that doesn't exist) fails SILENTLY at deploy time: the stack starts,
 * but alerts vanish into the void. This test is the lint: it parses the YAML
 * and pins the wiring invariants that make the stack actually deliver alerts.
 *
 * The monitoring/ files ARE the deliverable under test — this never edits them.
 * Every assertion maps to a real failure mode an operator would otherwise hit
 * only during an incident:
 *   - scrape job `aipehub` must hit the non-admin /metrics route with auth
 *     (P0-M7-M1) — a regression back to /api/admin/metrics reintroduces the
 *     machine-admin friction this milestone removed;
 *   - alert rules reference `job="aipehub"` and `job="node"` — both must exist
 *     as scrape jobs or the alert expr is dead;
 *   - every `severity` an alert stamps (`page`/`ticket`) must have an
 *     Alertmanager route, and every route must target a declared receiver —
 *     else the page never reaches anyone;
 *   - the rule file Prometheus loads must be the one on disk;
 *   - docker-compose must mount the config files that exist.
 *
 * Falsifiable end-to-end: flip metrics_path back to the admin route, or drop
 * the `ticket` Alertmanager route, or rename a job — the matching `it` goes
 * red. (Verified by neutralising each, then reverting.)
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const monDir = join(repoRoot, 'monitoring')

function readMon(...parts: string[]): string {
  return readFileSync(join(monDir, ...parts), 'utf8')
}
function loadYaml(...parts: string[]): any {
  return parseYaml(readMon(...parts))
}

// --- the artefacts under test ------------------------------------------------
const prom = loadYaml('prometheus', 'prometheus.yml')
const alerts = loadYaml('prometheus', 'aipehub.alerts.yml')
const am = loadYaml('alertmanager', 'alertmanager.yml')
const compose = loadYaml('docker-compose.yml')
const alertsRaw = readMon('prometheus', 'aipehub.alerts.yml')

// scrape jobs declared in prometheus.yml
const scrapeJobs: string[] = (prom.scrape_configs ?? []).map((s: any) => s.job_name)
const aipehubJob = (prom.scrape_configs ?? []).find((s: any) => s.job_name === 'aipehub')

// `job="..."` literals referenced inside alert expressions
const jobRefs = new Set(
  [...alertsRaw.matchAll(/job\s*=\s*"([^"]+)"/g)].map((m) => m[1]),
)

// every severity an alert rule stamps
const severities = new Set<string>()
for (const g of alerts.groups ?? []) {
  for (const r of g.rules ?? []) {
    if (r.labels?.severity) severities.add(String(r.labels.severity))
  }
}

// flatten the Alertmanager route tree → [{matchers, receiver}]
interface AmRoute { matchers?: string[]; match?: Record<string, string>; receiver?: string; routes?: AmRoute[] }
function flattenRoutes(root: AmRoute | undefined): AmRoute[] {
  const out: AmRoute[] = []
  const walk = (n?: AmRoute) => {
    if (!n) return
    out.push(n)
    for (const child of n.routes ?? []) walk(child)
  }
  walk(root)
  return out
}
const amRoutes = flattenRoutes(am.route)
const amReceivers = new Set<string>((am.receivers ?? []).map((r: any) => String(r.name)))

/** Does some route select `severity=<value>` (string-matcher or legacy match)? */
function severityHasRoute(sev: string): boolean {
  return amRoutes.some((r) => {
    const fromMatchers = (r.matchers ?? []).some(
      (m) => m.replace(/\s/g, '') === `severity="${sev}"` || m.replace(/\s/g, '') === `severity=${sev}`,
    )
    const fromMatch = r.match?.severity === sev
    return fromMatchers || fromMatch
  })
}

describe('Route B P0-M7-M2 — monitoring stack is internally wired', () => {
  it('aipehub scrape job hits the non-admin /metrics route WITH bearer auth', () => {
    expect(aipehubJob).toBeTruthy()
    // P0-M7-M1 route — NOT /api/admin/metrics (that needs a machine admin).
    expect(aipehubJob.metrics_path).toBe('/metrics')
    // Auth must be present — an anonymous metrics scrape would be a leak.
    expect(typeof aipehubJob.bearer_token_file).toBe('string')
    expect(aipehubJob.bearer_token_file.length).toBeGreaterThan(0)
  })

  it('every job referenced by an alert expr exists as a scrape job', () => {
    // `up{job="aipehub"}`, `node_..{job="node"}` — a typo here = a dead alert.
    expect(jobRefs.size).toBeGreaterThan(0)
    for (const job of jobRefs) {
      expect(scrapeJobs, `alert references job="${job}" with no scrape job`).toContain(job)
    }
  })

  it('Prometheus loads the alert-rules file that exists on disk', () => {
    const ruleFiles: string[] = prom.rule_files ?? []
    expect(ruleFiles.some((f) => f.endsWith('aipehub.alerts.yml'))).toBe(true)
    // The mounted basename must be a real file in the repo.
    expect(existsSync(join(monDir, 'prometheus', 'aipehub.alerts.yml'))).toBe(true)
  })

  it('Prometheus hands alerts to Alertmanager', () => {
    const mgrs = prom.alerting?.alertmanagers ?? []
    expect(mgrs.length).toBeGreaterThan(0)
    const targets = mgrs.flatMap((m: any) => (m.static_configs ?? []).flatMap((s: any) => s.targets ?? []))
    expect(targets.some((t: string) => t.includes('alertmanager'))).toBe(true)
  })

  it('every alert severity has an Alertmanager route (no alert fires into the void)', () => {
    expect(severities.size).toBeGreaterThan(0)
    for (const sev of severities) {
      expect(severityHasRoute(sev), `severity="${sev}" has no Alertmanager route`).toBe(true)
    }
  })

  it('every Alertmanager route targets a declared receiver', () => {
    // root receiver + each child route's receiver must all exist.
    expect(amReceivers.size).toBeGreaterThan(0)
    for (const r of amRoutes) {
      if (r.receiver) {
        expect(amReceivers, `route → undefined receiver "${r.receiver}"`).toContain(r.receiver)
      }
    }
  })

  it('docker-compose mounts the config files that exist', () => {
    const services = compose.services ?? {}
    // Collect every host-side bind path (the part before the first ':').
    const hostPaths: string[] = []
    for (const svc of Object.values<any>(services)) {
      for (const v of svc.volumes ?? []) {
        if (typeof v === 'string' && v.startsWith('./')) hostPaths.push(v.split(':')[0])
      }
    }
    // The wired config files must be present (secrets/ is operator-provided
    // and gitignored — only its .example is tracked, so skip that path).
    const required = [
      './prometheus/prometheus.yml',
      './prometheus/aipehub.alerts.yml',
      './alertmanager/alertmanager.yml',
      './grafana/aipehub-overview.json',
    ]
    for (const rel of required) {
      expect(hostPaths, `compose never mounts ${rel}`).toContain(rel)
      expect(existsSync(join(monDir, rel)), `${rel} mounted but missing`).toBe(true)
    }
  })
})
