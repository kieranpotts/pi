/**
 * Wiring tests for the extension entry point.
 *
 * `roles.test.ts` and `prompt.test.ts` cover discovery and composition; these
 * cover the parts only the entry point has: the `/role` command's branches, the
 * per-turn application of a selection, and the session state that has to
 * survive a resume without leaking across a switch.
 *
 * `HOME` IS REDIRECTED FOR EVERY TEST. The extension resolves user-level roles
 * through `os.homedir()`, which on POSIX honors `$HOME` — so without this the
 * suite would discover whatever roles the developer actually has in
 * `~/.pi/roles` and pass or fail according to their machine.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Handler = (event: never, ctx: never) => Promise<unknown>

interface CommandOptions {
  description?: string
  getArgumentCompletions?: (prefix: string) => Promise<Array<{ value: string, label: string }> | null>
  handler: (args: string, ctx: never) => Promise<void>
}

/** What the stub harness captured when the extension registered itself. */
interface Harness {
  hooks: Map<string, Handler>
  command: CommandOptions
  entries: Array<{ customType: string, data: unknown }>
}

let dir: string
let home: string
let cwd: string
let originalHome: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'role-switcher-index-'))
  home = join(dir, 'home')
  cwd = join(dir, 'project')
  await mkdir(join(home, '.pi', 'roles'), { recursive: true })
  await mkdir(cwd, { recursive: true })

  originalHome = process.env.HOME
  process.env.HOME = home
})

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  await rm(dir, { recursive: true, force: true })
})

/** Load the extension against a stub `ExtensionAPI`. */
async function load (): Promise<Harness> {
  const hooks = new Map<string, Handler>()
  const entries: Array<{ customType: string, data: unknown }> = []
  let command: CommandOptions | undefined

  const module = await import('../../../src/extensions/role-switcher/index.ts')
  const register = module.default as (pi: unknown) => void
  register({
    on: (event: string, handler: Handler) => { hooks.set(event, handler) },
    registerCommand: (_name: string, options: CommandOptions) => { command = options },
    appendEntry: (customType: string, data: unknown) => { entries.push({ customType, data }) },
  })

  if (command === undefined) throw new Error('the /role command was not registered')
  return { hooks, command, entries }
}

/** Notifications a context collected, newest last. */
type Notes = Array<{ message: string, type?: string }>

/**
 * A context. `select` stands in for the interactive menu: it is handed the
 * options and returns whichever the test wants chosen (or `undefined` for a
 * dismissed dialog).
 */
function context (options: {
  select?: (title: string, choices: string[]) => Promise<string | undefined>
  sessionEntries?: unknown[]
  hasUI?: boolean
} = {}): { ctx: never, notes: Notes, offered: string[][] } {
  const notes: Notes = []
  const offered: string[][] = []
  const ctx = {
    cwd,
    hasUI: options.hasUI ?? true,
    ui: {
      notify: (message: string, type?: string) => { notes.push({ message, type }) },
      select: async (title: string, choices: string[]) => {
        offered.push(choices)
        return options.select === undefined ? undefined : await options.select(title, choices)
      },
    },
    sessionManager: { getEntries: () => options.sessionEntries ?? [] },
  }
  return { ctx: ctx as never, notes, offered }
}

/**
 * A `before_agent_start` event carrying the minimum Pi always supplies.
 *
 * Built per call rather than once: `cwd` is assigned by `beforeEach`, so a
 * module-scope literal would capture `undefined`.
 */
function turnEvent (options: Record<string, unknown> = {}): never {
  return {
    type: 'before_agent_start',
    prompt: 'hi',
    systemPrompt: 'PI-DEFAULT',
    systemPromptOptions: { cwd, ...options },
  } as never
}

/** Write a user-level role file. */
async function userRole (name: string, text: string): Promise<void> {
  await writeFile(join(home, '.pi', 'roles', `${name}.md`), text)
}

/** Write a project-level role file. */
async function projectRole (name: string, text: string): Promise<void> {
  await mkdir(join(cwd, '.pi', 'roles'), { recursive: true })
  await writeFile(join(cwd, '.pi', 'roles', `${name}.md`), text)
}

