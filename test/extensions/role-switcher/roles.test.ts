/**
 * Role discovery.
 *
 * Exercised against real temporary directories rather than a mocked `fs`: the
 * behavior under test IS filesystem behavior — a missing directory, a `.md`
 * that is really a directory, one name defined in two places — and a mock would
 * only assert that the mock behaves as assumed.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverRoles, NO_ROLE, readRole, roleDirs } from '../../../src/extensions/role-switcher/roles.ts'

let dir: string
let userDir: string
let projectDir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'role-switcher-'))
  userDir = join(dir, 'user')
  projectDir = join(dir, 'project')
  await mkdir(userDir, { recursive: true })
  await mkdir(projectDir, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('roleDirs', () => {
  it('searches the user directory then the project one, so the project wins', () => {
    const dirs = roleDirs('/workspace', '/home/k')
    assert.deepEqual(dirs, [join('/home/k', '.pi', 'roles'), join('/workspace', '.pi', 'roles')])
  })
})

describe('discoverRoles', () => {
  it('names a role after its file, without the extension', async () => {
    await writeFile(join(userDir, 'code-reviewer.md'), 'REVIEWER')
    const roles = await discoverRoles([userDir])
    assert.deepEqual([...roles.keys()], ['code-reviewer'])
    assert.equal(roles.get('code-reviewer'), join(userDir, 'code-reviewer.md'))
  })

  /* No roles directory at all is the normal case for most projects, and must
     not be an error — `/role` still has to run and report what it searched. */
  it('yields nothing for a directory that does not exist', async () => {
    const roles = await discoverRoles([join(dir, 'absent')])
    assert.equal(roles.size, 0)
  })

  it('ignores files that are not Markdown', async () => {
    await writeFile(join(userDir, 'notes.txt'), 'x')
    await writeFile(join(userDir, 'README'), 'x')
    assert.equal((await discoverRoles([userDir])).size, 0)
  })

  /* A directory called `architect.md` would otherwise be discovered as a role
     whose text can never be read. */
  it('ignores a directory that happens to end in .md', async () => {
    await mkdir(join(userDir, 'architect.md'))
    assert.equal((await discoverRoles([userDir])).size, 0)
  })

  it('lets a project role shadow a user role of the same name', async () => {
    await writeFile(join(userDir, 'software-architect.md'), 'USER-VERSION')
    await writeFile(join(projectDir, 'software-architect.md'), 'PROJECT-VERSION')

    const roles = await discoverRoles([userDir, projectDir])
    assert.equal(roles.size, 1)
    assert.equal(await readRole(roles.get('software-architect') as string), 'PROJECT-VERSION')
  })

  it('unions roles across directories when the names differ', async () => {
    await writeFile(join(userDir, 'product-manager.md'), 'PM')
    await writeFile(join(projectDir, 'technical-lead.md'), 'TL')
    assert.deepEqual([...(await discoverRoles([userDir, projectDir])).keys()], ['product-manager', 'technical-lead'])
  })

  /* The menu is built from these keys, so their order must not depend on the
     order the filesystem happened to return. */
  it('sorts names, so the menu is stable rather than readdir-ordered', async () => {
    for (const name of ['technical-writer', 'code-reviewer', 'product-manager']) {
      await writeFile(join(userDir, `${name}.md`), 'x')
    }
    assert.deepEqual(
      [...(await discoverRoles([userDir])).keys()],
      ['code-reviewer', 'product-manager', 'technical-writer']
    )
  })

  it('does not recurse into subdirectories', async () => {
    const nested = join(userDir, 'nested')
    await mkdir(nested)
    await writeFile(join(nested, 'hidden-role.md'), 'x')
    assert.equal((await discoverRoles([userDir])).size, 0)
  })
})

describe('readRole', () => {
  it('returns the file text verbatim, since it becomes the system prompt', async () => {
    const path = join(userDir, 'r.md')
    await writeFile(path, 'You are a tester.\n\nLine two.\n')
    assert.equal(await readRole(path), 'You are a tester.\n\nLine two.\n')
  })

  /* Deleted between discovery and the turn that wanted it. The caller falls
     back to Pi's default prompt; it must not have to catch for that. */
  it('returns undefined for a file that is gone rather than throwing', async () => {
    assert.equal(await readRole(join(userDir, 'never-existed.md')), undefined)
  })
})

describe('NO_ROLE', () => {
  it('is the reserved word the command treats as "clear"', () => {
    assert.equal(NO_ROLE, 'none')
  })
})
