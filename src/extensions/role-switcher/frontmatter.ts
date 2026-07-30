/**
 * Parsing a role file into its settings and its prompt text.
 *
 * A role file may open with a YAML frontmatter block declaring the harness
 * settings that role wants — which model, how hard to think, which tools:
 *
 *     ---
 *     provider: anthropic
 *     model: claude-sonnet-5
 *     thinking: high
 *     tools: [read, grep, find, ls]
 *     ---
 *     You are a meticulous code reviewer.
 *
 * Everything after the block is the prompt. A file with no frontmatter is all
 * prompt, which is what every role was before this existed.
 *
 * VALIDATION HAPPENS HERE, NOT AT THE CALL SITE. Each field is accepted only in
 * the shape Pi's setters require and otherwise reported as a problem: these
 * files are hand-written, `pi.setActiveTools` ignores names it does not know
 * without saying so, and `pi.setThinkingLevel` silently clamps a level the
 * model cannot do. A typo that quietly does nothing is the failure mode worth
 * engineering against, so `problems` carries a human-readable line for each one
 * and the caller shows them.
 *
 * NOTHING HERE THROWS, including on malformed YAML. A half-finished frontmatter
 * block must still leave a usable role: the settings are dropped, the block is
 * stripped so it cannot leak into the prompt, and the body is returned.
 */

import { parseFrontmatter } from '@earendil-works/pi-coding-agent'

/**
 * Thinking levels Pi accepts.
 *
 * Declared here rather than imported: `ThinkingLevel` lives in
 * `@earendil-works/pi-agent-core` and is NOT re-exported from
 * `pi-coding-agent`'s entry point, and the former is a nested dependency that
 * this repo's type-checker cannot resolve. The union is small and stable, and
 * deriving the type from the same array the validator uses keeps the two from
 * drifting apart — which an import could not have done anyway.
 */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** A thinking level, structurally identical to Pi's own `ThinkingLevel`. */
export type ThinkingLevel = typeof THINKING_LEVELS[number]

/**
 * The harness settings a role declares. Every field is optional; an absent one
 * means the role has no opinion and whatever is already set stays.
 */
export interface RoleSettings {
  /** Provider id, eg. `anthropic`. Required alongside `model`. */
  provider?: string
  /** Model id, eg. `claude-sonnet-5`. Required alongside `provider`. */
  model?: string
  /** Thinking level to switch to. */
  thinking?: ThinkingLevel
  /**
   * Tool names to make active, REPLACING the current set.
   *
   * An explicitly empty list means "no tools", which is a legitimate thing for
   * a role that only talks — a product manager has no business editing files.
   * It is distinguishable from an absent key, which means "leave tools alone".
   */
  tools?: string[]
}

/** A role file, split into what it configures and what it says. */
export interface ParsedRole {
  settings: RoleSettings
  /** The prompt text, with any frontmatter block removed. */
  body: string
  /** Human-readable problems found in the frontmatter, for showing the user. */
  problems: string[]
}

/**
 * Split a role file into settings and prompt. Total: never throws, whatever the
 * file contains.
 */
export function parseRole (text: string): ParsedRole {
  const problems: string[] = []

  let frontmatter: Record<string, unknown>
  let body: string
  try {
    const parsed = parseFrontmatter(text)
    frontmatter = parsed.frontmatter
    body = parsed.body
  } catch {
    /* Malformed YAML. Strip the block anyway — leaving it in would put `---`
       and half-written keys into the system prompt — and carry on with no
       settings rather than failing the role outright. */
    problems.push('the frontmatter block is not valid YAML, so no settings were applied')
    return { settings: {}, body: stripBlock(text), problems }
  }

  return { settings: readSettings(frontmatter, problems), body, problems }
}

/**
 * Pick the known keys out of parsed frontmatter, recording a problem for
 * anything present but unusable. Unknown keys are ignored in silence — they are
 * how a role file carries notes or forward-declares a key we do not support.
 */
function readSettings (frontmatter: Record<string, unknown>, problems: string[]): RoleSettings {
  const settings: RoleSettings = {}

  /* Model and provider are one setting in two keys, because the registry
     lookup (`modelRegistry.find`) needs both: a model id alone is ambiguous
     across providers. Half a pair is a mistake worth naming rather than
     guessing at. */
  const provider = readString(frontmatter.provider)
  const model = readString(frontmatter.model)
  if (provider !== undefined && model !== undefined) {
    settings.provider = provider
    settings.model = model
  } else if (model !== undefined) {
    problems.push('`model` needs a `provider` alongside it, so the model was not changed')
  } else if (provider !== undefined) {
    problems.push('`provider` needs a `model` alongside it, so the model was not changed')
  }

  if (frontmatter.thinking !== undefined) {
    const thinking = readString(frontmatter.thinking)
    if (thinking !== undefined && isThinkingLevel(thinking)) {
      settings.thinking = thinking
    } else {
      problems.push(`\`thinking\` must be one of ${THINKING_LEVELS.join(', ')}`)
    }
  }

  if (frontmatter.tools !== undefined) {
    const tools = readStringArray(frontmatter.tools)
    if (tools === undefined) {
      problems.push('`tools` must be a list of tool names')
    } else {
      settings.tools = tools
    }
  }

  return settings
}

/** Narrow a string to a thinking level Pi will accept. */
function isThinkingLevel (value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value)
}

/** A non-empty string, or `undefined` for anything else. */
function readString (value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * A list of non-empty strings, or `undefined` if the value is not a list of
 * strings at all. An empty list is valid and stays empty — see `tools`.
 */
function readStringArray (value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings: string[] = []
  for (const entry of value) {
    const name = readString(entry)
    if (name === undefined) return undefined
    strings.push(name)
  }
  return strings
}

/**
 * Remove a leading `---` delimited block without parsing it.
 *
 * Only used when the YAML failed to parse: the block's content is unusable but
 * it must still not reach the model. Mirrors the delimiters Pi's own
 * `parseFrontmatter` looks for, so the two agree on where a block ends.
 */
function stripBlock (text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!normalized.startsWith('---')) return normalized

  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return normalized

  return normalized.slice(end + 4).trim()
}