describe('role-switcher wiring', () => {
  it('registers the command and the three hooks it needs', async () => {
    const { hooks, command } = await load()
    assert.deepEqual([...hooks.keys()].sort(), ['before_agent_start', 'session_shutdown', 'session_start'])
    assert.equal(typeof command.handler, 'function')
    assert.ok(command.description)
  })

  /*
   * The most important assertion in the file. Pi treats ANY non-undefined
   * return from `before_agent_start` as a replacement system prompt, so an
   * extension with no role selected must return exactly `undefined` — not an
   * empty object, not an empty string — or it silently blanks the agent's
   * identity for every user who installs it and never runs `/role`.
   */
  it('returns undefined with no role selected, leaving Pi\'s prompt alone', async () => {
    const { hooks } = await load()
    const { ctx } = context()
    assert.equal(await hooks.get('before_agent_start')!(turnEvent(), ctx), undefined)
  })
})

describe('/role <name>', () => {
  it('selects a role, which is then applied to the next turn', async () => {
    await userRole('code-reviewer', 'You are a meticulous code reviewer.')
    const { hooks, command } = await load()
    const { ctx, notes } = context()

    await command.handler('code-reviewer', ctx)
    assert.match(notes.at(-1)!.message, /code-reviewer/)

    const result = await hooks.get('before_agent_start')!(turnEvent(), ctx) as { systemPrompt: string }
    assert.ok(result.systemPrompt.startsWith('You are a meticulous code reviewer.'))
  })

  it('rejects an unknown name without changing the selection', async () => {
    await userRole('code-reviewer', 'REVIEWER')
    const { hooks, command } = await load()
    const { ctx, notes } = context()

    await command.handler('nonexistent', ctx)
    assert.equal(notes.at(-1)!.type, 'error')
    assert.match(notes.at(-1)!.message, /code-reviewer/, 'the error should list what is available')
    assert.equal(await hooks.get('before_agent_start')!(turnEvent(), ctx), undefined)
  })

  it('reports the searched paths when there are no roles at all', async () => {
    const { command } = await load()
    const { ctx, notes } = context()

    await command.handler('', ctx)
    assert.equal(notes.at(-1)!.type, 'warning')
    assert.match(notes.at(-1)!.message, /No roles found/)
    assert.match(notes.at(-1)!.message, /\.pi[/\\]roles/, 'it should say where it looked')
  })

  it('clears the selection on `none`, reverting to Pi\'s prompt', async () => {
    await userRole('code-reviewer', 'REVIEWER')
    const { hooks, command } = await load()
    const { ctx } = context()

    await command.handler('code-reviewer', ctx)
    await command.handler('none', ctx)

    assert.equal(await hooks.get('before_agent_start')!(turnEvent(), ctx), undefined)
  })

  /* A stale selection must be clearable even after every role file is gone,
     which is why clearing does not go through discovery first. */
  it('clears even when no role files exist', async () => {
    const { command } = await load()
    const { ctx, notes } = context()
    await command.handler('none', ctx)
    assert.match(notes.at(-1)!.message, /cleared/i)
  })

  it('offers role names and `none` as argument completions', async () => {
    await userRole('code-reviewer', 'x')
    await userRole('technical-lead', 'x')
    const { command } = await load()

    const all = await command.getArgumentCompletions!('')
    assert.deepEqual(all!.map((i) => i.value), ['code-reviewer', 'technical-lead', 'none'])

    const filtered = await command.getArgumentCompletions!('tech')
    assert.deepEqual(filtered!.map((i) => i.value), ['technical-lead'])
  })
})

describe('/role with no argument', () => {
  it('offers a menu of roles with a clearing entry first', async () => {
    await userRole('code-reviewer', 'x')
    await userRole('product-manager', 'x')
    const { command } = await load()
    const { ctx, offered } = context({ select: async () => undefined })

    await command.handler('', ctx)

    assert.equal(offered.length, 1)
    assert.match(offered[0]![0]!, /none/, 'the first entry should clear the role')
    assert.deepEqual(offered[0]!.slice(1), ['code-reviewer', 'product-manager'])
  })

  it('applies the chosen role', async () => {
    await userRole('software-tester', 'You are a software tester.')
    const { hooks, command } = await load()
    const { ctx } = context({ select: async () => 'software-tester' })

    await command.handler('', ctx)

    const result = await hooks.get('before_agent_start')!(turnEvent(), ctx) as { systemPrompt: string }
    assert.ok(result.systemPrompt.startsWith('You are a software tester.'))
  })

  /* Escaping the dialog is not the same as choosing "none". */
  it('leaves the current role alone when the menu is dismissed', async () => {
    await userRole('software-tester', 'TESTER')
    const { hooks, command } = await load()
    const { ctx } = context({ select: async () => undefined })

    await command.handler('software-tester', ctx)
    await command.handler('', ctx)

    const result = await hooks.get('before_agent_start')!(turnEvent(), ctx) as { systemPrompt: string }
    assert.ok(result.systemPrompt.startsWith('TESTER'))
  })

  it('clears when the menu\'s none entry is chosen', async () => {
    await userRole('software-tester', 'TESTER')
    const { hooks, command } = await load()
    const { ctx } = context({ select: async (_t, choices) => choices[0] })

    await command.handler('software-tester', ctx)
    await command.handler('', ctx)

    assert.equal(await hooks.get('before_agent_start')!(turnEvent(), ctx), undefined)
  })

  it('directs the user to the named form when there is no interactive UI', async () => {
    await userRole('software-tester', 'x')
    const { command } = await load()
    const { ctx, notes, offered } = context({ hasUI: false })

    await command.handler('', ctx)

    assert.equal(offered.length, 0, 'no menu without a UI to show it in')
    assert.equal(notes.at(-1)!.type, 'error')
    assert.match(notes.at(-1)!.message, /\/role <name>/)
  })
})

