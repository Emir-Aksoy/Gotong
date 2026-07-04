#!/usr/bin/env node
// scripts/seed-personal-growth-demo.mjs
//
// Idempotent dev shortcut: seed the 7 personal-growth agents straight
// into a demo space's agents.json (skipping the admin UI / bundle
// import flow that real users go through). Re-running PURGES any prior
// PG seed and re-creates them from the current prompts — so this is
// the right loop for "edit a prompt, redeploy locally":
//
//   1. edit scripts/personal-growth-prompts.mjs (or anywhere else
//      that flows into TEAM_AGENTS)
//   2. node scripts/seed-personal-growth-demo.mjs
//   3. restart the host (LocalAgentPool re-spawns from agents.json)
//
// Defaults to ./.gotong-demo/agents.json. Override with $GOTONG_SPACE.
//
// Public users get the same 7 agents via the bundle import path:
//   POST /api/admin/bundles/import  with templates/bundles/personal-growth.yaml
// — that path also asks for a DeepSeek key and applies it. This dev
// script instead copies a key from an EXISTING `deepseek-writer` agent
// in the same workspace (see KEY_SOURCE), because the developer's demo
// workspace always has that seed agent around.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  TEAM_AGENTS,
  DEFAULT_PROVIDER,
} from './personal-growth-prompts.mjs';

const SPACE = process.env.GOTONG_SPACE
  ? resolve(process.env.GOTONG_SPACE)
  : resolve('.gotong-demo');
const PATH = resolve(SPACE, 'agents.json');

const data = JSON.parse(readFileSync(PATH, 'utf8'));

// Purge any prior personal-growth seed so this script is idempotent.
const PG_IDS = new Set([
  'user-portraitist',     // v0.1 legacy name
  ...TEAM_AGENTS.map((a) => a.id),
]);
const before = data.agents.length;
data.agents = data.agents.filter((a) => !PG_IDS.has(a.id));
const purged = before - data.agents.length;

const ts = new Date().toISOString();

function makeAgent(spec) {
  const managed = {
    kind: 'personal-growth',
    provider: DEFAULT_PROVIDER.provider,
    model: DEFAULT_PROVIDER.model,
    baseURL: DEFAULT_PROVIDER.baseURL,
    providerLabel: DEFAULT_PROVIDER.providerLabel,
    system: spec.system,
    ...(spec.uses && spec.uses.length > 0 ? { uses: spec.uses } : {}),
    ...(spec.mcpServers && spec.mcpServers.length > 0 ? { mcpServers: spec.mcpServers } : {}),
  };
  return {
    id: spec.id,
    allowedCapabilities: spec.capabilities,
    displayName: spec.displayName,
    managed,
    createdAt: ts,
  };
}

data.agents.push(...TEAM_AGENTS.map(makeAgent));

writeFileSync(PATH, JSON.stringify(data, null, 2) + '\n');
console.log(`purged prior personal-growth agents: ${purged}`);
console.log(`agents total: ${data.agents.length}`);
console.log(`pg kind: ${data.agents.slice(-TEAM_AGENTS.length).map((a) => a.managed.kind).join(', ')}`);
console.log(`pg uses: ${data.agents.slice(-TEAM_AGENTS.length).map((a) => (a.managed.uses ?? []).map((u) => u.type).join('+')).join(' | ')}`);

// ────────────────────────────────────────────────────────────────────
// Copy the DeepSeek key from a peer agent. See module docstring for
// why this exists (dev shortcut, not the public flow). Override the
// source agent id with $PG_KEY_SOURCE_AGENT.
// ────────────────────────────────────────────────────────────────────
const KEY_SOURCE = process.env.PG_KEY_SOURCE_AGENT ?? 'deepseek-writer';
const { Space } = await import('../packages/core/dist/index.js');
const space = await Space.open(SPACE);
const sourceKey = await space.getAgentApiKey(KEY_SOURCE);
if (!sourceKey) {
  console.warn(
    `WARN: no API key found on '${KEY_SOURCE}'. The 7 PG agents will fail to spawn until you set one via admin UI or set $PG_KEY_SOURCE_AGENT.`,
  );
} else {
  const pgIds = TEAM_AGENTS.map((a) => a.id);
  for (const id of pgIds) {
    await space.setAgentApiKey(id, sourceKey);
  }
  console.log(`copied DeepSeek key from '${KEY_SOURCE}' to ${pgIds.length} PG agents`);
}
