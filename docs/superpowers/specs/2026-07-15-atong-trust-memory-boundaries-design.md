# Atong Trust, Memory, and Resource Boundaries Design

**Date:** 2026-07-15  
**Status:** Approved design  
**Scope:** All agent entry points, Atong personal memory, MCP resources, workflow roles, and governed approvals

## 1. Purpose

This design closes eight related boundary failures discovered in the Atong audit:

1. A federated caller can collide with a local `origin.userId` and enter a local Butler namespace.
2. `forgetAll` leaves recoverable content in the persisted recall index and optional Git history.
3. Conversations and `remember` can persist credentials or private keys as plaintext memory.
4. The file adapter's 500-entry list cap silently truncates budgeting, deduplication, and export.
5. Atomic facts do not retain trustworthy speaker or source provenance.
6. MCP credentials and tools are shared at agent scope instead of being scoped to a user or organization policy.
7. MCP read/write classification trusts remote annotations and tool names as an authorization boundary.
8. Agent workflow and approval paths do not consistently use the caller's real membership role.

The failures share one root cause: untrusted identity data and resource ownership are interpreted independently at multiple call sites. The fix is a shared trusted actor context plus explicit resource scopes. Existing ACL, trust-tier, vault, governed-action, memory-file, and inbox mechanisms remain the enforcement primitives.

## 2. Goals

- Mint caller identity and role exactly once at a trusted ingress and propagate it without loss.
- Prevent remote or system callers from entering a local member's personal resource namespace.
- Make hard deletion irreversible across source files, caches, projections, and Git snapshots.
- Keep secret values out of memory, prompts, transcripts, tool results, and logs while retaining approved use through the encrypted vault.
- Make semantic facts traceable to user-authored or user-confirmed evidence.
- Separate personal MCP resources from explicitly governed organization resources.
- Apply role and approver rules to every agent entry point, not only Atong.
- Replace silent list truncation with complete cursor-based internal scans.

## 3. Non-goals

- Building a new general-purpose ABAC language or replacing existing peer ACL and trust-tier policy.
- Allowing an agent to register accounts, discover secret values, or write credentials without human confirmation.
- Making MCP server annotations authoritative.
- Making Mem0 or another service the primary Atong memory backend.
- Wiring `EnsembleProvider` into Atong as part of this security track.
- Automatically trusting existing unproven semantic facts or silently migrating detected secrets into the vault.

## 4. Trusted Actor Context

### 4.1 Internal type

All task execution receives an internal context with one of three identities:

```ts
type ActorContext =
  | {
      kind: 'local_user'
      orgId: string
      userId: string
      role: 'owner' | 'admin' | 'member' | 'viewer'
    }
  | {
      kind: 'remote_principal'
      peerHubId: string
      remoteOrgId: string
      remoteUserId: string
    }
  | {
      kind: 'system'
      serviceId: string
    }
```

The actual implementation may add stable audit identifiers and authentication timestamps, but it must not weaken these variants or represent an unknown caller as a local user.

### 4.2 Trusted construction

- Web constructs `local_user` from the authenticated session and the current membership row.
- IM resolves the verified binding to a local user and then reads the current membership row.
- Federation constructs `remote_principal` from the authenticated peer link plus the remote origin declaration. The declaration remains namespaced under that peer and never becomes a local user id.
- Background services use an explicit `system` identity.
- Payload fields, LLM tool arguments, persisted workflow inputs, and remote wire fields cannot directly set `ActorContext`.

### 4.3 Propagation and revalidation

- Hub dispatch stores the trusted context in internal task state so park/resume and restart preserve attribution.
- `dispatch_task` inherits the parent context by default. A service identity transition must be explicit and auditable.
- Quota, usage, transcript attribution, workflow ownership, and audit events consume the inherited context.
- Role-sensitive execution re-reads membership immediately before a side effect or approval resolution. The role recorded at ingress is useful for attribution, not a stale authorization grant.
- Legacy tasks with no trusted context may use only explicitly system-capable, non-personal operations. Personal or side-effecting operations fail closed.

### 4.4 Personal resource gate

Personal agents, memory, vault credentials, personal MCP, reminders, notebooks, and personal usage views require `local_user`. Their owner key is the trusted local `userId`, never `TaskOrigin.userId` by itself.

An unbound `remote_principal` may call only organization-level agents that explicitly allow federation. Owner-created identity binding is a separate persisted mapping. Without that mapping, a remote id cannot equal or alias a local id.

System work no longer falls into a hidden `_local` personal Butler bucket. A system-capable agent must declare that capability and use a service-owned, non-personal state namespace.

## 5. Memory Lifecycle

### 5.1 Per-user resource domain

The memory resource domain owns all material derived from a user's Atong memory:

- episodic and semantic JSONL;
- persisted recall index;
- dream, skill, status, and other projections;
- optional per-user `.git` repository;
- live memory handles, index objects, and Butler instances.

