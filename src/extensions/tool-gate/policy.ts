/**
 * Gate policy: which tool calls require explicit user
 * confirmation, and how a confirmation outcome maps to allow/deny.
 *
 * All logic here is pure so the classification and the default-deny behaviour
 * can be unit-tested without the `ExtensionAPI` or a real confirmation dialog.
 */

/**
 * Tool names that mutate state, matched by suffix so the `mcp_` prefix from
 * an MCP filesystem client is covered (`mcp_write_file`, `mcp_edit_file`, …).
 * The bare forms (`write`, `edit`) are matched too, so a tool registered
 * without the prefix is still gated.
 *
 * This is one of two reasons a call requires confirmation — the other is
 * naming a sensitive file, checked separately in `sensitive-files.ts` and
 * combined with this in `index.ts`.
 */
const MUTATING_SUFFIXES = ['write', 'edit', 'write_file', 'edit_file', 'move_file', 'create_directory']

/**
 * Whether a tool call is mutating, and therefore requires confirmation on
 * that basis alone. Read-only tools (`mcp_read_file`, `mcp_list_directory`,
 * `mcp_search_files`, …) are not, though they may still require confirmation
 * for a different reason — see `findSensitiveArgument` in
 * `sensitive-files.ts`. Pure.
 */
export function requiresConfirmation (toolName: string): boolean {
  const lower = toolName.toLowerCase()
  return MUTATING_SUFFIXES.some((s) => lower === s || lower.endsWith(`_${s}`) || lower.endsWith(s))
}

/**
 * A human-readable description of what a call names, shown in the
 * confirmation dialog (after capping — see `describeForPrompt`). Covers the
 * MCP filesystem server's argument shapes, so a multi-file read or a move is
 * not shown as a bare tool name. Pure.
 */
export function describeCall (toolName: string, input: Record<string, unknown>): string {
  const path = typeof input.path === 'string' ? input.path : undefined
  if (path) return `${toolName}: ${path}`

  const source = typeof input.source === 'string' ? input.source : undefined
  const destination = typeof input.destination === 'string' ? input.destination : undefined
  if (source && destination) return `${toolName}: ${source} -> ${destination}`

  const paths = Array.isArray(input.paths) ? input.paths.filter((p) => typeof p === 'string') : []
  if (paths.length > 0) return `${toolName}: ${paths.join(', ')}`

  return toolName
}

/**
 * How much of a description a confirmation dialog will show.
 *
 * Generous on purpose. The prompt is a control, not a label: an operator
 * approving a call they can only half see is not approving anything. Nothing
 * gated today comes near this — the mutating tools take a single `path` or a
 * `source`/`destination` pair — so the cap is a bound on whatever is gated
 * next, not a limit anything currently hits.
 */
const PROMPT_DETAIL_MAX = 800

/**
 * The same description, capped for display in a confirmation dialog. Pure.
 *
 * When it does cut, it says SO and says how much, rather than trailing an
 * ellipsis into silence. The operator needs to know they are being shown a
 * summary — a prompt that hides half of what it is confirming without
 * admitting it is worse than one that shows less honestly.
 */
export function describeForPrompt (detail: string): string {
  if (detail.length <= PROMPT_DETAIL_MAX) return detail
  const hidden = detail.length - PROMPT_DETAIL_MAX
  return `${detail.slice(0, PROMPT_DETAIL_MAX)}\n\n[${hidden} more characters not shown]`
}

/**
 * The raw outcome of asking the user, including the no-UI / timeout cases.
 */
export type ConfirmOutcome = 'approved' | 'rejected' | 'timeout' | 'no-ui'

/** A gate decision: what happens to the call, and why. */
export interface GateDecision {
  outcome: 'allowed' | 'blocked'
  confirmation: ConfirmOutcome
  /** Populated only when blocked; surfaced to the model. */
  reason?: string
}

/**
 * Map a confirmation outcome to a gate decision. Default-deny: anything other
 * than an explicit approval blocks the call. Pure.
 *
 * Only ever called for a call that was actually prompted for — a call
 * requiring neither confirmation reason is allowed before this point, which
 * is why its input type excludes anything but a real prompt outcome.
 */
export function decide (toolName: string, outcome: ConfirmOutcome): GateDecision {
  if (outcome === 'approved') {
    return { outcome: 'allowed', confirmation: 'approved' }
  }
  const why = outcome === 'rejected'
    ? 'user rejected'
    : outcome === 'timeout'
      ? 'confirmation timed out (default deny)'
      : 'no interactive UI to confirm (default deny)'
  return { outcome: 'blocked', confirmation: outcome, reason: `${toolName} blocked: ${why}` }
}
