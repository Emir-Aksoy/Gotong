/**
 * SEN-M5 承重门 — the butler's benign membership eye (`list_members`).
 *
 * Pins the projection's contract (disclosure fork decided as option A —
 * every member sees name + role + user id):
 *
 *   1. email red line — identity's User row carries email; the surface
 *      SELECTs only id/displayName, so the projection row has no email field
 *      and the rendered text can never leak it;
 *   2. the user id IS the payload — a workflow assignee needs the id, so it
 *      renders per row plus the「填 id 不是名字」hint;
 *   3. honest gaps — a missing membership row renders (角色未知), an unknown
 *      role prints as-is, a null displayName renders (未设名) — never a
 *      guessed default;
 *   4. absence is honest — empty roster / read failure → friendly text,
 *      never a crash.
 */

import { describe, expect, it } from 'vitest'

import {
  buildButlerMembersToolset,
  buildButlerMemberSurface,
  type ButlerMemberRow,
  type ButlerMemberSurface,
} from '../src/personal-butler-members.js'

const surfaceOf = (rows: ButlerMemberRow[]): ButlerMemberSurface => ({
  listForButler: async () => rows,
})

const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.map((c) => c.text ?? '').join('\n')

describe('SEN-M5 — buildButlerMemberSurface(identity 窄切片拼接)', () => {
  // Sloppy-upstream simulation: real identity User rows DO carry email —
  // structural typing admits them, the join must strip them.
  const users = () => [
    { id: 'u-dad', displayName: '爸爸', email: 'dad@secret-family.example' },
    { id: 'u-kid', displayName: '小明', email: 'kid@secret-family.example' },
    { id: 'u-new', displayName: null, email: 'new@secret-family.example' },
  ]
  const roles: Record<string, string> = { 'u-dad': 'owner', 'u-kid': 'member' }
  const surface = buildButlerMemberSurface({
    users,
    membershipRole: (id) => roles[id] ?? null,
  })

  it('joins name+role+id; email structurally never enters the projection', async () => {
    const roster = await surface.listForButler()
    expect(roster).toEqual([
      { userId: 'u-dad', name: '爸爸', role: 'owner' },
      { userId: 'u-kid', name: '小明', role: 'member' },
      { userId: 'u-new', name: null, role: null },
    ])
    expect('email' in roster[0]!).toBe(false)
  })

  it('sorts owners first, then admins, then members; unknown roles last', async () => {
    const mixed = buildButlerMemberSurface({
      users: () => [
        { id: 'a', displayName: 'viewer 甲', email: 'x' },
        { id: 'b', displayName: 'member 乙', email: 'x' },
        { id: 'c', displayName: 'owner 丙', email: 'x' },
        { id: 'd', displayName: 'martian 丁', email: 'x' },
        { id: 'e', displayName: 'admin 戊', email: 'x' },
      ],
      membershipRole: (id) =>
        (({ a: 'viewer', b: 'member', c: 'owner', d: 'martian', e: 'admin' }) as Record<string, string>)[id] ?? null,
    })
    const roster = await mixed.listForButler()
    expect(roster.map((r) => r.role)).toEqual(['owner', 'admin', 'member', 'viewer', 'martian'])
  })

  it('rendered text never contains an email even when upstream rows carry them', async () => {
    const roster = await surface.listForButler()
    const out = textOf(await buildButlerMembersToolset({ members: surfaceOf(roster) }).callTool('list_members', {}))
    expect(out).not.toContain('secret-family.example')
    expect(out).not.toContain('@')
  })
})

describe('SEN-M5 — list_members(渲染诚实)', () => {
  const render = async (rows: ButlerMemberRow[]): Promise<string> =>
    textOf(await buildButlerMembersToolset({ members: surfaceOf(rows) }).callTool('list_members', {}))

  it('renders name — role(中文括注); id per row + the assignee hint', async () => {
    const out = await render([
      { userId: 'u-dad', name: '爸爸', role: 'owner' },
      { userId: 'u-mom', name: '妈妈', role: 'admin' },
      { userId: 'u-kid', name: '小明', role: 'member' },
      { userId: 'u-gx', name: '奶奶', role: 'viewer' },
    ])
    expect(out).toContain('hub 里的成员(4 人)')
    expect(out).toContain('- 爸爸 — owner(拥有者);id: u-dad')
    expect(out).toContain('- 妈妈 — admin(管理员);id: u-mom')
    expect(out).toContain('- 小明 — member(成员);id: u-kid')
    expect(out).toContain('- 奶奶 — viewer(只读);id: u-gx')
    expect(out).toContain('填 id 那串,不是名字')
  })

  it('honest gaps: missing role → (角色未知); unknown role prints as-is; null name → (未设名)', async () => {
    const out = await render([
      { userId: 'u-a', name: '甲', role: null },
      { userId: 'u-b', name: '乙', role: 'martian' },
      { userId: 'u-c', name: null, role: 'member' },
    ])
    expect(out).toContain('- 甲 — (角色未知);id: u-a')
    expect(out).toContain('- 乙 — martian;id: u-b')
    expect(out).toContain('- (未设名) — member(成员);id: u-c')
  })

  it('empty roster → honest line; surface throw → friendly error; unknown tool → typed refusal', async () => {
    expect(await render([])).toContain('还没有任何成员')

    const broken = buildButlerMembersToolset({
      members: { listForButler: async () => { throw new Error('db locked') } },
    })
    const err = await broken.callTool('list_members', {})
    expect(err.isError).toBe(true)
    expect(textOf(err)).toContain('暂时读不到')

    const bad = await buildButlerMembersToolset({ members: surfaceOf([]) }).callTool('drop_users', {})
    expect(bad.isError).toBe(true)
  })

  it('listTools: exactly the one read-only tool, description names no directory tool', () => {
    const tools = buildButlerMembersToolset({ members: surfaceOf([]) }).listTools()
    expect(tools.map((t) => t.name)).toEqual(['list_members'])
    expect(tools[0]!.description).not.toMatch(/hub_health|my_status|list_my_llms|list_schedules/)
  })
})