describe('applying a role each turn', () => {
  /* The reason the file is read per turn rather than cached at selection: the
     edit-and-resend loop is how a persona actually gets written. */
  it('picks up an edit to the role file with no re-selection', async () => {
    await userRole('code-reviewer', 'FIRST-VERSION')
    const { hooks, command } = await load()
    const { ctx } = context()
    await command.handler('code-reviewer', ctx)

    const before = await hooks.get('before_agent_start')!(turnEvent(), ctx) as { systemPrompt: string }
    assert.ok(before.systemPrompt.startsWith('FIRST-VERSION'))

    await userRole('code-reviewer', 'SECOND-VERSION')

    const after = await hooks.get('before_agent_start')!(turnEvent(), ctx) as { systemPrompt: string }
    assert.ok(after.systemPrompt.startsWith('SECOND-VERSION'))
  })

  it('lets a project role shadow a user role of the same name', async () => {
    await userRole('software-architect', 'USER-VERSION')
    await projectRole('software-architect', 'PROJECT-VERSION')
    const { hooks, command } = await load()
    const { ctx } = context()

    await command.handler('software-architect', ctx)

    const result = await hooks.get('before_agent_start')!(turnEvent(), ctx) as { systemPrompt: string }
    assert.ok(result.systemPrompt.startsWith('PROJECT-VERSION'))
  })

  it('composes the role with the project context Pi supplied', async () => {
    await userRole('code-reviewer', 'REVIEWER')
    const { hooks, command } = await load()
    const { ctx } = context()
    await command.handler('code-reviewer', ctx)

    const event = turnEvent({ contextFiles: [{ path: 'AGENTS.md', content: 'PROJECT-CONVENTIONS' }] })

    const result = await hooks.get('before_agent_start')!(event, ctx) as { systemPrompt: string }
    assert.ok(result.systemPrompt.includes('PROJECT-CONVENTIONS'), 'AGENTS.md must survive the role swap')
  })

  describe('when the role file goes missing', () => {
    it('falls back to Pi\'s prompt and warns exactly once', async () => {
      await userRole('code-reviewer', 'REVIEWER')
      const { hooks, command } = await load()
      const { ctx, notes } = context()
      await command.handler('code-reviewer', ctx)
      const notesBefore = notes.length

      await rm(join(home, '.pi', 'roles', 'code-reviewer.md'))

      assert.equal(await hooks.get('before_agent_start')!(turnEvent(), ctx), undefined)
      assert.equal(await hooks.get('before_agent_start')!(turnEvent(), ctx), undefined)

      const warnings = notes.slice(notesBefore).filter((n) => n.type === 'warning')
      assert.equal(warnings.length, 1, 'a deleted file must not warn on every turn')
      assert.match(warnings[0]!.message, /code-reviewer/)
    })

    /* Keeping the selection is deliberate: a file may be mid-edit or briefly
       moved, and forgetting the user's choice is worse than a default turn. */
    it('keeps the selection, so the role resumes if the file returns', async () => {
      await userRole('code-reviewer', 'REVIEWER')
      const { hooks, command } = await load()
      const { ctx } = context()
      await command.handler('code-reviewer', ctx)

      await rm(join(home, '.pi', 'roles', 'code-reviewer.md'))
      await hooks.get('before_agent_start')!(turnEvent(), ctx)

      await userRole('code-reviewer', 'RESTORED')
      const result = await hooks.get('before_agent_start')!(turnEvent(), ctx) as { systemPrompt: string }
      assert.ok(result.systemPrompt.startsWith('RESTORED'))
    })

    it('treats a file emptied to whitespace as unavailable', async () => {
      await userRole('code-reviewer', '   \n\n  ')
      const { hooks, command } = await load()
      const { ctx } = context()
      await command.handler('code-reviewer', ctx)

      assert.equal(await hooks.get('before_agent_start')!(turnEvent(), ctx), undefined)
    })
  })
})

