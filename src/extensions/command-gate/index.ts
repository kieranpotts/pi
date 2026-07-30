/**
 * Command gate: a locked-down replacement for Pi's built-in `bash`.
 *
 * Pi ships seven built-in tools — `read`, `bash`, `edit`, `write`, `grep`,
 * `find`, `ls` — and `bash` is the one that subsumes all the others. Anything
 * the `permission-gate` extension asks about (writes, edits, sensitive files)
 * is reachable through the shell without a prompt, because `permission-gate`
 * classifies by tool name and `bash` is not a mutating name. This extension
 * closes that route by replacing `bash` with a version that cannot invoke a
 * shell at all, runs a known-good program directly, and asks the operator about
 * anything it does not recognise.
 *
 * The two extensions are complements, not alternatives:
 *
 *   - `permission-gate` gates by TOOL NAME and file argument, across every tool
 *     including any an MCP client registers. It does not read `command`.
 *   - `command-gate` gates the CONTENTS of a command string, which is the one
 *     argument `permission-gate` cannot interpret.
 *
 * Installed together they do not double-prompt: `permission-gate` treats `bash`
 * as non-mutating and passes it straight through to this tool's own vetting.
 *
 * This extension does no logging, matching `permission-gate` — it is built for
 * a human watching the session in real time, where the confirmation dialog is
 * the record. (Its ancestor, `audited-tools`, wrote an append-only JSONL trail
 * for an unattended containerised agent. That case now lives in Genie, whose
 * `audit-log` extension does the job properly.)
 *
 * The vetting logic is pure and unit-tested (`policy.ts`); `register-bash.ts`
 * holds the tool and the executor. This entry point only reads the environment
 * and resolves the working directory per call.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { buildPolicy } from './policy.ts'
import { registerBashTool } from './register-bash.ts'

/**
 * Comma-separated programs allowed on top of the hardwired read-only set.
 * Present-but-empty clears the default (`git`, `make`); unset keeps it.
 */
const ALLOWLIST_ENV = 'COMMAND_GATE_ALLOWLIST'
/** Comma-separated directories commands may not reach; `none` disables fencing. */
const FENCE_ENV = 'COMMAND_GATE_FENCE'
/** Working directory override. Defaults to the session's own cwd. */
const CWD_ENV = 'COMMAND_GATE_CWD'

export default function (pi: ExtensionAPI): void {
  const envAllowlist = process.env[ALLOWLIST_ENV]
  const envFence = process.env[FENCE_ENV]
  const envCwd = process.env[CWD_ENV]

  /* Resolved per call rather than once at load: the session's cwd can change,
     and the policy's cwd is what relative arguments are fenced against, so a
     stale value would vet against a different directory than it executes in. */
  registerBashTool(pi, (ctx) => buildPolicy(
    envAllowlist,
    envFence,
    envCwd && envCwd.trim() !== '' ? envCwd : ctx.cwd
  ))
}
