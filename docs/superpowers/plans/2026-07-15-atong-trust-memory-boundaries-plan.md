# Atong Trust, Memory, and Resource Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the eight audited Atong identity, memory, MCP, role, and approval boundary failures without replacing Gotong's existing Principal, resource-grant, vault, inbox, or trust-tier systems.

**Architecture:** Add a trusted task actor context that is minted by authenticated Host ingress, reconstructed at federation ingress, persisted through park/resume, and inherited by child dispatch. Personal resources require a trusted local-user actor; memory becomes a coordinated per-user resource domain; MCP receives explicit personal/organization scope and local tool policy; role and approver decisions use current membership at execution time.

**Tech Stack:** TypeScript, pnpm workspace, Vitest, file-backed JSONL memory, SQLite identity/vault, Host inbox/governed actions, Web/IM/federation ingress.

---

## File Structure

New focused modules:

- `packages/protocol/src/actor-context.ts` — pure task-actor vocabulary and validation, with no identity-store dependency.
- `packages/host/src/trusted-actor.ts` — constructs local, remote, and system actors from trusted Host inputs.
- `packages/host/src/actor-policy.ts` — current-membership lookup, personal-resource gate, workflow role gate, and approver resolution.
- `packages/host/src/butler-memory-domain.ts` — per-user live-resource registry and coordinated hard purge.
- `packages/personal-memory/src/secret-detector.ts` — deterministic detection/redaction with no vault dependency.
- `packages/host/src/pending-secret-store.ts` — bounded process-local pending secret values and expiry.
- `packages/host/src/butler-secret-service.ts` — governed confirmation and per-user vault reference creation.
- `packages/host/src/mcp-access-policy.ts` — personal/organization scope and authoritative per-tool decisions.

Existing files change only where they own a boundary:

- Protocol/Core/LLM task creation and inheritance.
- Host Web/IM/federation ingress and personal Butler routing.
- Services SDK/file memory traversal and Host memory lifecycle.
- Personal-memory capture and atomic fact extraction.
- Core MCP registry schema, Host MCP composition/proxy, and admin routes.
- Host workflow and inbox approval assembly.

## Task 1: Trusted Task Actor Vocabulary and Persistence

**Files:**
- Create: `packages/protocol/src/actor-context.ts`
- Modify: `packages/protocol/src/types.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/core/src/hub.ts`
- Test: `packages/core/tests/hub.test.ts`

- [ ] **Step 1: Write failing Hub tests**

Add tests proving an actor supplied to `Hub.dispatch` is copied into the persisted `Task`, survives task views, and rejects malformed actors before scheduler execution:

```ts
const actor = {
  kind: 'local_user' as const,
  principal: { kind: 'user' as const, id: 'alice' },
  orgId: 'local',
  userId: 'alice',
  role: 'member' as const,
}
const result = await hub.dispatch({ from: 'web', actor, strategy, payload: {} })
expect(hub.tasks().find((t) => t.id === result.taskId)?.task.actor).toEqual(actor)
```

- [ ] **Step 2: Verify RED**

Run: `pnpm -C packages/core exec vitest run tests/hub.test.ts`

Expected: FAIL because `actor` is not accepted or persisted.

- [ ] **Step 3: Implement pure vocabulary and validation**

Define protocol-owned shapes so Core does not depend on Identity:

```ts
export type ActorRole = 'owner' | 'admin' | 'member' | 'viewer'

export type TaskActorContext =
  | { kind: 'local_user'; principal: { kind: 'user'; id: string }; orgId: string; userId: string; role: ActorRole }
  | { kind: 'remote_principal'; principal: { kind: 'peer'; id: string }; peerHubId: string; remoteOrgId: string; remoteUserId: string }
  | { kind: 'system'; principal: { kind: 'agent' | 'hub'; id: string }; serviceId: string }
```

Export `assertTaskActorContext(value)` and add optional `actor?: TaskActorContext` to `Task` and `Hub.dispatch`. Validate before transcript append; attach only validated data.

- [ ] **Step 4: Verify GREEN and compatibility**

Run: `pnpm -C packages/core exec vitest run tests/hub.test.ts tests/hub-resume.test.ts`

