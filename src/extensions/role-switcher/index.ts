/**
 * Swap Pi's system prompt for a named role, from a menu, mid-session.
 *
 * Pi ships one identity — "an expert coding assistant" — and it is the wrong
 * one for most of the work around the code. Asking that assistant to specify
 * requirements gets you an implementation plan; asking it to review a change
 * gets you a rewrite of the change. This extension makes the identity a file
 * you pick from a list: `product-manager`, `software-architect`,
 * `code-reviewer`, and so on, each one a Markdown file in a roles directory.
 *
 * WHY AN EXTENSION AND NOT AN OLLAMA MODELFILE. A Modelfile `SYSTEM` block is
 * the obvious place to put a persona, and it does not work: Pi sends its own
 * system prompt with every request, which overrides whatever the Modelfile
 * declared. The persona has to be installed from inside Pi or not at all.
 * Modelfiles are left holding what they are actually good for — `FROM` and
 * `PARAMETER`, ie. tuning.
 *
 * HOW A ROLE IS APPLIED. `/role` records a name; `before_agent_start` reads
 * that role's file FRESH each turn and returns its body as `systemPrompt`,
 * which Pi applies verbatim. Reading fresh is what makes editing a role file
 * take effect on the next message with no re-selection and no restart — the
 * shortest possible loop for iterating on a persona.
 *
 * A ROLE MAY ALSO DECLARE HARNESS SETTINGS in a YAML frontmatter block — the
 * model, the thinking level, the active tools — which are applied ONCE, when
 * the role is selected, and never re-asserted. That asymmetry with the prompt
 * text is not an oversight: `before_agent_start` cannot carry these settings,
 * and pushing them imperatively from inside it breaks in two specific ways.
 * `settings.ts` documents both, along with the consequences the user chose:
 * settings are NOT restored when a role is cleared, and a manual `/model` after
 * selecting a role wins. Frontmatter therefore does not live-reload the way the
 * body does — edit it and re-select.
 *
 * AND WHAT "VERBATIM" COSTS. Pi assembles far more than an identity: the
 * project's `AGENTS.md`, the discovered skills, the tool list, the working
 * directory. All of it is part of the string this extension replaces, so all of
 * it would silently disappear for as long as a role were active. `prompt.ts`
 * rebuilds those sections around the role text, from the very options Pi used;
 * read its header before changing what a role prompt contains.
 *
 * STATE IS PER-SESSION AND SURVIVES A RESUME. The selection lives in this
 * closure and is also written to the session as a `role-selection` entry, so
 * resuming a session picks the role back up (`session_start`) instead of
 * silently reverting to Pi's default. Switching sessions clears it first, so a
 * role never leaks from one conversation into another.
 *
 * Discovery and prompt composition live in `roles.ts` and `prompt.ts`; this
 * entry point is the thin glue to the `ExtensionAPI`.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { homedir } from 'node:os'
import { discoverRoles, NO_ROLE, readRole, roleDirs } from './roles.ts'
import { composeRolePrompt } from './prompt.ts'
import { parseRole, type RoleSettings } from './frontmatter.ts'
import { applyRoleSettings } from './settings.ts'

/** Session entry type recording a selection, so a resume can restore it. */
const SELECTION_ENTRY = 'role-selection'

/** The menu's first entry, which clears the selection. Not a role name — the
 * dashes keep it from colliding with a file called `none.md`. */
const NO_ROLE_LABEL = '— none — (Pi\'s default prompt)'

/** What a `role-selection` entry carries. `null` is an explicit clear, which is
 * distinct from no entry at all (never chose a role this session). */
interface SelectionData {
  role: string | null
}

