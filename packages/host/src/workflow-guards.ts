import type { DispatchStrategy } from '@gotong/core'
import type { ParallelStep, Step, WorkflowDefinition } from '@gotong/workflow'

export function assertNoSelfTriggerCycle(def: WorkflowDefinition): void {
  const triggerCap = def.trigger.capability
  for (let i = 0; i < def.steps.length; i++) {
    const step = def.steps[i]!
    const stepPath = `workflow.steps[${i}]`
    if (isParallelStep(step)) {
      for (let j = 0; j < step.branches.length; j++) {
        assertStrategyDoesNotTriggerSelf(
          def.id,
          triggerCap,
          step.branches[j]!.dispatch.strategy,
          `${stepPath}.branches[${j}].dispatch.strategy`,
        )
      }
    } else {
      assertStrategyDoesNotTriggerSelf(
        def.id,
        triggerCap,
        step.dispatch.strategy,
        `${stepPath}.dispatch.strategy`,
      )
    }
  }
}

function isParallelStep(step: Step): step is ParallelStep {
  return step.kind === 'parallel'
}

function assertStrategyDoesNotTriggerSelf(
  workflowId: string,
  triggerCap: string,
  strategy: DispatchStrategy,
  path: string,
): void {
  const capabilities =
    strategy.kind === 'capability'
      ? strategy.capabilities
      : strategy.kind === 'broadcast'
        ? strategy.capabilities ?? []
        : []
  if (!capabilities.includes(triggerCap)) return
  throw new Error(
    `workflow '${workflowId}' has a self-trigger cycle at ${path}: dispatches to its own trigger capability '${triggerCap}'`,
  )
}