Expected: PASS with legacy actor-less tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/actor-context.ts packages/protocol/src/types.ts packages/protocol/src/index.ts packages/core/src/hub.ts packages/core/tests/hub.test.ts
git commit -m "feat(core): persist trusted task actor context"
```

## Task 2: Child Dispatch Inheritance and Federation Reconstruction

**Files:**
- Modify: `packages/llm/src/dispatch-toolset.ts`
- Modify: `packages/core/src/peer-link-install.ts`
- Modify: `packages/core/src/participants/remote-hub.ts`
- Test: `packages/llm/tests/dispatch-toolset-ancestry.test.ts`
- Test: `packages/core/tests/peer-link-ancestry.test.ts`
- Test: `packages/core/tests/peer-link-rpc.test.ts`

- [ ] **Step 1: Write failing inheritance and collision tests**

Add a child-dispatch test where `runForTask` receives a local actor and `hub.dispatch` must receive the identical actor. Add a peer-link test where the incoming task contains a forged local actor and `installPeerLink` must replace it with:

```ts
{
  kind: 'remote_principal',
  principal: { kind: 'peer', id: authenticatedPeerHubId },
  peerHubId: authenticatedPeerHubId,
  remoteOrgId: task.origin.orgId,
  remoteUserId: task.origin.userId,
}
```

- [ ] **Step 2: Verify RED**

Run: `pnpm -C packages/llm exec vitest run tests/dispatch-toolset-ancestry.test.ts`

Run: `pnpm -C packages/core exec vitest run tests/peer-link-ancestry.test.ts tests/peer-link-rpc.test.ts`

Expected: FAIL because actor is dropped or trusted from the wire.

- [ ] **Step 3: Implement inheritance and reconstruction**

Extend `CurrentTaskContext` and `runForTask` with `actor`. Stamp `actor: current.actor` in `dispatch_task`. At peer ingress ignore `task.actor`; construct a remote actor from the authenticated link identity and origin. Outbound forwarding may carry actor for audit, but the receiving side always reconstructs it.

- [ ] **Step 4: Verify GREEN**

Run the commands from Step 2 plus `pnpm -C packages/llm exec vitest run tests/dispatch-toolset.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/llm/src/dispatch-toolset.ts packages/core/src/peer-link-install.ts packages/core/src/participants/remote-hub.ts packages/llm/tests/dispatch-toolset-ancestry.test.ts packages/core/tests/peer-link-ancestry.test.ts packages/core/tests/peer-link-rpc.test.ts
git commit -m "fix(federation): reconstruct and inherit task actors"
```

## Task 3: Trusted Host Construction and Personal Butler Gate

**Files:**
- Create: `packages/host/src/trusted-actor.ts`
- Create: `packages/host/src/actor-policy.ts`
- Modify: `packages/host/src/butler-router.ts`
- Modify: `packages/host/src/personal-butler-factory.ts`
- Modify: `packages/host/src/im-bridge.ts`
- Modify: `packages/web/src/me-routes.ts`
- Modify: `packages/host/src/local-agent-pool.ts`
- Modify: `packages/host/src/workflow-assist-agent.ts`
- Modify: `packages/host/src/heartbeat-engine.ts`
- Modify: `packages/host/src/hub-steward-service.ts`
- Modify: `packages/host/src/template-acceptance.ts`
- Modify: `packages/host/src/personal-butler-ask-agent.ts`
- Modify: `packages/host/src/personal-butler-ask-peer.ts`
- Modify: `packages/host/src/personal-butler-reminders.ts`
- Test: `packages/host/tests/butler-router.test.ts`
- Test: `packages/host/tests/butler-im-e2e.test.ts`
- Test: `packages/host/tests/local-agent-pool-dispatch.test.ts`
- Test: `packages/web/tests/workflow-rbac-route.test.ts`

- [ ] **Step 1: Write failing personal-resource tests**

Cover four cases: matching local user accepted; missing actor rejected; remote actor with `remoteUserId='alice'` rejected; system actor rejected. Assert no Butler is created in rejected cases. Add Web/IM tests that inspect the dispatched actor role from current membership.

- [ ] **Step 2: Verify RED**

Run: `pnpm -C packages/host exec vitest run tests/butler-router.test.ts tests/butler-im-e2e.test.ts tests/local-agent-pool-dispatch.test.ts`

Expected: FAIL because routing still uses `origin.userId`.

- [ ] **Step 3: Implement trusted Host helpers**

Implement:

```ts
export function localUserActor(identity: MembershipReader, userId: string, orgId = 'local'): TaskActorContext
export function requireLocalUserActor(actor: TaskActorContext | undefined): LocalUserActor
export function currentRole(identity: MembershipReader, userId: string): Role
```

Change `ButlerRouterOptions.createForUser` to `createForActor(actor: LocalUserActor)`. Reject non-local actors with a failed `TaskResult` carrying `personal_resource_forbidden`. Remove `_local` as a personal memory fallback. Make quota and user attribution read the trusted local actor.

Stamp actors at Web and IM authenticated dispatch sites. Audit every root `hub.dispatch` call: workflow assist, heartbeat, steward, template acceptance, Butler ask-agent/ask-peer, reminders, and LocalAgentPool internals must either inherit a trusted task actor or stamp an explicit system actor. No root dispatch remains actor-less.

- [ ] **Step 4: Verify GREEN**

Run Step 2 commands and `pnpm -C packages/web exec vitest run tests/workflow-rbac-route.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/trusted-actor.ts packages/host/src/actor-policy.ts packages/host/src/butler-router.ts packages/host/src/personal-butler-factory.ts packages/host/src/im-bridge.ts packages/web/src/me-routes.ts packages/host/src/local-agent-pool.ts packages/host/src/workflow-assist-agent.ts packages/host/src/heartbeat-engine.ts packages/host/src/hub-steward-service.ts packages/host/src/template-acceptance.ts packages/host/src/personal-butler-ask-agent.ts packages/host/src/personal-butler-ask-peer.ts packages/host/src/personal-butler-reminders.ts packages/host/tests/butler-router.test.ts packages/host/tests/butler-im-e2e.test.ts packages/host/tests/local-agent-pool-dispatch.test.ts packages/web/tests/workflow-rbac-route.test.ts
git commit -m "fix(host): gate personal agents on trusted local actors"
```

## Task 4: Real Roles and Eligible Approvers for All Agent Paths

**Files:**
- Modify: `packages/host/src/actor-policy.ts`
- Modify: `packages/host/src/personal-butler-workflows.ts`
- Modify: `packages/host/src/personal-butler-factory.ts`
- Modify: `packages/host/src/personal-butler-escalation.ts`
- Modify: `packages/host/src/main.ts`
- Modify: `packages/host/src/im-approval-service.ts`
- Modify: `packages/host/src/a2a-outbound.ts`
- Modify: `packages/host/src/acp-outbound.ts`
- Modify: `packages/host/src/outbound-approval.ts`
- Test: `packages/host/tests/butler-run-workflow-e2e.test.ts`
- Test: `packages/host/tests/personal-butler-escalation.test.ts`
- Test: `packages/host/tests/im-approval-service.test.ts`

- [ ] **Step 1: Write failing role and approval tests**

Add tests that viewer workflow listing/running returns no runnable workflow; owner-only workflow is visible to an owner actor; member high-risk approval is assigned to owner/admin excluding initiator; member self-resolution is rejected; role downgrade between park and resolution is honored; no eligible approver returns `no_eligible_approver` without writing an inbox item.

- [ ] **Step 2: Verify RED**

Run: `pnpm -C packages/host exec vitest run tests/butler-run-workflow-e2e.test.ts tests/personal-butler-escalation.test.ts tests/im-approval-service.test.ts`

- [ ] **Step 3: Implement shared policy**

Add pure functions:

```ts
export function mayRunWorkflow(role: Role): boolean { return role !== 'viewer' }
export function resolveEligibleApprover(identity: MembershipDirectory, actor: LocalUserActor, risk: ActionRisk): string | null
export function assertApprovalResolution(identity: MembershipDirectory, actorUserId: string, approverUserId: string, risk: ActionRisk): void
```

Pass the real actor role into `buildButlerWorkflowsToolset`. Replace `task.origin.userId` approval assignment with actor-policy resolution. Route Butler, A2A, ACP, and generic outbound approval through the same eligible-approver resolver and revalidate both parties immediately before resume.

- [ ] **Step 4: Verify GREEN**

Run Step 2 commands plus `pnpm -C packages/host exec vitest run tests/im-approval-e2e.test.ts tests/personal-butler-governed-e2e.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/actor-policy.ts packages/host/src/personal-butler-workflows.ts packages/host/src/personal-butler-factory.ts packages/host/src/personal-butler-escalation.ts packages/host/src/main.ts packages/host/src/im-approval-service.ts packages/host/src/a2a-outbound.ts packages/host/src/acp-outbound.ts packages/host/src/outbound-approval.ts packages/host/tests/butler-run-workflow-e2e.test.ts packages/host/tests/personal-butler-escalation.test.ts packages/host/tests/im-approval-service.test.ts
git commit -m "fix(authz): use current roles and eligible approvers"
```

## Task 5: Complete Memory Pagination

**Files:**
- Modify: `packages/services-sdk/src/types/memory.ts`
- Modify: `packages/service-memory-file/src/handle.ts`
- Create: `packages/personal-memory/src/scan.ts`
- Modify: `packages/personal-memory/src/budget.ts`
- Modify: `packages/personal-memory/src/atomic-facts.ts`
- Modify: `packages/host/src/butler-memory-service.ts`
- Test: `packages/service-memory-file/tests/handle.test.ts`
- Test: `packages/personal-memory/tests/budget.test.ts`
- Test: `packages/personal-memory/tests/atomic-facts.test.ts`
- Test: `packages/host/tests/butler-memory-service.test.ts`

- [ ] **Step 1: Write failing >500-entry tests**

Seed 650 entries and prove page traversal returns every stable id, export returns all 650, forgetting the oldest id reports true, budget sees all entries, and atomic dedup finds a matching fact beyond the first 500.

- [ ] **Step 2: Verify RED**

Run: `pnpm -C packages/service-memory-file exec vitest run tests/handle.test.ts`

Run: `pnpm -C packages/personal-memory exec vitest run tests/budget.test.ts tests/atomic-facts.test.ts`

Run: `pnpm -C packages/host exec vitest run tests/butler-memory-service.test.ts`

- [ ] **Step 3: Implement bounded pages and full scan helper**

Add:

```ts
interface MemoryPage { entries: MemoryEntry[]; nextCursor?: string }
interface MemoryHandle {
  listPage(opts?: { kind?: MemoryKind; limit?: number; cursor?: string }): Promise<MemoryPage>
}