describe('session state', () => {
  it('records each selection in the session, so a resume can restore it', async () => {
    await userRole('code-reviewer', 'REVIEWER')
    const { command, entries } = await load()
    const { ctx } = context()

    await command.handler('code-reviewer', ctx)
    assert.deepEqual(entries.at(-1), { customType: 'role-selection', data: { role: 'code-reviewer' } })

    await command.handler('none', ctx)
    assert.deepEqual(entries.at(-1), { customType: 'role-selection', data: { role: null } })
  })

  it('restores the last selection on session_start', async () => {
    await userRole('code-reviewer', 'REVIEWER')
    const { hooks } = await load()
    const { ctx } = context({
      sessionEntries: [
        { type: 'custom', customType: 'role-selection', data: { role: 'product-manager' } },
        { type: 'custom', customType: 'role-selection', data: { role: 'code-reviewer' } },
      ],
    })

    await hooks.get('session_start')!({ type: 'session_start', reason: 'resume' } as never, ctx)

    const result = await hooks.get('before_agent_start')!(turnEvent(), ctx) as { systemPrompt: string }
    assert.ok(result.systemPrompt.startsWith('REVIEWER'), 'the LAST entry should win')
  })

  it('honors a recorded clear rather than reviving an older role', async () => {
    await userRole('code-reviewer', 'REVIEWER')
    const { hooks } = await load()
    const { ctx } = context({
      sessionEntries: [
        { type: 'custom', customType: 'role-selection', data: { role: 'code-reviewer' } },
        { type: 'custom', customType: 'role-selection', data: { role: null } },
      ],
    })

    await hooks.get('session_start')!({ type: 'session_start', reason: 'resume' } as never, ctx)
    assert.equal(await hooks.get('before_agent_start')!(turnEvent(), ctx), undefined)
  })

  /* Switching sessions re-fires `session_start`. Without a reset, the role from
     the session being left would stay active in the one being entered. */
  it('does not leak a role into a session that never selected one', async () => {
    await userRole('code-reviewer', 'REVIEWER')
    const { hooks, command } = await load()
    const { ctx } = context()
    await command.handler('code-reviewer', ctx)

    const fresh = context({ sessionEntries: [] })
    await hooks.get('session_start')!({ type: 'session_start', reason: 'new' } as never, fresh.ctx)

    assert.equal(await hooks.get('before_agent_start')!(turnEvent(), fresh.ctx), undefined)
  })

  it('ignores unrelated and malformed session entries', async () => {
    await userRole('code-reviewer', 'REVIEWER')
    const { hooks } = await load()
    const { ctx } = context({
      sessionEntries: [
        { type: 'custom', customType: 'role-selection', data: { role: 'code-reviewer' } },
        { type: 'custom', customType: 'something-else', data: { role: 'product-manager' } },
        { type: 'custom', customType: 'role-selection' },
        { type: 'custom', customType: 'role-selection', data: { role: 42 } },
        { type: 'message' },
      ],
    })

    await hooks.get('session_start')!({ type: 'session_start', reason: 'resume' } as never, ctx)

    const result = await hooks.get('before_agent_start')!(turnEvent(), ctx) as { systemPrompt: string }
    assert.ok(result.systemPrompt.startsWith('REVIEWER'), 'malformed entries should be skipped, not fatal')
  })

  it('survives a session manager that will not yield entries', async () => {
    const { hooks } = await load()
    const ctx = {
      cwd,
      hasUI: true,
      ui: { notify: () => {}, select: async () => undefined },
      sessionManager: { getEntries: () => { throw new Error('no session') } },
    } as never

    await hooks.get('session_start')!({ type: 'session_start', reason: 'startup' } as never, ctx)
    assert.equal(await hooks.get('before_agent_start')!(turnEvent(), ctx), undefined)
  })

  it('drops the in-memory role at shutdown', async () => {
    await userRole('code-reviewer', 'REVIEWER')
    const { hooks, command } = await load()
    const { ctx } = context()
    await command.handler('code-reviewer', ctx)

    await hooks.get('session_shutdown')!({ type: 'session_shutdown' } as never, ctx)

    assert.equal(await hooks.get('before_agent_start')!(turnEvent(), ctx), undefined)
  })
})