The domain exposes one coordinated purge operation. Callers must not reconstruct hard deletion by invoking individual file helpers.

### 5.2 Irreversible hard deletion

`forgetAll` means hard deletion:

1. Acquire the user's exclusive resource lock and block new capture, maintenance, index persistence, and projection writes.
2. Evict or stop the live personal Butler and invalidate all handles and index caches for that user.
3. Remove the complete per-user directory, including `.git` and `recall-index.json`.
4. Clear process caches before allowing a new empty namespace to be created.
5. Record an audit event containing actor, target user, time, and outcome, but no deleted content or content hashes.

A failed filesystem removal returns an error and keeps the namespace unavailable until an operator or retry completes the purge. The system must not report success after partial deletion.

### 5.3 Complete scans instead of a larger cap

The storage API gains cursor-based page traversal. A page remains bounded, but internal consumers must scan until the cursor is exhausted:

- budget enforcement;
- semantic deduplication;
- atomic-fact source scans;
- export;
- entry existence checks used by delete;
- migrations and secret scans.

No API may describe a result as complete if it stopped at an adapter cap. Export can use a paginated download protocol or assemble all pages within a separately declared response-byte limit; reaching that byte limit returns an explicit continuation token rather than silent truncation.

## 6. Secret Handling

### 6.1 Detection boundary

Trusted user ingress runs a deterministic detector before task payloads are appended to transcripts or sent to an LLM. Detected spans are replaced with opaque pending-secret tokens; the original value is held only in a short-lived pending-secret buffer. Automatic capture, explicit `remember`, and model/tool output pass through the same detector before persistence. Initial coverage includes API keys, bearer/access tokens, password assignments, PEM private keys, and known provider token shapes. Detection metadata must never include the secret value in logs.

This is a two-sided boundary: ingress prevents user-supplied secrets from entering transcripts and prompts, while egress prevents a provider or tool from echoing a secret into its response. A pending-secret token is not a credential and cannot be used outside the confirmation flow.

### 6.2 User-confirmed vault storage

When a secret is detected:

1. Do not write the plaintext to memory or recall indexes.
2. Create a governed confirmation item that describes the detected type and intended label without echoing the value.
3. On approval, store the value through the existing per-user encrypted vault/credential service.
4. Store only an opaque `secretRef`, label, type, and non-sensitive usage metadata in memory.
5. On denial, discard the pending plaintext and retain no recoverable copy.

Pending plaintext must be held in a bounded, short-lived process-local buffer and must not enter normal task transcripts. Denial, expiry, hard deletion, or process shutdown destroys the pending entry. Restart before approval invalidates it; the user must submit the value again. An encrypted pending-secret store would require a separate approved design because it changes the agreed "store after confirmation" rule.

### 6.3 Controlled use

Providers and MCP adapters resolve `secretRef` server-side and receive the value directly. The LLM sees metadata and operation results, not the plaintext secret. Tool results, errors, tracing, and audit events pass through secret redaction as a defense in depth measure.

## 7. Fact Provenance and Correction

New conversational capture stores user and assistant content as distinguishable entries with speaker metadata. Only these sources may produce a normal semantic fact:

- a `speaker=user` entry;
- an entry carrying an explicit user-confirmation marker.

Assistant output alone is never eligible. Each generated semantic fact carries:

```ts
interface FactProvenance {
  sourceEntryIds: string[]
  speaker: 'user'
  evidence: string
  confidence: number
  confirmedByUser: boolean
}
```

Evidence is a bounded excerpt from the user's source entry and is subject to the same secret redaction. A correction closes the old fact's validity interval and links the replacement with `supersedes`; it does not silently rewrite history.

Existing atomic facts without this provenance become `legacy-unverified`. They remain visible in the privacy view but are excluded from high-confidence fact injection until the user confirms them or they are re-derived from eligible source entries.

## 8. MCP Resource Scopes

### 8.1 Scope model

```ts
type McpScope =
  | { kind: 'personal'; ownerUserId: string }
  | {
      kind: 'organization'
      allowedRoles: Array<'owner' | 'admin' | 'member' | 'viewer'>
      toolPolicies: Record<string, 'read' | 'write' | 'deny'>
    }
```

Personal MCP credentials and tools are visible only to the matching `local_user`. An organization connection may be shared at the transport layer, but its visible toolset and execution authorization are filtered for every actor.

### 8.2 Local policy is authoritative

- `read`: allowed roles may execute inline.
- `write`: allowed roles enter governed approval.
- `deny` or missing policy: the tool is not advertised and direct execution is rejected.
- `readOnlyHint`, `destructiveHint`, descriptions, and name heuristics are advisory inputs shown during configuration only.
- Organization scope and tool policies may be created or changed only by owner/admin.
- Existing MCP configurations with no scope or policy are disabled for personal agents until classified.

### 8.3 Federation

Remote MCP is denied by default. An organization tool must explicitly allow federation in local policy before it can be exposed to a remote principal. Remote metadata cannot downgrade a write to a read, and every invocation is checked again on the serving hub.

