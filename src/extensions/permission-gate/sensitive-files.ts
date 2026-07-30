/**
 * Sensitive-filename detection.
 *
 * Secrets and key material are matched by NAME, wherever they live, so a call
 * that reads or writes one is routed through the same interactive
 * confirmation as a mutating call — see `index.ts`. This module only
 * detects; it makes no decision about what happens next, and in particular
 * it does not block anything itself.
 *
 * (Away-from-keyboard, unattended use has no human to confirm with — Genie's
 * `secret-sentry` extension uses this same detection differently, to enforce
 * an ABSOLUTE refusal instead of a confirmable one.)
 *
 * This lives here because the permission gate's `tool_call` hook is the one
 * place that sees EVERY tool call, including any `mcp_*` tools an MCP client
 * extension might register. A plain filesystem MCP server enforces its own
 * allowed-directory boundary but has no notion of sensitive filenames, so
 * without this a call could touch a project's committed `.env` or `*.pem`
 * unchallenged.
 *
 * The logic is pure and unit-tested; `index.ts` is the glue that prompts.
 *
 * Note the deliberate division of labour: CONTAINMENT (staying inside the
 * project) is not this module's job, wherever it is enforced. This module
 * does not duplicate it — it only answers "is this name one we should always
 * ask about?".
 */

import { basename } from 'node:path'

/**
 * Filenames that always require confirmation regardless of path: secrets,
 * key material, credential stores. Matched on the basename,
 * case-insensitively, including common compound forms (`.env.local`,
 * `id_rsa.pub`).
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.production
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pgpass$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^.*\.pem$/i,
  /^.*\.key$/i,
  /^.*\.p12$/i,
  /^.*\.pfx$/i,
  /^credentials$/i,
  /^\.git-credentials$/i,
]

/**
 * Tool-input keys whose values are paths. An explicit list rather than a walk
 * of every string in the input, because some arguments are patterns rather
 * than paths — `search_files` takes `pattern: "*.key"`, which must not be
 * mistaken for a request to open a key file. Covers common MCP filesystem
 * server argument shapes (`path`, `paths`, `source`, `destination`) and any
 * tool following the same conventions.
 */
const PATH_KEYS = ['path', 'paths', 'source', 'destination', 'file', 'files', 'filepath', 'target']

/** Whether the basename of `candidate` matches a sensitive-file pattern. Pure. */
export function isSensitiveFile (candidate: string): boolean {
  const name = basename(candidate)
  return SENSITIVE_PATTERNS.some((re) => re.test(name))
}

/**
 * Every path-shaped value in a tool input, flattened: the string values of
 * the path-bearing keys, and the string members of their array forms. Pure.
 */
export function pathArguments (input: Record<string, unknown>): string[] {
  const found: string[] = []

  for (const key of PATH_KEYS) {
    const value = input[key]
    if (typeof value === 'string') found.push(value)
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') found.push(item)
    }
  }

  return found
}

/**
 * The first sensitive path in a tool input, or undefined if none. Returning
 * the offending value (not just a boolean) lets the caller name it in the
 * confirmation dialog. Pure.
 */
export function findSensitiveArgument (input: Record<string, unknown>): string | undefined {
  return pathArguments(input).find(isSensitiveFile)
}
