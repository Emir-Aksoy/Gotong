export type ActorRole = 'owner' | 'admin' | 'member' | 'viewer'

export type TaskActorContext =
  | {
      kind: 'local_user'
      principal: { kind: 'user'; id: string }
      orgId: string
      userId: string
      role: ActorRole
    }
  | {
      kind: 'remote_principal'
      principal: { kind: 'peer'; id: string }
      peerHubId: string
      remoteOrgId: string
      remoteUserId: string
    }
  | {
      kind: 'system'
      principal: { kind: 'agent' | 'hub'; id: string }
      serviceId: string
    }

const ACTOR_ROLES = new Set<ActorRole>(['owner', 'admin', 'member', 'viewer'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function invalid(reason: string): never {
  throw new TypeError(`invalid task actor context: ${reason}`)
}

/**
 * Validate and copy a trusted actor envelope before it becomes durable task
 * state. The returned object contains only protocol-owned fields, so callers
 * cannot smuggle mutable or unrecognised identity data into the transcript.
 */
export function assertTaskActorContext(value: unknown): TaskActorContext {
  if (!isRecord(value)) invalid('expected an object')

  const principal = value.principal
  if (!isRecord(principal) || !nonEmptyString(principal.id)) {
    invalid('principal must contain a non-empty id')
  }

  if (value.kind === 'local_user') {
    if (principal.kind !== 'user') invalid('local user principal must be a user')
    if (!nonEmptyString(value.orgId) || !nonEmptyString(value.userId)) {
      invalid('local user requires orgId and userId')
    }
    if (principal.id !== value.userId) invalid('local user principal id mismatch')
    if (!ACTOR_ROLES.has(value.role as ActorRole)) invalid('unknown local user role')
    return {
      kind: 'local_user',
      principal: { kind: 'user', id: principal.id },
      orgId: value.orgId,
      userId: value.userId,
      role: value.role as ActorRole,
    }
  }

  if (value.kind === 'remote_principal') {
    if (principal.kind !== 'peer') invalid('remote principal must be a peer')
    if (
      !nonEmptyString(value.peerHubId) ||
      !nonEmptyString(value.remoteOrgId) ||
      !nonEmptyString(value.remoteUserId)
    ) {
      invalid('remote principal requires peerHubId, remoteOrgId, and remoteUserId')
    }
    if (principal.id !== value.peerHubId) invalid('remote peer principal id mismatch')
    return {
      kind: 'remote_principal',
      principal: { kind: 'peer', id: principal.id },
      peerHubId: value.peerHubId,
      remoteOrgId: value.remoteOrgId,
      remoteUserId: value.remoteUserId,
    }
  }

  if (value.kind === 'system') {
    if (principal.kind !== 'agent' && principal.kind !== 'hub') {
      invalid('system principal must be an agent or hub')
    }
    if (!nonEmptyString(value.serviceId)) invalid('system actor requires serviceId')
    if (principal.id !== value.serviceId) invalid('system principal id mismatch')
    return {
      kind: 'system',
      principal: { kind: principal.kind, id: principal.id },
      serviceId: value.serviceId,
    }
  }

  return invalid('unknown kind')
}
