/**
 * TN-M1 — the butler's file-first task notebook.
 *
 * Pins the four load-bearing properties: (1) file-first durability — a fresh
 * store instance over the same file sees everything, ids stay monotonic across
 * "restarts"; (2) honest failure — a corrupt file is QUARANTINED (bytes
 * preserved on disk), never silently destroyed, and explicit caps refuse
 * loudly; (3) the recitation digest — null when empty (prompt byte-identical
 * for non-users), one line per open task with the NEXT undone step, capped
 * lines; (4) the toolset never throws a turn — every refused op comes back as
 * a friendly `isError` tool result the model can read and correct.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ButlerError,
  TASK_NOTEBOOK_LIMITS,
  composeContextProbes,
  createTaskNotebookToolset,
  openTaskNotebook,
  type TaskNotebook,
} from '../src/index.js'
import type { Task } from '@gotong/core'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gotong-tn-test-'))
  file = join(dir, 'tasks.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const NOW = 1_700_000_000_000
const openNb = (now?: () => number): TaskNotebook => openTaskNotebook({ file, now: now ?? (() => NOW) })

const fakeTask = { id: 't1', from: 'user:me', payload: 'hi' } as unknown as Task

describe('TaskNotebook store (TN-M1)', () => {
  it('open → list round-trip, and a FRESH instance over the same file sees it (file-first)', async () => {
    const nb = openNb()
    const t = await nb.openNote({ title: '筹备生日会', steps: ['订蛋糕', '发邀请'], note: '周六办' })
    expect(t.id).toBe('tn-1')
    expect(t.status).toBe('open')

    const again = openNb() // simulate restart: new instance, same file
    const all = await again.list()
    expect(all).toHaveLength(1)
    expect(all[0]!.title).toBe('筹备生日会')
    expect(all[0]!.steps.map((s) => s.text)).toEqual(['订蛋糕', '发邀请'])
    expect(all[0]!.note).toBe('周六办')
  })

  it('ids stay monotonic across restart (nextId persists — closed ids never reused)', async () => {
    const nb = openNb()
    await nb.openNote({ title: 'A', steps: ['x'] })
    await nb.closeNote('tn-1')
    const nb2 = openNb()
    const b = await nb2.openNote({ title: 'B', steps: ['y'] })
    expect(b.id).toBe('tn-2')
  })

  it('quarantines a corrupt file (bytes preserved) and restarts empty — never silent destruction', async () => {
    writeFileSync(file, 'not json {', 'utf8')
    const nb = openNb()
    expect(await nb.list()).toEqual([])
    const quarantined = readdirSync(dir).filter((f) => f.startsWith('tasks.json.corrupt-'))
    expect(quarantined).toHaveLength(1)
    expect(readFileSync(join(dir, quarantined[0]!), 'utf8')).toBe('not json {')
    // and the notebook is fully usable after
    await nb.openNote({ title: 'A', steps: ['x'] })
    expect((await nb.list())[0]!.id).toBe('tn-1')
  })

  it('a valid-JSON-but-wrong-shape file is also quarantined', async () => {
    writeFileSync(file, JSON.stringify({ v: 1, nextId: 'oops', tasks: [] }), 'utf8')
    const nb = openNb()
    expect(await nb.list()).toEqual([])
    expect(readdirSync(dir).some((f) => f.startsWith('tasks.json.corrupt-'))).toBe(true)
  })

  it('refuses past the open-task cap with an explicit error (no silent caps)', async () => {
    const nb = openNb()
    for (let i = 0; i < TASK_NOTEBOOK_LIMITS.maxOpenTasks; i++) {
      await nb.openNote({ title: `t${i}`, steps: ['x'] })
    }
    await expect(nb.openNote({ title: 'over', steps: ['x'] })).rejects.toMatchObject({
      code: 'task_note_limit',
    })
    // closing one frees a slot
    await nb.closeNote('tn-1')
    await expect(nb.openNote({ title: 'ok now', steps: ['x'] })).resolves.toMatchObject({ status: 'open' })
  })

  it('refuses bad input: empty steps / oversize title / oversize step / bad note type', async () => {
    const nb = openNb()
    await expect(nb.openNote({ title: 'x', steps: [] })).rejects.toMatchObject({ code: 'task_note_invalid' })
    await expect(
      nb.openNote({ title: 'x'.repeat(TASK_NOTEBOOK_LIMITS.maxTitleChars + 1), steps: ['a'] }),
    ).rejects.toMatchObject({ code: 'task_note_invalid' })
    await expect(
      nb.openNote({ title: 'x', steps: ['s'.repeat(TASK_NOTEBOOK_LIMITS.maxStepChars + 1)] }),
    ).rejects.toMatchObject({ code: 'task_note_invalid' })
    await expect(
      nb.openNote({ title: 'x', steps: Array.from({ length: TASK_NOTEBOOK_LIMITS.maxSteps + 1 }, () => 's') }),
    ).rejects.toMatchObject({ code: 'task_note_invalid' })
  })

  it('updateNote ticks 1-based steps, appends steps, sets/clears the note', async () => {
    const nb = openNb()
    await nb.openNote({ title: 'A', steps: ['一', '二'] })
    const t1 = await nb.updateNote('tn-1', { doneSteps: [1], note: '进行中' })
    expect(t1.steps[0]!.done).toBe(true)
    expect(t1.steps[1]!.done).toBe(false)
    expect(t1.note).toBe('进行中')
    const t2 = await nb.updateNote('tn-1', { addSteps: ['三'], note: '' })
    expect(t2.steps.map((s) => s.text)).toEqual(['一', '二', '三'])
    expect(t2.note).toBeUndefined()
  })

  it('updateNote refuses a bad step index and add_steps past the step cap', async () => {
    const nb = openNb()
    await nb.openNote({ title: 'A', steps: ['一', '二'] })
    await expect(nb.updateNote('tn-1', { doneSteps: [3] })).rejects.toMatchObject({ code: 'task_note_invalid' })
    await expect(nb.updateNote('tn-1', { doneSteps: [0] })).rejects.toMatchObject({ code: 'task_note_invalid' })
    const room = TASK_NOTEBOOK_LIMITS.maxSteps - 2
    await expect(
      nb.updateNote('tn-1', { addSteps: Array.from({ length: room + 1 }, () => 's') }),
    ).rejects.toMatchObject({ code: 'task_note_limit' })
  })

  it('unknown / already-closed ids refuse with task_note_not_found', async () => {
    const nb = openNb()
    await expect(nb.updateNote('tn-9', { doneSteps: [1] })).rejects.toMatchObject({ code: 'task_note_not_found' })
    await nb.openNote({ title: 'A', steps: ['x'] })
    await nb.closeNote('tn-1', 'dropped')
    await expect(nb.updateNote('tn-1', { doneSteps: [1] })).rejects.toMatchObject({ code: 'task_note_not_found' })
    await expect(nb.closeNote('tn-1')).rejects.toMatchObject({ code: 'task_note_not_found' })
  })

  it('no tmp file is left behind after a save (tmp+rename)', async () => {
    const nb = openNb()
    await nb.openNote({ title: 'A', steps: ['x'] })
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(existsSync(file)).toBe(true)
  })
})

describe('digest (the recitation card)', () => {
  it('is null when there are no open tasks — prompt stays byte-identical for non-users', async () => {
    const nb = openNb()
    expect(await nb.digest()).toBeNull()
    await nb.openNote({ title: 'A', steps: ['x'] })
    await nb.closeNote('tn-1')
    expect(await nb.digest()).toBeNull()
  })

  it('renders one line per open task with the NEXT undone step and progress', async () => {
    const nb = openNb()
    await nb.openNote({ title: '筹备生日会', steps: ['订蛋糕', '发邀请', '布置'] })
    await nb.updateNote('tn-1', { doneSteps: [1] })
    const d = await nb.digest()
    expect(d).toContain('[tn-1] 筹备生日会(1/3 步)')
    expect(d).toContain('下一步: 发邀请')
    expect(d).toContain('update_task_note') // the card tells the model what to do with it
  })

  it('an all-steps-done task points at close_task_note instead of a next step', async () => {
    const nb = openNb()
    await nb.openNote({ title: 'A', steps: ['一'] })
    await nb.updateNote('tn-1', { doneSteps: [1] })
    const d = await nb.digest()
    expect(d).toContain('close_task_note')
    expect(d).not.toContain('下一步')
  })

  it('caps at digestLines lines and says how many more exist', async () => {
    const nb = openNb()
    for (let i = 0; i < TASK_NOTEBOOK_LIMITS.digestLines + 2; i++) {
      await nb.openNote({ title: `任务${i}`, steps: ['x'] })
    }
    const d = (await nb.digest())!
    const taskLines = d.split('\n').filter((l) => l.startsWith('- [tn-'))
    expect(taskLines).toHaveLength(TASK_NOTEBOOK_LIMITS.digestLines)
    expect(d).toContain('还有 2 条')
  })
})

describe('createTaskNotebookToolset', () => {
  it('lists exactly the 4 notebook tools', async () => {
    const tools = await createTaskNotebookToolset(openNb()).listTools()
    expect(tools.map((t) => t.name)).toEqual([
      'open_task_note',
      'update_task_note',
      'close_task_note',
      'list_task_notes',
    ])
    // the boundary is written into the tool description (notebook ≠ workflow engine)
    expect(tools[0]!.description).toContain('create_workflow')
  })

  it('open → update → close happy path through the tool surface', async () => {
    const ts = createTaskNotebookToolset(openNb())
    const r1 = await ts.callTool('open_task_note', { title: '筹备生日会', steps: ['订蛋糕', '发邀请'] })
    expect(r1.isError).toBeUndefined()
    expect(JSON.stringify(r1.content)).toContain('tn-1')

    const r2 = await ts.callTool('update_task_note', { id: 'tn-1', done_steps: [1, 2] })
    expect(JSON.stringify(r2.content)).toContain('close_task_note') // all done → nudge to close

    const r3 = await ts.callTool('close_task_note', { id: 'tn-1' })
    expect(JSON.stringify(r3.content)).toContain('归档')

    const r4 = await ts.callTool('list_task_notes', {})
    expect(JSON.stringify(r4.content)).toContain('已完成')
  })

  it('a refused op comes back as a friendly isError result — never a thrown turn', async () => {
    const ts = createTaskNotebookToolset(openNb())
    const r = await ts.callTool('update_task_note', { id: 'tn-404', done_steps: [1] })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.content)).toContain('tn-404')
    const r2 = await ts.callTool('open_task_note', { title: '', steps: ['x'] })
    expect(r2.isError).toBe(true)
    const r3 = await ts.callTool('no_such_tool', {})
    expect(r3.isError).toBe(true)
  })
})

describe('composeContextProbes', () => {
  it('joins non-null cards with a blank line, in order', async () => {
    const probe = composeContextProbes(
      async () => 'card-A',
      undefined,
      async () => null,
      async () => 'card-B',
    )
    expect(await probe(fakeTask)).toBe('card-A\n\ncard-B')
  })

  it('all-null → null (nothing injected)', async () => {
    const probe = composeContextProbes(async () => null, undefined)
    expect(await probe(fakeTask)).toBeNull()
  })

  it('one sick probe degrades to "its card missing", not "no cards at all"', async () => {
    const probe = composeContextProbes(
      async () => {
        throw new Error('sick')
      },
      async () => 'still-here',
    )
    expect(await probe(fakeTask)).toBe('still-here')
  })
})

describe('ButlerError codes', () => {
  it('notebook errors are typed ButlerError with the TN codes', async () => {
    const nb = openNb()
    try {
      await nb.updateNote('tn-1', { doneSteps: [1] })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ButlerError)
      expect((err as ButlerError).code).toBe('task_note_not_found')
    }
  })
})
