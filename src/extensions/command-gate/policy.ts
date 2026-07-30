/**
 * Command vetting for the gated `bash` replacement.
 *
 * The threat is command injection: a single string the agent supplies could
 * smuggle extra commands via shell *control* operators (`;`, `&&`, `|`,
 * redirection, command substitution). The defence is to never invoke a shell
 * and to reject any command containing a control operator, then run a single
 * vetted program with the remaining tokens as literal arguments.
 *
 * Vetting is THREE-WAY, not two-way. That is the substantive difference from
 * the `audited-tools` extension this replaces, which had only allow and deny:
 *
 *   - **allow** — the program is on the effective allowlist and the command
 *     names no sensitive file. Runs unprompted.
 *   - **confirm** — the program is unrecognised, or the command names a
 *     sensitive file, but it is otherwise clean. The operator is asked. Neither
 *     is evidence of an attack, and a hard denial just teaches the model to
 *     work around the gate; asking keeps the operator in the loop without
 *     making the allowlist a maintenance burden.
 *   - **deny** — the command is malformed or carries a control operator, or
 *     reaches into a fenced root. Not confirmable, deliberately: see below.
 *
 * Why denial is not confirmable. A control operator has meaning only to a
 * shell, and no shell ever runs here. Approving a `|` could not produce the
 * behaviour the caller wants — it would become a literal argument, not a pipe.
 * A prompt offering to approve something that cannot work is worse than no
 * prompt: it trains the operator to click through. So these stay absolute.
 *
 * Two classes of "special" character, treated differently:
 *
 *   - **Control operators** (`| & ; < > ` newline`) — rejected, always.
 *
 *   - **Argument-content characters** (`$ * ? ( ) { } \`) — these routinely
 *     appear *inside* a single argument that the program itself interprets:
 *     `grep 'a.*b'`, `find -name '*.ts'`, `find … -exec cat {} \;`, regexes,
 *     literal `$` in text. Because no shell runs, they are passed through
 *     verbatim and cannot expand, glob, or substitute. They are allowed; no
 *     configuration is needed or offered.
 *
 * The upshot: there is no metacharacter whose "allow" toggle would do something
 * useful that is not already covered, so there is no metacharacter config at
 * all. The operator-tunable knobs are the extra allowlist and the fence.
 *
 * All logic here is pure (no process spawning, no I/O). `register-bash.ts`
 * spawns only when this approves, and prompts when this says to ask.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'
import { sensitiveToken } from './sensitive-files.ts'

/**
 * Shell CONTROL operators — always rejected. Meaningful only to a shell, which
 * we never invoke, so they can only ever be an injection attempt.
 */
const CONTROL_OPERATORS = ['|', '&', ';', '<', '>', '`', '\n']

/**
 * Programs that always run unprompted, and that an operator CANNOT remove.
 *
 * Read-only inspection only: nothing here writes, deletes, or executes
 * arbitrary code. Hardwired rather than configurable because this set is the
 * floor the gate is built on — the tool would be useless below it, and a
 * misconfigured allowlist that accidentally emptied it would produce a
 * confirmation prompt for every `ls`, which is how operators learn to approve
 * without reading.
 *
 * Note what is NOT here: `git` and `make` are useful but not read-only, so they
 * live in the configurable layer below, where an operator can drop them.
 */
export const ALWAYS_ALLOWED: readonly string[] = [
  'ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc', 'file', 'pwd', 'echo',
  'which', 'stat', 'diff', 'tree', 'sort', 'uniq', 'cut', 'basename', 'dirname',
]

/**
 * Programs allowed on top of `ALWAYS_ALLOWED` by default, and replaceable via
 * `COMMAND_GATE_ALLOWLIST`.
 *
 * Deliberately short. `git` and `make` are near-universal in a dev loop and
 * would otherwise prompt constantly, which is the failure mode described above.
 * Both do carry surface — `git` can write the working tree and reach the
 * network, and `make` runs whatever a Makefile says, which is arbitrary code —
 * so an operator who wants the gate to hold on its own should set
 * `COMMAND_GATE_ALLOWLIST=` to an empty-but-present value and confirm both.
 *
 * The language runtimes are pointedly absent. `node`, `python`, `npm`, `pip`,
 * `go`, and `cargo` are general-purpose interpreters: `node -e "…"` reads
 * anything the uid can, and the fence below sees only an inert script string.
 * With them allowlisted the allowlist stops being a control and becomes a
 * formality. They now route to `confirm` instead, which is the honest place for
 * them — the operator sees the script and decides.
 */
export const DEFAULT_EXTRA_ALLOWED: readonly string[] = ['git', 'make']

