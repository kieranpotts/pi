import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decide, describeCall, describeForPrompt, requiresConfirmation } from '../../../src/extensions/tool-gate/policy.ts'

describe('requiresConfirmation', () => {
  for (const t of ['write', 'edit']) {
    it(`gates unprefixed mutating tool: ${t}`, () => assert.equal(requiresConfirmation(t), true))
  }

  for (const t of ['read', 'ls', 'grep', 'find']) {
    it(`allows read-only builtin: ${t}`, () => assert.equal(requiresConfirmation(t), false))
  }

  it('does not gate `bash` on its own — sensitive-file detection is a separate check', () => {
    assert.equal(requiresConfirmation('bash'), false)
  })

  for (const t of ['mcp_write_file', 'mcp_edit_file', 'mcp_move_file', 'mcp_create_directory']) {
    it(`gates mutating MCP tool: ${t}`, () => assert.equal(requiresConfirmation(t), true))
  }

  for (const t of ['mcp_read_file', 'mcp_list_directory', 'mcp_search_files']) {
    it(`allows read-only MCP tool: ${t}`, () => assert.equal(requiresConfirmation(t), false))
  }
})

describe('describeCall', () => {
  it('summarises a path call', () => {
    assert.equal(describeCall('write', { path: '/workspace/x.ts' }), 'write: /workspace/x.ts')
  })

  it('ignores a command argument, which no tool takes', () => {
    assert.equal(describeCall('mcp_write_file', { command: 'rm -rf /tmp/x' }), 'mcp_write_file')
  })

  it('summarises a move as source -> destination', () => {
    assert.equal(
      describeCall('mcp_move_file', { source: '/a/x.ts', destination: '/a/y.ts' }),
      'mcp_move_file: /a/x.ts -> /a/y.ts'
    )
  })

  it('summarises a multi-file read', () => {
    assert.equal(
      describeCall('mcp_read_multiple_files', { paths: ['/a/x.ts', '/a/y.ts'] }),
      'mcp_read_multiple_files: /a/x.ts, /a/y.ts'
    )
  })

  it('uses the path when a command is also present', () => {
    assert.equal(describeCall('mcp_write_file', { command: 'git status', path: '/a' }), 'mcp_write_file: /a')
  })

  it('falls back to the tool name with no recognised argument', () => {
    assert.equal(describeCall('write', {}), 'write')
  })
})

describe('describeForPrompt — the display cap', () => {
  it('passes a normal description through untouched', () => {
    const detail = 'mcp_write_file: /workspace/src/extensions/tool-gate/policy.ts'
    assert.equal(describeForPrompt(detail), detail)
  })

  /* Everything the gate actually prompts for takes a single path or a
     source/destination pair, so the cap should never fire in practice. If this
     starts failing, a tool with a large argument has been gated and the cap is
     doing real work — which is what it is there for. */
  it('leaves every currently gated shape uncapped', () => {
    for (const detail of [
      describeCall('mcp_write_file', { path: '/workspace/' + 'a/'.repeat(60) + 'x.ts' }),
      describeCall('mcp_move_file', { source: '/workspace/' + 'a/'.repeat(60) + 'x.ts', destination: '/workspace/' + 'b/'.repeat(60) + 'y.ts' }),
      describeCall('mcp_create_directory', { path: '/workspace/' + 'a/'.repeat(60) }),
    ]) {
      assert.equal(describeForPrompt(detail), detail)
    }
  })

  it('caps an oversized description', () => {
    const detail = 'mcp_write_file: ' + 'x'.repeat(5000)
    const out = describeForPrompt(detail)
    assert.equal(out.length < detail.length, true)
    assert.equal(out.startsWith('mcp_write_file: xxx'), true)
  })

  /* An ellipsis reads like formatting. A prompt that hides half of what it is
     confirming has to admit it, and say how much — the prompt is the
     control, so an operator must know when they are seeing a summary. */
  it('says how much it withheld', () => {
    const detail = 'mcp_write_file: ' + 'x'.repeat(5000)
    const out = describeForPrompt(detail)
    assert.match(out, /\[\d+ more characters not shown\]$/)

    const reported = Number(/\[(\d+) more/.exec(out)?.[1])
    const shown = out.slice(0, out.indexOf('\n\n['))
    assert.equal(shown.length + reported, detail.length)
  })
})

describe('decide — default deny', () => {
  it('allows on explicit approval, with no reason to give', () => {
    const d = decide('write', 'approved')
    assert.deepEqual(d, { outcome: 'allowed', confirmation: 'approved' })
  })

  it('denies on rejection', () => {
    const d = decide('write', 'rejected')
    assert.equal(d.outcome, 'blocked')
    assert.equal(d.confirmation, 'rejected')
    assert.match(d.reason ?? '', /user rejected/)
  })

  it('denies on timeout', () => {
    const d = decide('mcp_write_file', 'timeout')
    assert.equal(d.outcome, 'blocked')
    assert.equal(d.confirmation, 'timeout')
    assert.match(d.reason ?? '', /timed out/)
  })

  it('denies when no UI is available', () => {
    const d = decide('edit', 'no-ui')
    assert.equal(d.outcome, 'blocked')
    assert.equal(d.confirmation, 'no-ui')
    assert.match(d.reason ?? '', /no interactive UI/)
  })

  it('reports a distinct confirmation value for each way of being denied', () => {
    const causes = (['rejected', 'timeout', 'no-ui'] as const).map((o) => decide('write', o).confirmation)
    assert.deepEqual(causes, ['rejected', 'timeout', 'no-ui'])
    assert.equal(new Set(causes).size, 3)
  })
})
