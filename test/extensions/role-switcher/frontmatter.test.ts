/**
 * Splitting a role file into settings and prompt.
 *
 * Two properties matter more than the rest, and both are about what must NOT
 * happen: a frontmatter block must never survive into the prompt (it is
 * configuration, not instructions), and no input may throw, because these files
 * are hand-written and a YAML slip must not make a role unselectable.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseRole } from '../../../src/extensions/role-switcher/frontmatter.ts'

describe('parseRole without frontmatter', () => {
  it('treats the whole file as the prompt', () => {
    const { settings, body, problems } = parseRole('You are a reviewer.')
    assert.deepEqual(settings, {})
    assert.equal(body, 'You are a reviewer.')
    assert.deepEqual(problems, [])
  })

  /* Every role predating frontmatter is this case, so it must stay exact. */
  it('preserves a multi-line body', () => {
    const text = 'You are a reviewer.\n\nWhat you review for:\n- Correctness\n'
    assert.equal(parseRole(text).body, text)
  })
})

describe('parseRole with frontmatter', () => {
  const text = [
    '---',
    'provider: anthropic',
    'model: claude-sonnet-5',
    'thinking: high',
    'tools: [read, grep]',
    '---',
    'You are a reviewer.',
  ].join('\n')

  it('reads every supported key', () => {
    const { settings } = parseRole(text)
    assert.deepEqual(settings, {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      thinking: 'high',
      tools: ['read', 'grep'],
    })
  })

  /* The property that matters most: configuration must not become instruction. */
  it('keeps the block out of the prompt', () => {
    const { body } = parseRole(text)
    assert.equal(body, 'You are a reviewer.')
    assert.equal(body.includes('provider'), false)
    assert.equal(body.includes('---'), false)
  })

  it('reports no problems for a well-formed block', () => {
    assert.deepEqual(parseRole(text).problems, [])
  })

  it('accepts block-style YAML lists too', () => {
    const block = '---\ntools:\n  - read\n  - grep\n---\nBody.'
    assert.deepEqual(parseRole(block).settings.tools, ['read', 'grep'])
  })

  it('ignores keys it does not know', () => {
    const { settings, problems } = parseRole('---\nnotes: whatever\ncolour: blue\n---\nBody.')
    assert.deepEqual(settings, {})
    assert.deepEqual(problems, [], 'unknown keys are how a file carries notes')
  })
})

describe('parseRole validation', () => {
  /* `modelRegistry.find` needs both halves, so half a pair is a mistake worth
     naming rather than half-applying. */
  it('rejects a model without a provider, and says so', () => {
    const { settings, problems } = parseRole('---\nmodel: claude-sonnet-5\n---\nBody.')
    assert.equal('model' in settings, false)
    assert.equal(problems.length, 1)
    assert.match(problems[0]!, /provider/)
  })

  it('rejects a provider without a model, and says so', () => {
    const { settings, problems } = parseRole('---\nprovider: anthropic\n---\nBody.')
    assert.equal('provider' in settings, false)
    assert.match(problems[0]!, /model/)
  })

  it('rejects a thinking level Pi does not have', () => {
    const { settings, problems } = parseRole('---\nthinking: ludicrous\n---\nBody.')
    assert.equal('thinking' in settings, false)
    assert.match(problems[0]!, /thinking/)
  })

  it('accepts every level Pi does have', () => {
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      assert.equal(parseRole(`---\nthinking: ${level}\n---\nB.`).settings.thinking, level)
    }
  })

  it('rejects a tools value that is not a list of names', () => {
    for (const value of ['read', '{ a: b }', '[1, 2]']) {
      const { settings, problems } = parseRole(`---\ntools: ${value}\n---\nBody.`)
      assert.equal('tools' in settings, false, `tools: ${value}`)
      assert.match(problems[0]!, /tools/)
    }
  })

  /* An empty list is a real configuration — a role that only discusses
     requirements should not be able to edit files — and is deliberately
     distinct from an absent key. */
  it('keeps an explicitly empty tools list as empty', () => {
    const { settings, problems } = parseRole('---\ntools: []\n---\nBody.')
    assert.deepEqual(settings.tools, [])
    assert.deepEqual(problems, [])
  })

  it('trims surrounding whitespace from values', () => {
    const { settings } = parseRole('---\nprovider: "  anthropic  "\nmodel: "  m  "\n---\nB.')
    assert.equal(settings.provider, 'anthropic')
    assert.equal(settings.model, 'm')
  })
})

describe('parseRole on malformed input', () => {
  /*
   * The block is unusable, but it must still not reach the model, and the role
   * must still be selectable. Both halves of that are asserted here.
   */
  it('drops unparseable YAML, strips the block, and keeps the body', () => {
    const text = '---\nthis: [is: not: valid\n---\nYou are a reviewer.'
    const { settings, body, problems } = parseRole(text)
    assert.deepEqual(settings, {})
    assert.equal(body, 'You are a reviewer.')
    assert.equal(body.includes('is: not'), false, 'the broken block must not become a prompt')
    assert.equal(problems.length, 1)
    assert.match(problems[0]!, /not valid YAML/)
  })

  /* An unterminated block has no body to find, so the file is left alone
     rather than being silently emptied. */
  it('leaves an unterminated block alone rather than discarding everything', () => {
    const { body } = parseRole('---\nprovider: anthropic\nYou are a reviewer.')
    assert.ok(body.includes('You are a reviewer.'))
  })

  it('never throws, whatever it is given', () => {
    for (const text of ['', '---', '---\n---', '---\n\n---\n', 'no frontmatter', '---\nnull\n---\nB.']) {
      assert.doesNotThrow(() => parseRole(text), `input: ${JSON.stringify(text)}`)
    }
  })

  it('handles CRLF line endings', () => {
    const { settings, body } = parseRole('---\r\nthinking: low\r\n---\r\nYou are a reviewer.')
    assert.equal(settings.thinking, 'low')
    assert.equal(body, 'You are a reviewer.')
  })
})
