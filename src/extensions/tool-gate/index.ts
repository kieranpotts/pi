/**
 * Interactive gate on tool CALLS, for eyes-on, at-keyboard Pi sessions.
 *
 * Note what this gates and what it does not: calls to tools that are already
 * active, not which tools exist. Restricting the tool SURFACE is a separate Pi
 * feature (`--tools`, `setActiveTools`, and the `tools` frontmatter key the
 * read-only roles use). A tool this gate never approves is still registered and
 * still offered to the model.
 *
 * Intercepts every tool call before it runs (`tool_call` event) and asks the
 * user to approve it before it proceeds, for two kinds of call:
 *
 *   1. Any call naming a sensitive file — secrets and key material — whether
 *      it reads or writes. There is no separate audit-trail story here: this
 *      extension is for a human watching the session in real time, so the
 *      confirmation dialog IS the control. (Genie's `secret-sentry`
 *      extension covers the away-from-keyboard case, where an absolute block
 *      replaces the prompt because nobody is there to answer it.)
 *   2. Any mutating operation — writes, edits, moves, and directory
 *      creation.
 *
 * Confirmation defaults to deny: a timeout or a missing interactive UI blocks
 * the call. Read-only calls that do not touch a sensitive file pass straight
 * through, unprompted.
 *
 * This extension does no logging. It is built for a human watching the
 * session as it happens, where the dialog itself is the record — there is
 * nobody reading an audit trail after the fact. If you need an append-only
 * record of every call for an unattended agent, see Genie's `secret-sentry`.
 *
 * The policy and the sensitive-file rule live in pure, unit-tested helpers
 * (`policy.ts`, `sensitive-files.ts`); this entry point is the thin glue to
 * the `ExtensionAPI`.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { basename } from 'node:path'
import { decide, describeCall, describeForPrompt, requiresConfirmation, type ConfirmOutcome } from './policy.ts'
import { findSensitiveArgument } from './sensitive-files.ts'

/** Confirmation timeout in milliseconds; on expiry the call is denied. */
const CONFIRM_TIMEOUT_MS = 60_000

export default function (pi: ExtensionAPI): void {
  pi.on('tool_call', async (event, ctx) => {
    const input = event.input as Record<string, unknown>
    const sensitive = findSensitiveArgument(input)

    /* Read-only and non-sensitive: nothing to approve. Everything else —
       mutating, or naming a sensitive file, or both — is prompted below. */
    if (sensitive === undefined && !requiresConfirmation(event.toolName)) {
      return undefined
    }

    const detail = describeCall(event.toolName, input)
    const title = sensitive !== undefined
      ? `Allow ${event.toolName}? (touches sensitive file: ${basename(sensitive)})`
      : `Allow ${event.toolName}?`

    const outcome = await askUser(ctx, title, describeForPrompt(detail))
    const decision = decide(event.toolName, outcome)

    if (decision.outcome === 'blocked') {
      return { block: true, reason: decision.reason }
    }
    return undefined
  })
}

/**
 * Ask the user to confirm, translating the UI result into a ConfirmOutcome.
 * No interactive UI (print/RPC mode) or any non-approval defaults to deny.
 */
async function askUser (
  ctx: { hasUI: boolean, ui: { confirm: (title: string, message: string, opts?: { timeout?: number }) => Promise<boolean> } },
  title: string,
  detail: string
): Promise<ConfirmOutcome> {
  if (!ctx.hasUI) return 'no-ui'
  try {
    const approved = await ctx.ui.confirm(
      title,
      `The agent wants to run:\n\n${detail}\n\nApprove this operation?`,
      { timeout: CONFIRM_TIMEOUT_MS }
    )
    return approved ? 'approved' : 'rejected'
  } catch {
    // Dialog dismissed/aborted/timed out without an explicit answer.
    return 'timeout'
  }
}
