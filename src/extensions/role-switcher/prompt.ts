/**
 * Composition of a role's system prompt.
 *
 * `before_agent_start` lets an extension replace the system prompt for a turn,
 * and Pi applies what it returns VERBATIM (`dist/core/agent-session.js`:
 * `this.agent.state.systemPrompt = result.systemPrompt`). Returning a role
 * file's raw contents would therefore be a quiet act of sabotage: everything
 * Pi assembles around its own identity text — the project's `AGENTS.md`, the
 * discovered skills, the working directory — vanishes for as long as a role is
 * active, and nothing reports that it has gone.
 *
 * So this module rebuilds those sections around the role text. It is a
 * deliberate re-implementation of the `customPrompt` branch of Pi's own
 * `buildSystemPrompt` (`dist/core/system-prompt.js`), which is NOT exported
 * from the package — only its options type, `BuildSystemPromptOptions`, is. The
 * event hands us the very options object Pi used, so the inputs are exact even
 * though the builder cannot be called.
 *
 * WHAT THIS ADDS BEYOND PI'S `customPrompt` BRANCH: the tools list and the
 * guidelines. Pi drops both when a custom prompt is supplied, on the assumption
 * that whoever replaced the identity text also described the tools. A role file
 * here is a persona — "you are a meticulous code reviewer" — and is not the
 * place to restate the tool surface, so those two sections are reproduced from
 * the same options Pi would have built them from.
 *
 * WHAT IT DELIBERATELY OMITS: Pi's "Pi documentation" block, the pointer to the
 * harness's own README, docs, and examples. It is guidance for working on Pi
 * itself, and it is a large block of it; a `product-manager` or
 * `technical-writer` role has no use for it. A role that DOES need it can say
 * so in its own text.
 *
 * BEING A FAITHFUL COPY IS THE POINT. Section order, wording, and the
 * guideline de-duplication all mirror upstream so this can be diffed against
 * `dist/core/system-prompt.js` when Pi is upgraded. Keep it that way.
 */

/*
 * NOTE: this is the only RUNTIME import of the pi package in this repository —
 * every other extension imports nothing but types from it, which type stripping
 * erases. It is safe, and checked: Pi loads extensions through jiti with an
 * alias map that points this exact specifier at the package index
 * (`dist/core/extensions/loader.js`, `getAliases()`), with the equivalent entry
 * in `VIRTUAL_MODULES` for the Bun binary. So an installed extension sitting in
 * `~/.pi/agent/extensions/` — nowhere near a `node_modules` tree — resolves it
 * fine, even though a plain `node` import of the same file would not. Do not
 * "fix" this by inlining `formatSkillsForPrompt`; verify with Pi's loader.
 */
import { formatSkillsForPrompt, type BuildSystemPromptOptions } from '@earendil-works/pi-coding-agent'

/** Pi's own fallback when `selectedTools` is absent (`system-prompt.js`). */
const DEFAULT_TOOLS = ['read', 'bash', 'edit', 'write']

/**
 * Compose the system prompt for an active role.
 *
 * `roleText` is the role file's contents; `options` is the
 * `systemPromptOptions` from the `before_agent_start` event, ie. exactly what
 * Pi used to build the prompt this one replaces. Pure: no filesystem, no clock.
 */
export function composeRolePrompt (roleText: string, options: BuildSystemPromptOptions): string {
  const { selectedTools, toolSnippets, promptGuidelines, appendSystemPrompt, cwd, contextFiles, skills } = options

  const tools = selectedTools ?? DEFAULT_TOOLS

  let prompt = roleText.trim()

  /* A tool appears in the list only when the caller supplied a one-line
     snippet for it — same rule as upstream, so the two lists never disagree. */
  const visibleTools = tools.filter((name) => Boolean(toolSnippets?.[name]))
  const toolsList = visibleTools.length > 0
    ? visibleTools.map((name) => `- ${name}: ${toolSnippets?.[name]}`).join('\n')
    : '(none)'

  prompt += `

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${buildGuidelines(tools, promptGuidelines)}`

  if (appendSystemPrompt) {
    prompt += `\n\n${appendSystemPrompt}`
  }

  /* Project context — `AGENTS.md` and friends. Pi has already read these; the
     options carry the contents, so nothing is re-read here. */
  if (contextFiles !== undefined && contextFiles.length > 0) {
    prompt += '\n\n<project_context>\n\n'
    prompt += 'Project-specific instructions and guidelines:\n\n'
    for (const { path: filePath, content } of contextFiles) {
      prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`
    }
    prompt += '</project_context>\n'
  }

  /* Skills are only reachable through the `read` tool, so Pi omits the section
     when `read` is not on offer. `formatSkillsForPrompt` is the one piece of
     upstream's builder that IS exported, so the rendering is Pi's own. */
  const hasRead = selectedTools === undefined || selectedTools.includes('read')
  if (hasRead && skills !== undefined && skills.length > 0) {
    prompt += formatSkillsForPrompt(skills)
  }

  /* Pi normalizes Windows separators before printing the cwd. Guarded despite
     `cwd` being non-optional in `BuildSystemPromptOptions`: this runs on every
     turn, and a throw here would take down the agent rather than degrade one
     prompt. An absent cwd is omitted rather than printed empty, which would
     assert a working directory of "" instead of admitting to none. */
  if (typeof cwd === 'string' && cwd.length > 0) {
    prompt += `\nCurrent working directory: ${cwd.replace(/\\/g, '/')}`
  }

  return prompt
}

/**
 * Render the guidelines list, mirroring upstream's assembly order and its
 * de-duplication (first occurrence wins, order preserved).
 */
function buildGuidelines (tools: string[], promptGuidelines: string[] | undefined): string {
  const seen = new Set<string>()
  const guidelines: string[] = []
  const add = (guideline: string): void => {
    if (seen.has(guideline)) return
    seen.add(guideline)
    guidelines.push(guideline)
  }

  /* Upstream's one conditional guideline: bash is the only way to explore the
     filesystem when the dedicated search tools are absent. */
  const hasBash = tools.includes('bash')
  if (hasBash && !tools.includes('grep') && !tools.includes('find') && !tools.includes('ls')) {
    add('Use bash for file operations like ls, rg, find')
  }

  for (const guideline of promptGuidelines ?? []) {
    const normalized = guideline.trim()
    if (normalized.length > 0) {
      add(normalized)
    }
  }

  /* Always last, and always present. */
  add('Be concise in your responses')
  add('Show file paths clearly when working with files')

  return guidelines.map((g) => `- ${g}`).join('\n')
}
