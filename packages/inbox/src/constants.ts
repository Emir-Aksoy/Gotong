/**
 * Wire / protocol constants for the member task inbox.
 *
 * These are deliberately plain string literals (not imported across packages)
 * so `@gotong/workflow`'s `human:` step sugar can dispatch to the same
 * capability without `@gotong/workflow` depending on `@gotong/inbox`. They
 * are a stable contract, exactly like the `gotong.workflow/v1` schema id.
 */

/**
 * The single capability a workflow (or any agent) dispatches to when it needs
 * a human decision. One capability for all kinds — the kind lives in the
 * payload, keeping the scheduler / runner unaware of HITL specifics.
 */
export const HUMAN_CAPABILITY = 'gotong.human/v1'

/**
 * The fixed participant id the host registers the broker under. Fixed (not
 * generated) so `HostInboxService.resolve` can `hub.resumeTask(BROKER_ID, …)`
 * without a lookup.
 */
export const HUMAN_INBOX_PARTICIPANT_ID = 'gotong:human-inbox'

/**
 * The `resumeAt` a human task is parked at: ~8000 years out (2286-11-20 in ms
 * since epoch). A human — not a timer — wakes a human task, so the resume
 * sweep's `resume_at <= now` must be false forever; the ONLY resumer is a
 * member's `/me` action via `HostInboxService.resolve`. Same sentinel the
 * workflow lifecycle E2E uses for its "never" parking value.
 */
export const NEVER_RESUME_AT = 9_999_999_999_000
