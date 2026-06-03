/**
 * A CliParticipant that enforces the shared-workspace convention at the hub
 * boundary: before the task prompt reaches the CLI, it is wrapped with the
 * "read AGENTS.md + PROGRESS.md, append your progress" preamble. So whichever
 * agent the router picks, both operate on the same repo (shared `cwd`) AND log
 * to the same progress file — the coordination is guaranteed by the hub, not
 * left to the LLM to remember.
 *
 * Resume (action-gate approval / takeover) flows through the base class's
 * `handleResume`, which carries the already-wrapped prompt in its checkpoint
 * state — so there is no double-wrapping on resume.
 */

import { type Task } from '@aipehub/core'
import { CliParticipant, payloadToText } from '@aipehub/cli-agent'

import { withSharedContext } from './workspace.js'

export class SharedWorkspaceCli extends CliParticipant {
  protected async handleTask(task: Task): Promise<unknown> {
    const wrapped = withSharedContext(payloadToText(task.payload))
    return super.handleTask({ ...task, payload: { prompt: wrapped } })
  }
}
