/**
 * me-panel-surface.ts — SDUI-M2. Host adapter behind web's `GET /api/me/panel`
 * (the `MePanelSurface` duck in `@gotong/web` panel-routes.ts).
 *
 * M2 scope: every member resolves to the built-in DEFAULT_PANEL — the renderer
 * pipeline gets a real, validated config to drive. The M3 per-member store
 * (`<space>/butler/ui/user/<userId>/panel.json`) grows INSIDE this file:
 * read the member file → validate with the same `validatePanelConfig` every
 * write path uses → `source:'member'`; corrupt/wrong-version file → quarantine
 * stays with the writer, serve the default with `source:'fallback'` so the SPA
 * shows a loud notice. main.ts stays a 2-line wiring either way.
 */

import { DEFAULT_PANEL, PANEL_SCHEMA_VERSION } from '@gotong/personal-butler'

export interface MePanelResult {
  schemaVersion: number
  config: unknown
  source: 'default' | 'member' | 'fallback'
}

export interface MePanelSurfaceHost {
  panel(userId: string): Promise<MePanelResult>
}

export function buildMePanelSurface(): MePanelSurfaceHost {
  return {
    async panel(_userId: string): Promise<MePanelResult> {
      return { schemaVersion: PANEL_SCHEMA_VERSION, config: DEFAULT_PANEL, source: 'default' }
    },
  }
}
