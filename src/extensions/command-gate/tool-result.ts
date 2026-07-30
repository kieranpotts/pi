/**
 * Tool-result shapes for the gated `bash` replacement.
 *
 * Results must match the shape Pi's built-in `bash` returns, because an
 * override inherits the built-in's renderer and that renderer reads these
 * fields. `details` is `BashToolDetails | undefined`; we return `undefined`,
 * since the truncation and full-output metadata it carries only apply to the
 * built-in's streaming execution path, which a denial never reaches.
 */

import type { BashToolDetails } from '@earendil-works/pi-coding-agent'

/** The result shape Pi expects from the `bash` tool. */
export interface BashResult {
  content: Array<{ type: 'text', text: string }>
  isError: boolean
  details?: BashToolDetails
}

/** A denied/errored tool result carrying a message back to the model. */
export function fail (message: string): BashResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** A successful tool result. */
export function ok (text: string): BashResult {
  return { content: [{ type: 'text', text }], isError: false }
}