/**
 * Directories no command may reach. Empty by default: unlike the containerised
 * ancestor of this extension, there is no read-only project mount here whose
 * unmediated access needs closing off. The mechanism is kept because it is the
 * natural place to fence `~/.ssh`, `~/.aws`, or a sibling checkout, and it
 * costs nothing when unset.
 */
export const DEFAULT_FENCED_ROOTS: readonly string[] = []

/**
 * The policy. Control operators are always rejected and `ALWAYS_ALLOWED` is
 * always allowed (see module doc); the extra allowlist, the fence, and the
 * working directory are the tunables.
 */
export interface CommandPolicy {
  /** Programs permitted beyond `ALWAYS_ALLOWED`. Everything else prompts. */
  allowlist: readonly string[]
  /** Absolute directories no command argument may resolve into. */
  fencedRoots: readonly string[]
  /**
   * Directory commands run in, and the base relative arguments are resolved
   * against when fencing. Deliberately ONE value serving both purposes: if
   * vetting resolved against a different directory than execution used, a
   * relative path could be fenced as innocuous and then executed as a fenced
   * one.
   */
  cwd: string
}

/** The default policy for a given working directory. */
export function defaultPolicy (cwd: string): CommandPolicy {
  return { allowlist: DEFAULT_EXTRA_ALLOWED, fencedRoots: DEFAULT_FENCED_ROOTS, cwd }
}

/** Outcome of vetting a command. */
export type CommandVerdict =
  | { action: 'allow', program: string, args: string[] }
  | {
    action: 'confirm'
    program: string
    args: string[]
    reason: string
    /** The offending token, when a sensitive filename is why we are asking. */
    sensitive?: string
  }
  | { action: 'deny', reason: string }

/**
 * Split a command string into whitespace-separated tokens, honouring single and
 * double quotes so quoted arguments stay intact. Does NOT interpret any shell
 * feature — quotes only group, they do not enable substitution. Pure.
 *
 * Returns null if quoting is unbalanced (which we treat as unsafe).
 */
export function tokenize (command: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false

  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue }
    if (/\s/.test(ch)) {
      if (started) { tokens.push(current); current = ''; started = false }
      continue
    }
    current += ch
    started = true
  }
  if (quote) return null // unbalanced quote
  if (started) tokens.push(current)
  return tokens
}

/**
 * Which shell control operators appear in the command. Checks the RAW string
 * (before tokenising), because a control operator is an injection risk wherever
 * it sits — including inside quotes, since a quoted `;` that we passed through
 * would still be a live operator to anything downstream that did invoke a
 * shell. Pure. Argument-content characters (`$ * ? ( ) { } \`) are NOT checked
 * here — they pass through as inert literals (no shell runs to interpret them).
 */
export function offendingOperators (command: string): string[] {
  return CONTROL_OPERATORS.filter((op) => command.includes(op))
}

/**
 * Whether `target` — already resolved to an absolute path — lies within `root`.
 *
 * Compares via `relative()` and rejects a result that escapes (`..`) or is
 * absolute (which `relative` returns when the paths share no base). An empty
 * result means target IS root, which counts as within. This is what defeats the
 * prefix-collision case: `/home/pi/work-evil` shares `/home/pi/work` as a
 * string prefix but is not inside it. Pure.
 */
