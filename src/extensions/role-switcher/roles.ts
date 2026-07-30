/**
 * Role discovery: finding `<name>.md` files and reading one back.
 *
 * A role is a Markdown file whose basename is the role's name and whose
 * contents are the persona text. There is no registry, no index file, and no
 * code change needed to add one — dropping `technical-writer.md` into a roles
 * directory is the whole operation. That is the point of discovering them
 * rather than declaring them.
 *
 * TWO LOCATIONS, PROJECT WINNING, mirroring Pi's own global-then-project
 * convention (`~/.pi/agent/…` then `.pi/…`):
 *
 *   ~/.pi/roles/*.md     user-level, available in every project
 *   <cwd>/.pi/roles/*.md project-level, shadowing a user role of the same name
 *
 * The shadowing is by name, not by merge: a project's `software-architect.md`
 * replaces the user's entirely rather than appending to it, because a persona
 * that is half one instruction set and half another is not a persona.
 *
 * NOTHING HERE THROWS. A missing directory is the normal case — most projects
 * have no `.pi/roles/` — so an unreadable path yields no roles rather than an
 * error. A discovery failure must never take down the turn it was serving.
 */

import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** The role name reserved for "no role, use Pi's own prompt". */
export const NO_ROLE = 'none'

/** Extension every role file must carry, and which its name excludes. */
const ROLE_EXTENSION = '.md'

/**
 * The directories searched for roles, in precedence order: earlier entries are
 * shadowed by later ones. Returned even when they do not exist, so `/role` can
 * tell the user where it looked.
 */
export function roleDirs (cwd: string, home: string): string[] {
  return [join(home, '.pi', 'roles'), join(cwd, '.pi', 'roles')]
}

/**
 * Discover every role in `dirs`, mapping role name to the file backing it.
 *
 * Later directories shadow earlier ones by name, so callers pass them in
 * precedence order (see `roleDirs`). Keys are sorted so a menu built from them
 * is stable rather than filesystem-ordered.
 */
export async function discoverRoles (dirs: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>()

  for (const dir of dirs) {
    for (const name of await listRoleFiles(dir)) {
      found.set(roleName(name), join(dir, name))
    }
  }

  /* Sort by name, so the selector's order does not depend on readdir's. */
  return new Map([...found].sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * The role file's text, or `undefined` if it cannot be read — deleted since
 * discovery, or replaced by a directory. Callers treat that as "no role".
 */
export async function readRole (path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * The `.md` files directly inside `dir`, or none at all if it cannot be listed.
 *
 * Not recursive, deliberately: a role's name is its basename, so two files of
 * the same name in different subdirectories would be one role with two
 * definitions and no way to say which won.
 */
async function listRoleFiles (dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => !entry.isDirectory() && entry.name.endsWith(ROLE_EXTENSION))
      .map((entry) => entry.name)
  } catch {
    /* Absent or unreadable directory: no roles here, which is not an error. */
    return []
  }
}

/** A role file's name, without its extension. */
function roleName (fileName: string): string {
  return basename(fileName, ROLE_EXTENSION)
}
