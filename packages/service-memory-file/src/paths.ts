/**
 * Path layout for `@gotong/service-memory-file`.
 *
 *   <rootDir>/                            (ServiceInitCtx.rootDir)
 *   ├─ agent/<agentId>/                   (Owner kind='agent')
 *   │  ├─ episodic.jsonl
 *   │  ├─ semantic.jsonl
 *   │  └─ working.jsonl
 *   ├─ workflow-run/<runId>/              (Owner kind='workflow-run')
 *   │  └─ ...
 *   ├─ shared/<groupId>/                  (Owner kind='shared')
 *   │  └─ ...
 *   └─ .trash/
 *      └─ <trashRefId>/
 *         ├─ meta.json                    (the TrashRef JSON)
 *         └─ payload/                     (the entire owner directory, moved)
 *
 * Why all-jsonl: keeping every kind in the same file shape makes
 * `recall` / `list` / `forget(id)` symmetric across kinds. The RFC
 * §9 example showed `semantic.md` + `working/<taskId>.json`; the
 * plugin owns inner layout (per §9 "Each plugin owns its sub-tree")
 * and chose consistency over the example.
 *
 * Why plugin-local trash (`<rootDir>/.trash/` instead of
 * `services/.trash/` shown in RFC §9): keeps the SDK contract small
 * — no `trashRoot` field on ServiceInitCtx. The Hub aggregates by
 * asking each plugin for its trash entries (PR-5).
 */

import { join } from 'node:path'
import type { Owner, MemoryKind } from '@gotong/services-sdk'
import { assertSafeOwnerId, ownerKey } from '@gotong/services-sdk'

/**
 * Absolute path to an owner's directory under `<rootDir>`.
 *
 * `assertSafeOwnerId` runs first — defense-in-depth so a hostile or
 * buggy caller can't pass `{kind:'agent', id:'../shared/group-x'}`
 * and escape into another tenant's tree. `resolveOwner` in the SDK
 * already validates at scope-translation time, but plugins receive
 * Owners through several wire paths and the cost of re-asserting is
 * a single string check.
 */
export function ownerDir(rootDir: string, owner: Owner): string {
  assertSafeOwnerId(owner.id)
  return join(rootDir, owner.kind, owner.id)
}

/** Absolute path to the jsonl file for a given (owner, kind). */
export function kindFile(rootDir: string, owner: Owner, kind: MemoryKind): string {
  return join(ownerDir(rootDir, owner), `${kind}.jsonl`)
}

/** Absolute path to this plugin's local trash root. */
export function trashRoot(rootDir: string): string {
  return join(rootDir, '.trash')
}

/** Absolute path to one trash entry's directory. */
export function trashEntryDir(rootDir: string, trashId: string): string {
  return join(trashRoot(rootDir), trashId)
}

/** Path to the meta.json file inside a trash entry. */
export function trashMetaFile(rootDir: string, trashId: string): string {
  return join(trashEntryDir(rootDir, trashId), 'meta.json')
}

/** Path to the payload directory inside a trash entry. */
export function trashPayloadDir(rootDir: string, trashId: string): string {
  return join(trashEntryDir(rootDir, trashId), 'payload')
}

/**
 * Stable owner label for log messages — never a path. Use {@link
 * ownerKey} from the SDK for that.
 */
export function ownerLabel(owner: Owner): string {
  return ownerKey(owner)
}