export async function scanMemory(handle: MemoryHandle, opts?: { kind?: MemoryKind }): Promise<MemoryEntry[]> {
  const out: MemoryEntry[] = []
  let cursor: string | undefined
  do {
    const page = await handle.listPage({ ...opts, limit: 500, ...(cursor ? { cursor } : {}) })
    out.push(...page.entries)
    cursor = page.nextCursor
  } while (cursor)
  return out
}
```

Use a stable `(ts,id)` cursor and retain `list()` as a bounded compatibility API. Convert complete consumers to `scanMemory`.

- [ ] **Step 4: Verify GREEN**

Run all Step 2 commands.

- [ ] **Step 5: Commit**

```bash
git add packages/services-sdk/src/types/memory.ts packages/service-memory-file/src/handle.ts packages/personal-memory/src/scan.ts packages/personal-memory/src/budget.ts packages/personal-memory/src/atomic-facts.ts packages/host/src/butler-memory-service.ts packages/service-memory-file/tests/handle.test.ts packages/personal-memory/tests/budget.test.ts packages/personal-memory/tests/atomic-facts.test.ts packages/host/tests/butler-memory-service.test.ts
git commit -m "fix(memory): scan complete stores beyond page limits"
```

## Task 6: Coordinated Irreversible Memory Purge

**Files:**
- Create: `packages/host/src/butler-memory-domain.ts`
- Modify: `packages/host/src/butler-memory-service.ts`
- Modify: `packages/host/src/butler-router.ts`
- Modify: `packages/host/src/personal-butler-factory.ts`
- Modify: `packages/host/src/personal-butler-maintenance.ts`
- Test: `packages/host/tests/butler-memory-domain.test.ts`
- Test: `packages/host/tests/butler-memory-service.test.ts`
- Test: `packages/host/tests/butler-recall-index.test.ts`

- [ ] **Step 1: Write failing hard-delete tests**

Create JSONL, `recall-index.json`, projections, and a real per-user Git repository containing a secret marker. Keep a live Butler/handle registered. Call purge concurrently with a queued capture. Assert the entire user directory is absent, caches are evicted, the queued write cannot recreate it, and a newly opened handle is empty. Inject `rm` failure and assert `memory_purge_incomplete` plus a locked namespace.

- [ ] **Step 2: Verify RED**

Run: `pnpm -C packages/host exec vitest run tests/butler-memory-domain.test.ts tests/butler-memory-service.test.ts tests/butler-recall-index.test.ts`

- [ ] **Step 3: Implement the resource domain**

Implement one registry per memory root with `registerHandle`, `registerButler`, `runWrite(userId, fn)`, `purge(userId)`, and `unlockAfterOperatorRecovery(userId)`. `purge` takes the owner write chain, stops the Butler, invalidates index/service caches, removes `ownerDir(root,{kind:'user',id})`, and keeps a failed purge locked.

Make `HostButlerMemoryService.forgetAll` delegate only to this coordinator and report success only after removal completes.

- [ ] **Step 4: Verify GREEN**

Run Step 2 commands and existing dream/skill/status tests.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/butler-memory-domain.ts packages/host/src/butler-memory-service.ts packages/host/src/butler-router.ts packages/host/src/personal-butler-factory.ts packages/host/src/personal-butler-maintenance.ts packages/host/tests/butler-memory-domain.test.ts packages/host/tests/butler-memory-service.test.ts packages/host/tests/butler-recall-index.test.ts
git commit -m "fix(memory): make forget-all an irreversible coordinated purge"
```