## 9. Roles and Approvals

The policy applies to all agents and entry points:

- `viewer` cannot run workflows.
- A `member` may run only published, member-facing workflows allowed by current membership policy.
- External communication, spending, and organization writes initiated by a member require an owner/admin approver other than the initiator.
- Owner/admin personal-resource operations may be self-approved.
- Organization-level high-risk actions may require a second eligible owner/admin according to the existing action risk classification.
- If no eligible approver exists, execution fails with `no_eligible_approver`; it never falls back to initiator self-approval.
- Approval resolution revalidates actor, approver, membership, resource scope, and action classification before executing the side effect.

Audit records include initiator, approver, resource scope, risk class, channel, and executor without secret values.

## 10. Migration

### 10.1 Existing memory

A migration scan examines complete memory pages for secret-like text. Affected entries are immediately quarantined from frozen-block injection and recall. The user is offered two choices:

- move the detected value into the encrypted vault and replace the entry with an opaque reference;
- permanently delete the entry.

The system does not choose on the user's behalf. Indexes are rebuilt after each migration decision.

### 10.2 Existing facts

Facts with no eligible provenance are marked `legacy-unverified`. This is additive metadata; source JSONL remains inspectable until the user confirms, forgets, or hard-deletes it.

### 10.3 Existing MCP configuration

Unscoped MCP rows remain administratively visible but are not exposed to personal agents. Owner/admin assigns personal or organization scope, allowed roles, and a policy for every tool before activation.

### 10.4 Existing tasks

Persisted tasks without a trusted actor context can resume only if their target operation is system-capable and non-personal. Other tasks fail closed with an actionable migration error instead of guessing an owner.

## 11. Error Handling

- Missing or malformed actor context: `trusted_actor_required`.
- Remote access to a personal resource: `personal_resource_forbidden`.
- Missing current membership: `membership_required`.
- Viewer workflow execution: `role_forbidden`.
- Missing MCP policy: `mcp_tool_unclassified`.
- No eligible approver: `no_eligible_approver`.
- Partial or failed hard deletion: `memory_purge_incomplete`; keep namespace locked.
- Export continuation required: return a cursor and explicit incomplete status.
- Secret confirmation expiry: `pending_secret_expired`; never reconstruct from memory or logs.

Errors shown to remote callers avoid disclosing whether a local user, credential, memory entry, or MCP resource exists.

## 12. Verification Gates

### 12.1 Trusted identity

- A federated caller using the same user id as a local member cannot read, recall, capture, or forget the member's memory.
- An unbound remote principal cannot call a personal agent, vault, reminder, notebook, usage view, or personal MCP.
- Child dispatch preserves principal, role attribution, quota owner, and audit actor.
- System work cannot enter `_local` personal memory.

### 12.2 Memory and secrets

- Hard delete concurrent with capture cannot leave or recreate JSONL, index, projections, or Git history.
- A real Host restart after purge cannot recover deleted content.
- More than 500 entries participate in budget, deduplication, export, migration, and deletion checks.
- Detected secrets never appear in JSONL, index snapshots, prompts, transcripts, tool results, logs, or Git.
- Approved secrets exist only as encrypted vault material plus non-sensitive references.
- Process restart before approval loses the pending secret and cannot recover it from task or transcript state.

### 12.3 Provenance

- User statements can create sourced facts.
- Assistant replies alone cannot create facts.
- User-confirmed content is eligible.
- Corrections close prior facts and create a `supersedes` link.
- Legacy facts are visible but excluded from trusted injection.

### 12.4 MCP and role policy

- Personal MCP cannot be listed or invoked by another user.
- Organization tools obey allowed roles and per-tool policy.
- Forged `readOnlyHint` and read-like names cannot bypass local write policy.
- Remote MCP remains denied without an explicit federation policy.
- Viewer workflow execution is rejected at the policy layer.
- A member cannot approve their own high-risk action.
- Missing approvers fail closed.
- Role changes between park and approval are honored.

### 12.5 Process-level tests

At least one child-process E2E must start the production Host, exercise each persisted boundary, terminate it, restart it, and verify actor attribution, memory state, index state, and pending approval behavior. Hermetic unit tests remain required but are not sufficient evidence for restart safety.

## 13. Delivery Decomposition

The work is implemented as four independently testable tracks in this order:

1. **Trusted actor track:** actor construction, task propagation, membership role resolution, personal-resource gates, and federation isolation.
2. **Memory safety track:** complete scans, coordinated hard deletion, secret vault references, provenance, and legacy quarantine.
3. **MCP and approval track:** scoped MCP resources, local tool policy, shared approver resolver, and role revalidation.
4. **Migration and capstone track:** old-data migration, production restart E2E, documentation alignment, and complete security regression suite.

Each track must preserve fail-closed behavior when a later track is not yet configured. No track may temporarily map an unknown or remote actor to a local member for compatibility.