export function isWithin (root: string, target: string): boolean {
  const rel = relative(resolve(root), target)
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * The first token that resolves inside a fenced root, or undefined if none.
 *
 * EVERY token is checked, the program included, and each is resolved against
 * `policy.cwd` when relative — so `../../secrets/.env` is caught as surely as
 * the absolute form. Tokens that are not paths at all (flags, regexes,
 * `-name`) resolve to harmless paths under the cwd and never match, which is
 * why this can check indiscriminately without false positives. Pure.
 */
export function fencedToken (tokens: readonly string[], policy: CommandPolicy): string | undefined {
  for (const token of tokens) {
    const target = isAbsolute(token) ? resolve(token) : resolve(policy.cwd, token)
    if (policy.fencedRoots.some((root) => isWithin(root, target))) return token
  }
  return undefined
}

/** Whether a program runs without prompting under this policy. Pure. */
export function isAllowedProgram (program: string, policy: CommandPolicy): boolean {
  return ALWAYS_ALLOWED.includes(program) || policy.allowlist.includes(program)
}

/**
 * Vet a command against a policy. Pure.
 *
 * Order matters: the malformed and injection cases are checked first, so a
 * command that could never run safely is denied outright rather than being put
 * to the operator. Only a well-formed, shell-free, unfenced command whose
 * program is merely unrecognised reaches `confirm`.
 */
export function vetCommand (command: string, policy: CommandPolicy): CommandVerdict {
  const trimmed = command.trim()
  if (trimmed === '') return { action: 'deny', reason: 'empty command' }

  const offenders = offendingOperators(trimmed)
  if (offenders.length > 0) {
    const shown = offenders.map((o) => (o === '\n' ? '\\n' : o)).join(' ')
    return { action: 'deny', reason: `command contains disallowed shell operators: ${shown}` }
  }

  const tokens = tokenize(trimmed)
  if (tokens === null) return { action: 'deny', reason: 'unbalanced quotes in command' }

  const program = tokens[0]
  if (program === undefined) return { action: 'deny', reason: 'no program in command' }

  const fenced = fencedToken(tokens, policy)
  if (fenced !== undefined) {
    return { action: 'deny', reason: `command reaches into a fenced path: ${fenced}` }
  }

  const args = tokens.slice(1)

  /* Two independent reasons to ask, either sufficient. A sensitive filename is
     checked even for an allowlisted program: `cat` is hardwired and always will
     be, but `cat ~/.ssh/id_rsa` is still worth surfacing. */
  const sensitive = sensitiveToken(tokens)
  const unknownProgram = !isAllowedProgram(program, policy)

  if (sensitive === undefined && !unknownProgram) return { action: 'allow', program, args }

  const reasons: string[] = []
  if (unknownProgram) reasons.push(`program not on allowlist: ${program}`)
  if (sensitive !== undefined) reasons.push(`touches sensitive file: ${sensitive}`)

  return {
    action: 'confirm',
    program,
    args,
    reason: reasons.join('; '),
    ...(sensitive !== undefined ? { sensitive } : {}),
  }
}

/**
 * How much of a command a confirmation dialog will show.
 *
 * Generous on purpose. The prompt is a control, not a label: an operator
 * approving a command they can only half see is not approving anything. The
 * commands most likely to reach a prompt are exactly the ones that need reading
 * in full — `python -c "…"` and friends — so the cap has to sit well above a
 * realistic script, not at a comfortable terminal width.
 */
const PROMPT_DETAIL_MAX = 2000

/**
 * A command, capped for display in a confirmation dialog. Pure.
 *
 * When it does cut, it says SO and says how much, rather than trailing an
 * ellipsis into silence. The operator needs to know they are being shown a
 * summary — a prompt that hides half of what it is confirming without admitting
 * it is worse than one that shows less honestly.
 */
export function describeForPrompt (command: string): string {
  if (command.length <= PROMPT_DETAIL_MAX) return command
  const hidden = command.length - PROMPT_DETAIL_MAX
  return `${command.slice(0, PROMPT_DETAIL_MAX)}\n\n[${hidden} more characters not shown]`
}

/**
 * Build the effective policy from the environment. A non-empty value FULLY
 * REPLACES its built-in default rather than extending it, so an operator can
 * always see the whole effective policy in one place. Pure.
 *
 * Note the asymmetry between the two lists, which is why they read the blank
 * case differently:
 *
 *   - Emptying the ALLOWLIST is a tightening (fewer programs run unprompted),
 *     so a value that is present but blank clears it. `COMMAND_GATE_ALLOWLIST=`
 *     drops `git` and `make` down to confirm-on-use, which is a thing an
 *     operator may genuinely want. An UNSET variable keeps the default.
 *
 *   - Emptying the FENCE is a loosening (no path is off limits), so a blank
 *     value keeps the default instead of clearing it. Pass
 *     `COMMAND_GATE_FENCE=none` to genuinely disable fencing — explicit,
 *     greppable, and impossible to do by accident with an empty string. (With
 *     the default fence already empty this is currently a distinction without a
 *     difference, but it stops a future non-empty default from being silently
 *     erased by a stray `COMMAND_GATE_FENCE=` in a shell profile.)
 */
export function buildPolicy (envAllowlist: string | undefined, envFence: string | undefined, cwd: string): CommandPolicy {
  const allowlist: readonly string[] = envAllowlist === undefined
    ? DEFAULT_EXTRA_ALLOWED
    : envAllowlist.split(',').map((s) => s.trim()).filter(Boolean)

  let fencedRoots: readonly string[] = DEFAULT_FENCED_ROOTS
  if (envFence && envFence.trim() !== '') {
    fencedRoots = envFence.trim() === 'none'
      ? []
      : envFence.split(',').map((s) => s.trim()).filter(Boolean)
  }

  return { allowlist, fencedRoots, cwd }
}
