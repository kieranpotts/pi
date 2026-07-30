/**
 * Applying a role's declared settings to the running harness.
 *
 * `before_agent_start` can only replace the system prompt — its result type
 * carries `message` and `systemPrompt` and nothing else — so model, thinking
 * level, and tools have to be pushed imperatively through `pi.setModel`,
 * `pi.setThinkingLevel`, and `pi.setActiveTools`.
 *
 * WHICH IS WHY THIS RUNS AT SELECTION TIME, NOT PER TURN. Two reasons, both in
 * `dist/core/agent-session.js`:
 *
 *   1. The turn's model auth pre-check runs BEFORE `before_agent_start` is
 *      emitted (`if (!this.model) …` and the `checkAuth` above it, against the
 *      `emitBeforeAgentStart` call further down). Switching models from inside
 *      that handler would slip past the check that exists to fail cleanly.
 *   2. `setActiveToolsByName` REBUILDS the base system prompt. Called from
 *      inside `before_agent_start`, the `systemPromptOptions` the handler was
 *      handed is already stale, so the prompt we compose would advertise the
 *      tool list the role just replaced.
 *
 * Applying on selection sidesteps both: the command handler runs outside any
 * turn (`_tryExecuteExtensionCommand` is reached before the agent loop), so the
 * next turn sees a settled harness and correct options.
 *
 * THE SETTINGS ARE NOT RESTORED WHEN A ROLE IS CLEARED, deliberately. Pi's
 * `setModel` and `setThinkingLevel` both write through to `settings.json`
 * (`setDefaultModelAndProvider`, `setDefaultThinkingLevel`), so a role's model
 * becomes the default model exactly as if it had been chosen with `/model`.
 * That is the intended behavior here: picking a role is picking a setup, and
 * `/role none` drops the persona without undoing the setup. Nothing re-asserts
 * these values either — change the model by hand mid-session and the change
 * stands, because this code only ever runs when a role is explicitly selected.
 *
 * NOTHING HERE THROWS. Every failure is a reported problem, because a role
 * whose model is unavailable should still install its persona rather than
 * refusing to be selected at all.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { RoleSettings } from './frontmatter.ts'

/**
 * The slice of `ExtensionAPI` this module drives.
 *
 * Narrowed with `Pick` rather than restated as a hand-written interface: the
 * signatures stay Pi's, so a change upstream is a type error here instead of a
 * runtime surprise, while the seam remains small enough to stub in a test.
 */
export type SettingsHost = Pick<ExtensionAPI, 'getAllTools' | 'setActiveTools' | 'setModel' | 'setThinkingLevel'>

/** The slice of the context this module reads. */
export type SettingsLookup = Pick<ExtensionContext, 'modelRegistry'>

/**
 * Apply `settings`, returning a human-readable problem for anything that could
 * not be applied. An empty array means everything the role asked for happened.
 */
export async function applyRoleSettings (
  settings: RoleSettings,
  pi: SettingsHost,
  ctx: SettingsLookup
): Promise<string[]> {
  const problems: string[] = []

  /* MODEL BEFORE THINKING, and the order is load-bearing: Pi's `setModel`
     re-applies the current thinking level clamped to the new model's
     capabilities, so setting thinking first would let the model switch
     overwrite it. Applying thinking afterwards means the role's value wins. */
  if (settings.provider !== undefined && settings.model !== undefined) {
    problems.push(...await applyModel(settings.provider, settings.model, pi, ctx))
  }

  if (settings.thinking !== undefined) {
    try {
      /* Silently clamped when the model cannot reach the requested level;
         there is no return value to inspect, so this cannot be reported. */
      pi.setThinkingLevel(settings.thinking)
    } catch (error) {
      problems.push(`could not set thinking level: ${message(error)}`)
    }
  }

  if (settings.tools !== undefined) {
    problems.push(...applyTools(settings.tools, pi))
  }

  return problems
}

/** Resolve and switch the model, reporting why if it cannot be done. */
async function applyModel (
  provider: string,
  modelId: string,
  pi: SettingsHost,
  ctx: SettingsLookup
): Promise<string[]> {
  let model
  try {
    model = ctx.modelRegistry.find(provider, modelId)
  } catch (error) {
    return [`could not look up model ${provider}/${modelId}: ${message(error)}`]
  }

  if (model === undefined) {
    return [`model ${provider}/${modelId} is not in the registry, so the model is unchanged`]
  }

  try {
    /* `false` rather than a throw is how Pi reports a provider with no
       configured credentials. */
    const applied = await pi.setModel(model)
    return applied ? [] : [`no API key for ${provider}, so the model is unchanged`]
  } catch (error) {
    return [`could not switch to ${provider}/${modelId}: ${message(error)}`]
  }
}

/**
 * Replace the active tool set.
 *
 * `pi.setActiveTools` DISCARDS names it does not recognize without a word, so
 * the list is checked against the registered tools first and unknown names are
 * named in the result.
 */
function applyTools (requested: string[], pi: SettingsHost): string[] {
  /* An explicitly empty list means "no tools", which is a real configuration:
     a role that only discusses requirements has no business editing files.
     Distinct from an absent key, which never reaches here. */
  if (requested.length === 0) {
    try {
      pi.setActiveTools([])
      return []
    } catch (error) {
      return [`could not disable tools: ${message(error)}`]
    }
  }

  let known: string[]
  try {
    known = pi.getAllTools().map((tool) => tool.name)
  } catch (error) {
    return [`could not read the tool registry: ${message(error)}`]
  }

  const valid = requested.filter((name) => known.includes(name))
  const unknown = requested.filter((name) => !known.includes(name))

  /*
   * NOT ONE OF THEM RESOLVED, so leave the tool set alone.
   *
   * This is the guard that matters most in this file. A role written for one
   * setup — Pi's built-ins — selected in another, where the tools are named
   * `mcp_read_file` and friends, would otherwise resolve to an empty valid set
   * and DISABLE EVERY TOOL, turning a naming mismatch into an agent that
   * cannot read a file. A warning is the right outcome; silence would be
   * indistinguishable from the deliberate empty list above.
   */
  if (valid.length === 0) {
    return [`none of these tools exist here (${unknown.join(', ')}), so the tool set is unchanged`]
  }

  const problems = unknown.length > 0
    ? [`unknown tools ignored: ${unknown.join(', ')}`]
    : []

  try {
    pi.setActiveTools(valid)
  } catch (error) {
    problems.push(`could not set tools: ${message(error)}`)
  }
  return problems
}

/** An error's message, for reporting. */
function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
