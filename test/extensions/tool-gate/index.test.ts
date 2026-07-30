/**
 * Wiring tests for the extension entry point.
 *
 * `policy.test.ts` and `sensitive-files.test.ts` assert the pure logic;
 * these assert that `tool_call` is wired to it correctly for a realistic set
 * of calls.
 *
 * The `ExtensionAPI` is stubbed rather than imported: the real one belongs to
 * a running harness, and the only surface this entry point uses is `pi.on`.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>

/** Load the extension against a stub API. */
async function loadExtension (): Promise<Handler> {
  let handler: Handler | undefined
  const module = await import('../../../src/extensions/tool-gate/index.ts')
  const register = module.default as (pi: { on: (e: 'tool_call', h: Handler) => void }) => void
  register({ on: (_event, h) => { handler = h } })
  if (handler === undefined) throw new Error('tool_call handler was not registered')
  return handler
}

/** A context with no interactive UI, which the gate treats as default-deny. */
const noUI = { hasUI: false, ui: { confirm: async () => false } }

/** A context whose UI always approves, recording what it was shown. */
function approvingUI (): { ctx: { hasUI: boolean, ui: { confirm: (title: string, message: string) => Promise<boolean> } }, shown: { title?: string, message?: string } } {
  const shown: { title?: string, message?: string } = {}
  return {
    shown,
    ctx: {
      hasUI: true,
      ui: {
        confirm: async (title: string, message: string) => {
          shown.title = title
          shown.message = message
          return true
        },
      },
    },
  }
}

describe('tool-gate wiring', () => {
  it('registers exactly the tool_call hook', async () => {
    let registered: string | undefined
    const module = await import('../../../src/extensions/tool-gate/index.ts')
    const register = module.default as (pi: { on: (e: string, h: Handler) => void }) => void
    register({ on: (event) => { registered = event } })
    assert.equal(registered, 'tool_call')
  })

  it('lets a read-only, non-sensitive call through without a prompt', async () => {
    const handler = await loadExtension()
    let asked = false
    const ctx = { hasUI: true, ui: { confirm: async () => { asked = true; return true } } }

    const outcome = await handler(
      { toolCallId: 'tc_1', toolName: 'mcp_read_file', input: { path: '/workspace/a.ts' } },
      ctx
    )

    assert.equal(outcome, undefined)
    assert.equal(asked, false, 'a read-only, non-sensitive call must not prompt')
  })

  it('prompts for a mutating call, and allows it on approval', async () => {
    const handler = await loadExtension()
    const { ctx, shown } = approvingUI()

    const outcome = await handler(
      { toolCallId: 'tc_2', toolName: 'mcp_write_file', input: { path: '/workspace/x.ts', content: 'y' } },
      ctx
    )

    assert.equal(outcome, undefined, 'approval must not block the call')
    assert.match(shown.title ?? '', /Allow mcp_write_file\?/)
    assert.equal(shown.title?.includes('sensitive'), false)
  })

  it('denies a mutating call by default when there is no interactive UI', async () => {
    const handler = await loadExtension()
    const outcome = await handler(
      { toolCallId: 'tc_3', toolName: 'mcp_write_file', input: { path: '/workspace/x.ts' } },
      noUI
    ) as { block?: boolean, reason?: string }

    assert.equal(outcome.block, true)
    assert.match(outcome.reason ?? '', /no interactive UI/)
  })

  it('denies a mutating call the user rejects', async () => {
    const handler = await loadExtension()
    const ctx = { hasUI: true, ui: { confirm: async () => false } }

    const outcome = await handler(
      { toolCallId: 'tc_4', toolName: 'mcp_edit_file', input: { path: '/workspace/x.ts', edits: [] } },
      ctx
    ) as { block?: boolean, reason?: string }

    assert.equal(outcome.block, true)
    assert.match(outcome.reason ?? '', /user rejected/)
  })

  /* The extension: a call naming a sensitive file is not blocked outright —
     unlike Genie's `secret-sentry` — it is routed through the same
     confirmation as a mutating call, so a human decides. */
  it('prompts for a sensitive-file READ, not just a write', async () => {
    const handler = await loadExtension()
    const { ctx, shown } = approvingUI()

    const outcome = await handler(
      { toolCallId: 'tc_5', toolName: 'mcp_read_file', input: { path: '/workspace/.env' } },
      ctx
    )

    assert.equal(outcome, undefined, 'approval must let the read through')
    assert.match(shown.title ?? '', /sensitive file: \.env/)
  })

  it('denies a sensitive-file call by default when there is no interactive UI', async () => {
    const handler = await loadExtension()
    const outcome = await handler(
      { toolCallId: 'tc_6', toolName: 'mcp_read_file', input: { path: '/workspace/id_rsa' } },
      noUI
    ) as { block?: boolean }

    assert.equal(outcome.block, true)
  })

  it('names the sensitive file in the dialog title by basename, not the full path', async () => {
    const handler = await loadExtension()
    const { ctx, shown } = approvingUI()

    await handler(
      { toolCallId: 'tc_7', toolName: 'mcp_read_file', input: { path: '/workspace/deep/nested/id_rsa' } },
      ctx
    )

    assert.match(shown.title ?? '', /sensitive file: id_rsa/)
    assert.equal(shown.title?.includes('/workspace/deep/nested/'), false)
  })

  it('caps a very long detail in the dialog, but the call still proceeds on approval', async () => {
    const handler = await loadExtension()
    const path = '/workspace/' + 'a/'.repeat(2000) + 'x.ts'
    const { ctx, shown } = approvingUI()

    const outcome = await handler(
      { toolCallId: 'tc_8', toolName: 'mcp_write_file', input: { path } },
      ctx
    )

    assert.equal(outcome, undefined)
    assert.equal(shown.message?.includes(path), false, 'the dialog should not have to render it all')
    assert.match(shown.message ?? '', /more characters not shown/)
  })

  it('does not touch a search pattern that merely looks like a key file', async () => {
    const handler = await loadExtension()
    let asked = false
    const ctx = { hasUI: true, ui: { confirm: async () => { asked = true; return true } } }

    const outcome = await handler(
      { toolCallId: 'tc_9', toolName: 'mcp_search_files', input: { path: '/workspace', pattern: '*.key' } },
      ctx
    )

    assert.equal(outcome, undefined)
    assert.equal(asked, false)
  })
})