## Task 7: Secret Detection, Confirmation, and Vault References

**Files:**
- Create: `packages/personal-memory/src/secret-detector.ts`
- Create: `packages/host/src/pending-secret-store.ts`
- Create: `packages/host/src/butler-secret-service.ts`
- Modify: `packages/personal-memory/src/capture.ts`
- Modify: `packages/personal-memory/src/toolset.ts`
- Modify: `packages/host/src/me-credentials-service.ts`
- Modify: `packages/host/src/im-bridge.ts`
- Modify: `packages/web/src/me-routes.ts`
- Test: `packages/personal-memory/tests/secret-detector.test.ts`
- Test: `packages/personal-memory/tests/capture.test.ts`
- Test: `packages/host/tests/butler-secret-service.test.ts`
- Test: `packages/host/tests/me-credentials-service.test.ts`

- [ ] **Step 1: Write failing no-leak tests**

Cover OpenAI/Anthropic-style keys, bearer tokens, password assignments, and PEM private keys. Assert redaction before dispatch, no raw value in task/transcript/capture/tool result/log, approval writes a user-owned encrypted vault entry and memory stores only `secretRef`, denial/expiry/shutdown discards pending values, and restart cannot recover an unapproved value.

- [ ] **Step 2: Verify RED**

Run: `pnpm -C packages/personal-memory exec vitest run tests/secret-detector.test.ts tests/capture.test.ts`

