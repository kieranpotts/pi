/**
 * Prompt composition for an active role.
 *
 * A role replaces Pi's entire system prompt, so these tests are mostly about
 * what SURVIVES that replacement: the project's `AGENTS.md`, the skills, the
 * tool list, the working directory. Losing any of them is silent in normal use
 * — the agent simply starts ignoring the project's conventions — which is
 * exactly why it is pinned here.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSyntheticSourceInfo, type BuildSystemPromptOptions, type Skill } from '@earendil-works/pi-coding-agent'
import { composeRolePrompt } from '../../../src/extensions/role-switcher/prompt.ts'

const ROLE = 'You are a meticulous code reviewer.'

/** The minimum Pi always supplies: a cwd and nothing else. */
const bare: BuildSystemPromptOptions = { cwd: '/workspace' }

/** A fuller set, as Pi would hand over in a real project. */
const full: BuildSystemPromptOptions = {
  cwd: '/workspace',
  selectedTools: ['read', 'bash', 'edit', 'write'],
  toolSnippets: {
    read: 'read a file',
    bash: 'run a command',
    edit: 'edit a file',
    write: 'write a file',
  },
  contextFiles: [{ path: '/workspace/AGENTS.md', content: 'PROJECT-CONVENTIONS' }],
}

describe('composeRolePrompt', () => {
  it('leads with the role text, so the identity is the first thing read', () => {
    assert.ok(composeRolePrompt(ROLE, bare).startsWith(ROLE))
  })

  it('trims the role file, so a trailing newline does not shift the layout', () => {
    assert.ok(composeRolePrompt(`\n\n${ROLE}\n\n`, bare).startsWith(ROLE))
  })

  /* The reason this module exists rather than the raw file being returned. */
  it('keeps the project context files a role would otherwise erase', () => {
    const prompt = composeRolePrompt(ROLE, full)
    assert.ok(prompt.includes('PROJECT-CONVENTIONS'))
    assert.ok(prompt.includes('<project_instructions path="/workspace/AGENTS.md">'))
    assert.ok(prompt.includes('</project_context>'))
  })

  it('keeps the working directory', () => {
    assert.ok(composeRolePrompt(ROLE, full).includes('Current working directory: /workspace'))
  })

  it('normalizes Windows separators in the cwd, as Pi does', () => {
    const prompt = composeRolePrompt(ROLE, { cwd: 'C:\\Users\\k\\project' })
    assert.ok(prompt.includes('Current working directory: C:/Users/k/project'))
  })

  /* `cwd` is non-optional in the options type, but this runs on every turn: a
     throw would take down the agent, not just spoil one prompt. */
  it('omits the cwd line rather than throwing when there is no cwd', () => {
    const prompt = composeRolePrompt(ROLE, {} as BuildSystemPromptOptions)
    assert.equal(prompt.includes('Current working directory'), false)
    assert.ok(prompt.startsWith(ROLE))
  })

  it('appends appendSystemPrompt ahead of the project context, as Pi does', () => {
    const prompt = composeRolePrompt(ROLE, { ...full, appendSystemPrompt: 'EXTRA-INSTRUCTION' })
    assert.ok(prompt.indexOf('EXTRA-INSTRUCTION') < prompt.indexOf('PROJECT-CONVENTIONS'))
  })

  it('omits the project context block entirely when there are no context files', () => {
    assert.equal(composeRolePrompt(ROLE, bare).includes('<project_context>'), false)
  })

  describe('the tools list', () => {
    it('lists only tools that came with a snippet', () => {
      const prompt = composeRolePrompt(ROLE, {
        cwd: '/w',
        selectedTools: ['read', 'bash'],
        toolSnippets: { read: 'read a file' },
      })
      assert.ok(prompt.includes('- read: read a file'))
      assert.equal(prompt.includes('- bash'), false)
    })

    /* `--no-builtin-tools` leaves nothing to list, and the prompt must say so
       rather than presenting an empty heading. */
    it('says "(none)" when no tool has a snippet', () => {
      const prompt = composeRolePrompt(ROLE, { cwd: '/w', selectedTools: [] })
      assert.ok(prompt.includes('Available tools:\n(none)'))
    })

    it('notes that custom tools may exist beyond the list', () => {
      assert.ok(composeRolePrompt(ROLE, full).includes('you may have access to other custom tools'))
    })
  })

  describe('the guidelines', () => {
    it('always ends with Pi\'s two standing guidelines, in order', () => {
      const prompt = composeRolePrompt(ROLE, bare)
      assert.ok(prompt.includes('- Be concise in your responses'))
      assert.ok(prompt.indexOf('- Be concise in your responses') < prompt.indexOf('- Show file paths clearly'))
    })

    it('adds the bash-exploration guideline when bash is the only search tool', () => {
      const prompt = composeRolePrompt(ROLE, { cwd: '/w', selectedTools: ['bash'] })
      assert.ok(prompt.includes('- Use bash for file operations like ls, rg, find'))
    })

    it('omits it when a dedicated search tool is present', () => {
      const prompt = composeRolePrompt(ROLE, { cwd: '/w', selectedTools: ['bash', 'grep'] })
      assert.equal(prompt.includes('Use bash for file operations'), false)
    })

    it('carries the caller\'s own guidelines through', () => {
      const prompt = composeRolePrompt(ROLE, { cwd: '/w', promptGuidelines: ['NEVER-COMMIT'] })
      assert.ok(prompt.includes('- NEVER-COMMIT'))
    })

    it('drops blank guidelines rather than emitting an empty bullet', () => {
      const prompt = composeRolePrompt(ROLE, { cwd: '/w', promptGuidelines: ['   ', ''] })
      assert.equal(prompt.includes('- \n'), false)
    })

    /* Upstream de-duplicates, so a caller repeating a standing guideline does
       not get it twice. */
    it('de-duplicates, keeping the first occurrence', () => {
      const prompt = composeRolePrompt(ROLE, {
        cwd: '/w',
        promptGuidelines: ['Be concise in your responses', 'Be concise in your responses'],
      })
      assert.equal(prompt.split('- Be concise in your responses').length - 1, 1)
    })
  })

  describe('skills', () => {
    const skills: Skill[] = [{
      name: 'dataviz',
      description: 'Charting guidance',
      filePath: '/w/.pi/skills/dataviz/SKILL.md',
      baseDir: '/w/.pi/skills/dataviz',
      sourceInfo: createSyntheticSourceInfo('/w/.pi/skills/dataviz/SKILL.md', { source: 'project' }),
      disableModelInvocation: false,
    }]

    it('includes them when the read tool is available', () => {
      const prompt = composeRolePrompt(ROLE, { cwd: '/w', skills })
      assert.ok(prompt.includes('dataviz'))
    })

    /* Skills are read with the `read` tool, so without it they are unreachable
       and Pi omits the section. Matching that keeps the prompt honest. */
    it('omits them when read is not on offer', () => {
      const prompt = composeRolePrompt(ROLE, { cwd: '/w', selectedTools: ['bash'], skills })
      assert.equal(prompt.includes('dataviz'), false)
    })
  })
})