export default function (pi: ExtensionAPI): void {
  /** The active role, or `undefined` for Pi's own prompt. */
  let selected: string | undefined

  /** Whether the active role's file has already been reported missing. Stops
   * one deleted file from warning on every turn, and re-arms if it returns. */
  let missingWarned = false

  /** Record a selection, in memory and in the session. */
  const select = (role: string | undefined): void => {
    selected = role
    missingWarned = false
    pi.appendEntry<SelectionData>(SELECTION_ENTRY, { role: role ?? null })
  }

  /**
   * Select a role and apply the harness settings its frontmatter declares.
   *
   * Settings are applied HERE — once, on an explicit selection — and never
   * re-asserted per turn. See `settings.ts` for why that is the only workable
   * place, and for the consequence: they are not restored when the role is
   * cleared, and a later manual `/model` wins.
   */
  const activate = async (
    name: string,
    path: string,
    ctx: ExtensionCommandContext
  ): Promise<void> => {
    select(name)

    const text = await readRole(path)
    if (text === undefined) {
      ctx.ui.notify(`Role: ${name}, but its file could not be read.`, 'warning')
      return
    }

    const { settings, problems } = parseRole(text)
    const applied = await applyRoleSettings(settings, pi, ctx)

    const summary = describeSettings(settings)
    ctx.ui.notify(`Role: ${name}${summary === '' ? '' : ` (${summary})`}`, 'info')

    /* Reported after the confirmation, so the role is known to be active even
       when part of what it asked for could not be done. */
    for (const problem of [...problems, ...applied]) {
      ctx.ui.notify(`Role "${name}": ${problem}`, 'warning')
    }
  }

  /*
   * `/role` — pick a role, by name or from a menu.
   *
   *   /role           discover and show the selector
   *   /role <name>    select directly, skipping the menu
   *   /role none      clear, reverting to Pi's default prompt
   */
  pi.registerCommand('role', {
    description: 'Switch the system prompt to a named role',
    /* Completions get no context, so the project directory has to come from
       `process.cwd()` rather than `ctx.cwd`. The two agree for a normal launch;
       if they ever diverged, the worst case is a missing suggestion for a name
       the handler below would still accept. */
    getArgumentCompletions: async (prefix) => {
      const roles = await discoverRoles(roleDirs(process.cwd(), homedir()))
      return [...roles.keys(), NO_ROLE]
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ value: name, label: name }))
    },
    handler: async (args, ctx) => {
      const requested = args.trim()

      /* Clearing needs no discovery, and must work even when every role file
         has since been deleted — otherwise a stale selection is unclearable. */
      if (requested === NO_ROLE) {
        select(undefined)
        ctx.ui.notify('Role cleared. Using Pi\'s default prompt.', 'info')
        return
      }

      const dirs = roleDirs(ctx.cwd, homedir())
      const roles = await discoverRoles(dirs)

      if (roles.size === 0) {
        ctx.ui.notify(`No roles found. Searched:\n${dirs.map((d) => `  ${d}`).join('\n')}`, 'warning')
        return
      }

      if (requested.length > 0) {
        const path = roles.get(requested)
        if (path === undefined) {
          ctx.ui.notify(`Unknown role: ${requested}. Available: ${[...roles.keys()].join(', ')}`, 'error')
          return
        }
        await activate(requested, path, ctx)
        return
      }

      if (!ctx.hasUI) {
        ctx.ui.notify('No interactive UI for the role menu. Use /role <name>.', 'error')
        return
      }

      const chosen = await ctx.ui.select('Pick a role:', [NO_ROLE_LABEL, ...roles.keys()])

      /* Dismissed without choosing: leave the current role alone. */
      if (chosen === undefined) return

      if (chosen === NO_ROLE_LABEL) {
        select(undefined)
        ctx.ui.notify('Role cleared. Using Pi\'s default prompt.', 'info')
        return
      }

      const path = roles.get(chosen)
      if (path === undefined) return
      await activate(chosen, path, ctx)
    },
  })

  /* Re-establish state for the session now in play. Reset first: without that,
     a role chosen in the session being switched away from would silently
     remain active in the one being switched to. */
  pi.on('session_start', async (_event, ctx) => {
    selected = lastSelection(ctx) ?? undefined
    missingWarned = false
  })

  /* Drop in-memory state at shutdown. The session entry is the durable record;
     this closure is not, and must not outlive the session it described. */
  pi.on('session_shutdown', async () => {
    selected = undefined
    missingWarned = false
  })

  /*
   * Apply the active role to this turn.
   *
   * Read fresh every time, so editing the file is enough to change behavior.
   * Returning `undefined` is meaningful rather than inert: Pi resets to its
   * base prompt whenever this handler declines to supply one, so "no role" and
   * "role file vanished" both land the agent back on its own default.
   */
  pi.on('before_agent_start', async (event, ctx) => {
    if (selected === undefined) return undefined

    const roles = await discoverRoles(roleDirs(ctx.cwd, homedir()))
    const path = roles.get(selected)
    const text = path !== undefined ? await readRole(path) : undefined

    /* Only the BODY is the prompt: a frontmatter block must never reach the
       model as instructions. Its settings were applied when the role was
       selected and are not re-read here — see `settings.ts`. Any problems with
       it were reported then, so this stays silent about them rather than
       repeating itself on every turn. */
    const body = text === undefined ? undefined : parseRole(text).body

    /* Gone, or emptied. Keep the selection rather than clearing it: the file
       may be mid-edit or briefly moved, and silently forgetting the user's
       choice is worse than one warning and a default prompt for a turn. */
    if (body === undefined || body.trim().length === 0) {
      if (!missingWarned) {
        missingWarned = true
        ctx.ui.notify(`Role "${selected}" is unavailable. Using Pi's default prompt.`, 'warning')
      }
      return undefined
    }

    missingWarned = false
    return { systemPrompt: composeRolePrompt(body, event.systemPromptOptions) }
  })
}

/**
 * A short summary of what a role's frontmatter changes, for the confirmation
 * message. Empty when the role declares nothing.
 *
 * Worth showing rather than applying silently: two of these settings persist
 * into `settings.json`, so a role quietly repointing the default model would be
 * a surprise the next time Pi starts.
 */
function describeSettings (settings: RoleSettings): string {
  const parts: string[] = []
  if (settings.provider !== undefined && settings.model !== undefined) {
    parts.push(`${settings.provider}/${settings.model}`)
  }
  if (settings.thinking !== undefined) {
    parts.push(`thinking: ${settings.thinking}`)
  }
  if (settings.tools !== undefined) {
    parts.push(settings.tools.length === 0 ? 'no tools' : `tools: ${settings.tools.join(', ')}`)
  }
  return parts.join('; ')
}

/**
 * The most recent selection recorded in this session, `null` if the last thing
 * the user did was clear it, or `undefined` if they never chose one.
 *
 * Defensive throughout: a session written by an older version of this
 * extension, or hand-edited, must not stop the session from starting.
 */
function lastSelection (ctx: ExtensionContext): string | null | undefined {
  let entries
  try {
    entries = ctx.sessionManager.getEntries()
  } catch {
    return undefined
  }

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry?.type !== 'custom' || entry.customType !== SELECTION_ENTRY) continue

    const role = (entry.data as SelectionData | undefined)?.role
    if (typeof role === 'string' && role.length > 0) return role
    if (role === null) return null

    /* Malformed entry: ignore it and keep looking further back. */
  }

  return undefined
}