Run: `pnpm -C packages/host exec vitest run tests/butler-secret-service.test.ts tests/me-credentials-service.test.ts`

- [ ] **Step 3: Implement minimal secret flow**

The detector returns redacted text plus spans without logging values:

```ts
interface SecretDetection {
  redacted: string
  secrets: Array<{ type: 'api_key' | 'token' | 'password' | 'private_key'; value: string; placeholder: string }>
}
```

`PendingSecretStore` keeps bounded `Buffer` values by random id with TTL and explicit destroy. `ButlerSecretService.confirm(actor,id,label)` requires the same local user actor, writes through the existing vault as a user-owned credential, destroys the pending value, and returns only `secretRef`. Ingress redacts before `hub.dispatch`; capture and `remember` reject plaintext secret spans and store references only.

- [ ] **Step 4: Verify GREEN**

Run Step 2 commands plus Butler capture and Web/IM route tests.

- [ ] **Step 5: Commit**

```bash
git add packages/personal-memory/src/secret-detector.ts packages/host/src/pending-secret-store.ts packages/host/src/butler-secret-service.ts packages/personal-memory/src/capture.ts packages/personal-memory/src/toolset.ts packages/host/src/me-credentials-service.ts packages/host/src/im-bridge.ts packages/web/src/me-routes.ts packages/personal-memory/tests/secret-detector.test.ts packages/personal-memory/tests/capture.test.ts packages/host/tests/butler-secret-service.test.ts packages/host/tests/me-credentials-service.test.ts
git commit -m "fix(memory): route detected secrets through user vault confirmation"
```

