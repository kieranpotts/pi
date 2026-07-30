/**
 * The gated `bash` replacement.
 *
 * Registering a tool named `bash` overrides Pi's built-in one (Pi resolves an
 * extension tool of the same name in preference, and warns in interactive mode
 * that it has done so). Every command is vetted through `policy.ts` before
 * anything runs; an unrecognised program is put to the operator, and only then
 * executed.
 *
 * NO SHELL IS EVER INVOKED. This is the load-bearing property, and it is why
 * this reimplements execution with `execFile` instead of delegating to the
 * built-in bash tool, which would otherwise have given us streaming output and
 * truncation for free. Handing a vetted string to a real shell would undo the
 * vetting: `$(…)` and `*` are allowed through as inert literals precisely
 * because nothing downstream expands them, and a shell would expand them. The
 * check and the executor have to agree about that, so they stay together.
 *
 * Confirmation defaults to DENY, matching `tool-gate`: a timeout, a
 * dismissed dialog, or a non-interactive session (print/RPC mode with no UI)
 * all block the command rather than waving it through.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { describeForPrompt, vetCommand, type CommandPolicy } from './policy.ts'
import { fail, ok, type BashResult } from './tool-result.ts'

/** A command may run for at most this long before being killed. */
const COMMAND_TIMEOUT_MS = 30_000
/** Cap captured output so a runaway command cannot flood the model context. */
const MAX_BUFFER = 1024 * 1024
/** How long the operator has to answer a confirmation before it defaults to deny. */
const CONFIRM_TIMEOUT_MS = 60_000

/** How the effective policy is derived for a given call. */
export type PolicyResolver = (ctx: ExtensionContext) => CommandPolicy

/**
 * Register the gated `bash` tool against `pi`.
 *
 * The policy is resolved per call rather than captured once, so the working
 * directory tracks the session's — Pi's cwd can change mid-session, and a fence
 * resolving relative paths against a stale directory would be checking the
 * wrong thing.
 *
 * `renderCall` and `renderResult` are deliberately not supplied: Pi inherits
 * the built-in bash renderer per slot when an override omits them, so the
 * command and its output keep their normal appearance in the TUI.
 */
export function registerBashTool (pi: ExtensionAPI, resolvePolicy: PolicyResolver): void {
  pi.registerTool({
    name: 'bash',
    label: 'bash',
    description:
      'Run a single program with literal arguments. ' +
      'No shell is invoked: pipes, redirection, substitution, globs, and command chaining are rejected, ' +
      'so run one program per call rather than combining them. ' +
      'Common read-only inspection tools run directly; anything else asks the user first, and may be declined.',
    // A plain JSON Schema object, cast because Pi types `parameters` as TypeBox
    // and this repo does not depend on TypeBox directly. Mirrors the built-in
    // bash schema so the inherited renderer sees the arguments it expects.
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run.' },
        timeout: { type: 'number', description: 'Optional timeout in milliseconds.' },
      },
      required: ['command'],
    } as never,
    execute: (async (
      _id: string,
      params: { command: string, timeout?: number },
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext
    ): Promise<BashResult> => {
      const policy = resolvePolicy(ctx)
      const verdict = vetCommand(params.command, policy)

      if (verdict.action === 'deny') {
        return fail(`Denied: ${verdict.reason}`)
      }

      if (verdict.action === 'confirm') {
        const approved = await askUser(ctx, verdict, params.command)
        if (!approved.allowed) {
          return fail(`Denied: ${verdict.reason} — ${approved.why}`)
        }
      }

      try {
        const output = await runProgram(
          verdict.program,
          verdict.args,
          policy.cwd,
          params.timeout ?? COMMAND_TIMEOUT_MS,
          signal
        )
        return ok(output)
      } catch (err) {
        return fail(`Command failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }) as never,
  })
}

/** Whether the operator approved, and if not, why the command was refused. */
interface Approval { allowed: boolean, why: string }

/**
 * Ask the operator to approve a command. Any outcome that is not an explicit
 * approval — including no interactive UI at all — denies.
 *
 * The title leads with the sensitive file when there is one. That is the fact
 * most likely to change the answer, and it can arrive on a command that looks
 * entirely routine otherwise (`cat` is allowlisted; the path is the problem).
 */
async function askUser (
  ctx: ExtensionContext,
  verdict: { program: string, sensitive?: string },
  command: string
): Promise<Approval> {
  if (!ctx.hasUI) {
    return { allowed: false, why: 'no interactive UI to confirm (default deny)' }
  }
  const title = verdict.sensitive !== undefined
    ? `Allow \`${verdict.program}\`? (touches sensitive file: ${basename(verdict.sensitive)})`
    : `Allow \`${verdict.program}\`? (not on the command allowlist)`
  try {
    const approved = await ctx.ui.confirm(
      title,
      `The agent wants to run:\n\n${describeForPrompt(command)}\n\nApprove this command?`,
      { timeout: CONFIRM_TIMEOUT_MS }
    )
    return approved
      ? { allowed: true, why: 'approved' }
      : { allowed: false, why: 'user rejected' }
  } catch {
    // Dialog dismissed/aborted/timed out without an explicit answer.
    return { allowed: false, why: 'confirmation timed out (default deny)' }
  }
}

/**
 * Spawn a vetted program with `execFile` — NOT a shell — so the already-checked
 * argument vector cannot be reinterpreted. Runs in `cwd`, with a timeout and a
 * bounded output buffer. Resolves to combined stdout+stderr.
 */
function runProgram (
  program: string,
  args: string[],
  cwd: string,
  timeout: number,
  signal: AbortSignal | undefined
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      { cwd, timeout, maxBuffer: MAX_BUFFER, shell: false, signal },
      (err, stdout, stderr) => {
        const combined = `${stdout ?? ''}${stderr ?? ''}`
        if (err) {
          // Surface the program's own output alongside the failure: a non-zero
          // exit usually explains itself better than the Error does.
          reject(new Error(combined.trim() === '' ? err.message : combined))
          return
        }
        resolve(combined)
      }
    )
  })
}
