/**
 * Sensitive-filename detection for command tokens.
 *
 * Secrets and key material are matched by NAME, wherever they live, so a
 * command that reads or writes one is put to the operator even when the
 * program itself is allowlisted. `cat` is on the hardwired read-only list and
 * always will be; `cat ~/.ssh/id_rsa` is still something you want to be asked
 * about.
 *
 * DELIBERATE DUPLICATION. `permission-gate/sensitive-files.ts` holds the same
 * patterns, and Genie's `secret-sentry` holds them a third time. They are kept
 * in step by hand, on purpose: each extension installs as a self-contained
 * directory under `~/.pi/agent/extensions/`, so a shared module would mean one
 * extension importing across an install boundary that Pi does not guarantee.
 * The pattern list is short, stable, and append-only in practice. Keep
 * `SENSITIVE_PATTERNS` below byte-identical to the other copies so a diff
 * between them stays empty and a drift is obvious.
 *
 * What differs from the `permission-gate` copy is only the LOOKUP. There, tool
 * inputs are structured, so an explicit list of path-bearing keys avoids
 * mistaking `search_files`'s `pattern: "*.key"` for a request to open a key
 * file. Here the input is a flat token list with no such structure, so every
 * token is checked — see `sensitiveToken` for why that is the right trade.
 *
 * This module only detects. It makes no decision about what happens next, and
 * in particular it does not block anything: `policy.ts` routes a hit to a
 * confirmation, not a denial.
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

/** Whether the basename of `candidate` matches a sensitive-file pattern. Pure. */
export function isSensitiveFile (candidate: string): boolean {
  const name = basename(candidate)
  return SENSITIVE_PATTERNS.some((re) => re.test(name))
}

/**
 * The first token naming a sensitive file, or undefined if none. Returning the
 * offending token (not just a boolean) lets the caller name it in the
 * confirmation dialog. Pure.
 *
 * EVERY token is checked, the program included, exactly as `fencedToken` does.
 * A flat command string carries no type information, so there is no honest way
 * to tell an argument that IS a path from one that merely looks like one.
 *
 * That does mean a pattern argument can match: `find . -name '*.pem'` trips on
 * `*.pem`. This is the right way round for a control whose failure mode is a
 * prompt rather than a refusal — the operator reads the command and approves it
 * in a keystroke, and a search FOR key material is arguably worth surfacing
 * anyway. The opposite trade, staying quiet to avoid a false positive, is the
 * one that costs something.
 */
export function sensitiveToken (tokens: readonly string[]): string | undefined {
  return tokens.find(isSensitiveFile)
}