## Task 8: User-Sourced Atomic Facts and Corrections

**Files:**
- Modify: `packages/personal-memory/src/capture.ts`
- Modify: `packages/personal-memory/src/atomic-facts.ts`
- Modify: `packages/personal-memory/src/bitemporal.ts`
- Modify: `packages/personal-memory/src/frozen-block.ts`
- Test: `packages/personal-memory/tests/capture.test.ts`
- Test: `packages/personal-memory/tests/atomic-facts.test.ts`
- Test: `packages/personal-memory/tests/bitemporal.test.ts`

- [ ] **Step 1: Write failing provenance tests**

Assert user and assistant turns are distinguishable; assistant-only claims produce zero facts; user text produces a fact with source ids, bounded evidence, confidence, and `speaker:'user'`; confirmed content is eligible; correction closes the prior fact and links `supersedes`; `legacy-unverified` facts remain listable but are excluded from trusted frozen injection.

- [ ] **Step 2: Verify RED**

Run: `pnpm -C packages/personal-memory exec vitest run tests/capture.test.ts tests/atomic-facts.test.ts tests/bitemporal.test.ts`

- [ ] **Step 3: Implement provenance**

Store separate episodic entries with `meta.speaker`. Change the summarizer input to user entries only and require structured line output carrying source ids. Persist:

```ts
meta: {
  atomicFact: true,
  provenance: { sourceEntryIds, speaker: 'user', evidence, confidence, confirmedByUser },
}
```

Mark old facts lacking provenance as `legacy-unverified`. Use existing validity writers to close corrected facts and add the replacement link.

- [ ] **Step 4: Verify GREEN**

Run Step 2 commands and `pnpm -C packages/personal-memory exec vitest run`.

- [ ] **Step 5: Commit**

```bash
git add packages/personal-memory/src/capture.ts packages/personal-memory/src/atomic-facts.ts packages/personal-memory/src/bitemporal.ts packages/personal-memory/src/frozen-block.ts packages/personal-memory/tests/capture.test.ts packages/personal-memory/tests/atomic-facts.test.ts packages/personal-memory/tests/bitemporal.test.ts
git commit -m "fix(memory): derive facts only from user-sourced evidence"
```

## Task 9: MCP Personal/Organization Scope and Authoritative Tool Policy

**Files:**
- Modify: `packages/core/src/space.ts`
- Create: `packages/host/src/mcp-access-policy.ts`
- Modify: `packages/host/src/personal-butler-mcp.ts`
- Modify: `packages/host/src/personal-butler-factory.ts`
- Modify: `packages/host/src/mcp-proxy.ts`
- Modify: `packages/web/src/mcp-routes.ts`
- Test: `packages/host/tests/local-agent-pool-mcp.test.ts`
- Test: `packages/host/tests/butler-mcp-e2e.test.ts`
- Test: `packages/host/tests/mcp-proxy.test.ts`
- Test: `packages/web/tests/mcp-route.test.ts`

- [ ] **Step 1: Write failing scope and policy tests**

Test personal MCP visible only to owner; organization MCP filtered by real role; missing policy means no advertised tool; forged `readOnlyHint:true` cannot override local `write`; read-like names cannot override `deny`; write parks; cross-Hub MCP is denied unless local policy explicitly permits federation.

