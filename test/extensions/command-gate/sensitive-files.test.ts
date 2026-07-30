import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isSensitiveFile, sensitiveToken } from '../../../src/extensions/command-gate/sensitive-files.ts'

describe('isSensitiveFile', () => {
  for (const name of [
    '.env', '.env.local', '.env.production',
    '.netrc', '.npmrc', '.pgpass', '.git-credentials', 'credentials',
    'id_rsa', 'id_rsa.pub', 'id_ed25519', 'id_ecdsa', 'id_dsa',
    'server.pem', 'private.key', 'bundle.p12', 'cert.pfx',
  ]) {
    it(`matches ${name}`, () => assert.equal(isSensitiveFile(name), true))
  }

  it('matches wherever the file lives', () => {
    assert.equal(isSensitiveFile('/home/dev/.ssh/id_rsa'), true)
    assert.equal(isSensitiveFile('../../deploy/.env.production'), true)
  })

  it('is case-insensitive', () => {
    assert.equal(isSensitiveFile('SERVER.PEM'), true)
    assert.equal(isSensitiveFile('.ENV'), true)
  })

  for (const name of [
    'index.ts', 'README.md', 'environment.ts', 'keyboard.ts',
    'package.json', '.envrc', 'credentials.md', 'monkey',
  ]) {
    it(`does not match ${name}`, () => assert.equal(isSensitiveFile(name), false))
  }

  it('does not match on a substring — `.envrc` is not `.env`', () => {
    assert.equal(isSensitiveFile('.envrc'), false)
  })

  it('does not match a directory that merely contains secrets', () => {
    // Only the basename is inspected, so the directory is not the signal.
    assert.equal(isSensitiveFile('/home/dev/.ssh/config'), false)
  })
})

describe('sensitiveToken', () => {
  it('finds nothing in an ordinary command', () => {
    assert.equal(sensitiveToken(['ls', '-la', 'src']), undefined)
  })

  it('finds a sensitive argument', () => {
    assert.equal(sensitiveToken(['cat', '/home/dev/.ssh/id_rsa']), '/home/dev/.ssh/id_rsa')
  })

  it('returns the first of several', () => {
    assert.equal(sensitiveToken(['diff', '.env', '.env.local']), '.env')
  })

  it('checks the program token too', () => {
    assert.equal(sensitiveToken(['./deploy.key']), './deploy.key')
  })

  it('flags a pattern argument, accepting the false positive', () => {
    // Documented trade: the cost is one prompt, and a search for key material
    // is arguably worth surfacing regardless.
    assert.equal(sensitiveToken(['find', '.', '-name', '*.pem']), '*.pem')
  })
})

describe('duplication with permission-gate', () => {
  it('keeps SENSITIVE_PATTERNS byte-identical to the permission-gate copy', () => {
    // The two extensions install as self-contained directories and cannot share
    // a module, so the list is duplicated by design. This test is the thing
    // that makes a drift between them loud rather than silent.
    const extract = (path: string): string => {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8')
      const block = /const SENSITIVE_PATTERNS: RegExp\[\] = \[\n([\s\S]*?)\n\]/.exec(source)
      assert.ok(block?.[1], `no SENSITIVE_PATTERNS block found in ${path}`)
      return block[1]
    }

    assert.equal(
      extract('../../../src/extensions/command-gate/sensitive-files.ts'),
      extract('../../../src/extensions/permission-gate/sensitive-files.ts')
    )
  })
})
