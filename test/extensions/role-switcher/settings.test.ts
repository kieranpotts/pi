/**
 * Applying a role's declared settings.
 *
 * The `pi` surface is stubbed: the real `setModel` writes through to
 * `settings.json` and mutates a live agent, which is exactly the behavior these
 * tests must not invoke. What is asserted here is the calling discipline around
 * it — the order, the validation, and the refusal to disable every tool over a
 * naming mismatch.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyRoleSettings } from '../../../src/extensions/role-switcher/settings.ts'
import type { RoleSettings } from '../../../src/extensions/role-switcher/frontmatter.ts'

/** What a stub recorded, in the order it happened. */
interface Recorded {
  calls: string[]
  tools?: string[]
  thinking?: string
  model?: string
}

/** A `pi` stub over the four methods this module drives. */
function host (options: {
  knownTools?: string[]
  modelFound?: boolean
  modelApplied?: boolean
  throwOn?: string
} = {}): { pi: never, ctx: never, recorded: Recorded } {
  const recorded: Recorded = { calls: [] }

  const pi = {
    getAllTools: () => {
      if (options.throwOn === 'getAllTools') throw new Error('registry unavailable')
      return (options.knownTools ?? ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'])
        .map((name) => ({ name }))
    },
    setActiveTools: (names: string[]) => {
      if (options.throwOn === 'setActiveTools') throw new Error('tools rejected')
      recorded.calls.push('setActiveTools')
      recorded.tools = names
    },
    setModel: async (model: { id: string }) => {
      if (options.throwOn === 'setModel') throw new Error('model rejected')
      recorded.calls.push('setModel')
      recorded.model = model.id
      return options.modelApplied ?? true
    },
    setThinkingLevel: (level: string) => {
      if (options.throwOn === 'setThinkingLevel') throw new Error('thinking rejected')
      recorded.calls.push('setThinkingLevel')
      recorded.thinking = level
    },
  }

  const ctx = {
    modelRegistry: {
      find: (provider: string, id: string) => {
        if (options.throwOn === 'find') throw new Error('lookup failed')
        return (options.modelFound ?? true) ? { id, provider } : undefined
      },
    },
  }

  return { pi: pi as never, ctx: ctx as never, recorded }
}

/** Apply settings against a stub, returning what happened. */
async function apply (settings: RoleSettings, options: Parameters<typeof host>[0] = {}) {
  const { pi, ctx, recorded } = host(options)
  const problems = await applyRoleSettings(settings, pi, ctx)
  return { problems, recorded }
}

describe('applyRoleSettings', () => {
  it('does nothing, and reports nothing, for a role that declares nothing', async () => {
    const { problems, recorded } = await apply({})
    assert.deepEqual(recorded.calls, [])
    assert.deepEqual(problems, [])
  })
})

describe('applying a model', () => {
  it('resolves the model and switches to it', async () => {
    const { problems, recorded } = await apply({ provider: 'anthropic', model: 'claude-sonnet-5' })
    assert.equal(recorded.model, 'claude-sonnet-5')
    assert.deepEqual(problems, [])
  })

  it('reports a model the registry does not have, and leaves the model alone', async () => {
    const { problems, recorded } = await apply(
      { provider: 'anthropic', model: 'nope' },
      { modelFound: false }
    )
    assert.equal(recorded.calls.includes('setModel'), false)
    assert.match(problems[0]!, /not in the registry/)
  })

  /* Pi signals "no credentials for this provider" with `false` rather than a
     throw, and that has to become a visible warning. */
  it('reports a provider with no API key', async () => {
    const { problems } = await apply(
      { provider: 'anthropic', model: 'claude-sonnet-5' },
      { modelApplied: false }
    )
    assert.match(problems[0]!, /no API key for anthropic/)
  })

  it('reports rather than propagates a failure to switch', async () => {
    const { problems } = await apply(
      { provider: 'anthropic', model: 'm' },
      { throwOn: 'setModel' }
    )
    assert.match(problems[0]!, /could not switch/)
  })

  it('reports rather than propagates a failing registry lookup', async () => {
    const { problems } = await apply({ provider: 'a', model: 'm' }, { throwOn: 'find' })
    assert.match(problems[0]!, /could not look up/)
  })
})

describe('applying a thinking level', () => {
  it('sets the level', async () => {
    const { recorded, problems } = await apply({ thinking: 'high' })
    assert.equal(recorded.thinking, 'high')
    assert.deepEqual(problems, [])
  })

  it('reports rather than propagates a failure', async () => {
    const { problems } = await apply({ thinking: 'high' }, { throwOn: 'setThinkingLevel' })
    assert.match(problems[0]!, /could not set thinking level/)
  })
})

describe('ordering', () => {
  /*
   * THE ORDER IS LOAD-BEARING. Pi's `setModel` re-applies the current thinking
   * level clamped to the new model's capabilities, so a thinking level set
   * before the model switch would be overwritten by it. Model must go first for
   * the role's level to survive.
   */
  it('sets the model before the thinking level', async () => {
    const { recorded } = await apply({ provider: 'a', model: 'm', thinking: 'max' })
    assert.deepEqual(recorded.calls, ['setModel', 'setThinkingLevel'])
  })

  it('still applies thinking and tools when the model could not be resolved', async () => {
    const { recorded } = await apply(
      { provider: 'a', model: 'm', thinking: 'low', tools: ['read'] },
      { modelFound: false }
    )
    assert.equal(recorded.thinking, 'low')
    assert.deepEqual(recorded.tools, ['read'])
  })
})

describe('applying tools', () => {
  it('replaces the active set with the named tools', async () => {
    const { recorded, problems } = await apply({ tools: ['read', 'grep'] })
    assert.deepEqual(recorded.tools, ['read', 'grep'])
    assert.deepEqual(problems, [])
  })

  /* `pi.setActiveTools` discards unrecognized names in silence, so the warning
     has to come from here or not at all. */
  it('applies the names it recognizes and reports the rest', async () => {
    const { recorded, problems } = await apply({ tools: ['read', 'telepathy'] })
    assert.deepEqual(recorded.tools, ['read'])
    assert.equal(problems.length, 1)
    assert.match(problems[0]!, /unknown tools ignored: telepathy/)
  })

  /*
   * The most important test in this file. A role written for Pi's built-ins,
   * selected somewhere the tools are named `mcp_read_file`, must not resolve to
   * an empty valid set and disable EVERY tool — that turns a naming mismatch
   * into an agent that cannot read a file.
   */
  it('leaves the tool set alone when nothing in the list exists here', async () => {
    const { recorded, problems } = await apply(
      { tools: ['read', 'grep'] },
      { knownTools: ['mcp_read_file', 'mcp_write_file'] }
    )
    assert.equal(recorded.calls.includes('setActiveTools'), false, 'must not disable everything')
    assert.equal(recorded.tools, undefined)
    assert.match(problems[0]!, /none of these tools exist here/)
  })

  /* Distinct from the case above: asking for nothing is deliberate, and must be
     honored rather than treated as a mismatch. */
  it('disables every tool for an explicitly empty list', async () => {
    const { recorded, problems } = await apply({ tools: [] })
    assert.deepEqual(recorded.tools, [])
    assert.deepEqual(problems, [])
  })

  it('reports rather than propagates an unreadable tool registry', async () => {
    const { problems } = await apply({ tools: ['read'] }, { throwOn: 'getAllTools' })
    assert.match(problems[0]!, /could not read the tool registry/)
  })

  it('reports rather than propagates a rejected tool set', async () => {
    const { problems } = await apply({ tools: ['read'] }, { throwOn: 'setActiveTools' })
    assert.match(problems.at(-1)!, /could not set tools/)
  })
})