- [ ] **Step 2: Verify RED**

Run: `pnpm -C packages/host exec vitest run tests/local-agent-pool-mcp.test.ts tests/butler-mcp-e2e.test.ts tests/mcp-proxy.test.ts`

Run: `pnpm -C packages/web exec vitest run tests/mcp-route.test.ts`

- [ ] **Step 3: Implement scoped records and runtime checks**

Extend `HubMcpServerRecord` with:

```ts
scope:
  | { kind: 'personal'; ownerUserId: string }
  | { kind: 'organization'; allowedRoles: Role[]; allowFederation?: boolean }
toolPolicies: Record<string, 'read' | 'write' | 'deny'>
```

Only owner/admin routes may set organization policy. Existing records without scope remain installed but inactive for personal agents. `mcp-access-policy` filters list and checks every call. Annotations and name heuristics become admin suggestions only. Provider-side cross-Hub proxy repeats the local policy check.

- [ ] **Step 4: Verify GREEN**

Run Step 2 commands and the complete Host/Web MCP suites.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/space.ts packages/host/src/mcp-access-policy.ts packages/host/src/personal-butler-mcp.ts packages/host/src/personal-butler-factory.ts packages/host/src/mcp-proxy.ts packages/web/src/mcp-routes.ts packages/host/tests/local-agent-pool-mcp.test.ts packages/host/tests/butler-mcp-e2e.test.ts packages/host/tests/mcp-proxy.test.ts packages/web/tests/mcp-route.test.ts
git commit -m "fix(mcp): enforce scoped local tool policies"
```

## Task 10: Legacy Quarantine, Restart Capstone, and Documentation

**Files:**
- Create: `packages/host/src/butler-security-migration.ts`
- Create: `scripts/test-atong-security-e2e.mjs`
- Modify: `package.json`
- Modify: `docs/zh/PROGRESS-LEDGER.md`
- Modify: `docs/zh/FEDERATION-RUNBOOK.md`
- Modify: `docs/zh/MEMORY-UPGRADE.md`
- Test: `packages/host/tests/butler-security-migration.test.ts`

- [ ] **Step 1: Write failing migration tests**

Seed legacy secret-like entries, facts without provenance, unscoped MCP records, and actor-less persisted tasks. Assert secrets/facts are quarantined, MCP remains inactive, and personal/side-effecting tasks fail with an actionable migration error.

- [ ] **Step 2: Verify RED**

Run: `pnpm -C packages/host exec vitest run tests/butler-security-migration.test.ts`

- [ ] **Step 3: Implement migration and process-level capstone**

Implement idempotent scans with no automatic secret promotion. Add `pnpm check:atong-security` to start a real Host, create local and federated actors, exercise memory/MCP/approval boundaries, kill and restart the process, and assert no deleted or pending secret can be recovered.

- [ ] **Step 4: Run full verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm check:guards
pnpm check:cross-hub
pnpm check:atong-security
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/butler-security-migration.ts packages/host/tests/butler-security-migration.test.ts scripts/test-atong-security-e2e.mjs package.json docs/zh/PROGRESS-LEDGER.md docs/zh/FEDERATION-RUNBOOK.md docs/zh/MEMORY-UPGRADE.md
git commit -m "test(security): capstone Atong trust and memory boundaries"
```

## Final Review Checklist

- [ ] Every personal resource is keyed from a trusted local actor, never an origin claim.
- [ ] Every child dispatch preserves actor, quota owner, and audit attribution.
- [ ] Remote and system actors cannot enter personal Butler state.
- [ ] Hard deletion removes the complete per-user directory and prevents write resurrection.
- [ ] Complete memory consumers traverse every page.
- [ ] Secret values do not cross persistence, prompt, transcript, result, or log boundaries.
- [ ] Semantic facts have eligible user provenance or remain untrusted.
- [ ] MCP runtime policy is local, scoped, and checked per call.
- [ ] Workflow and approval policy uses current membership for all agent entry points.
- [ ] Process restart tests prove persistence and deletion semantics.
