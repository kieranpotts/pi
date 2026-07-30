# `permission-gate`

Out-of-the-box, Pi has no permission popups. Every tool call requested by a
model is honored by the harness.

This extension changes that, for **eyes-on, at-keyboard** sessions where a
human is watching each tool call as it happens. With this extension
installed, Pi asks for explicit, interactive confirmation before:

- any tool call naming a **sensitive file** — secrets and key material —
  whether it reads or writes; and
- any **mutating** tool call — writes, edits, moves, and directory creation.

Confirmation defaults to deny, so a timeout or a missing interactive UI
blocks the operation. Read-only calls that do not touch a sensitive file
pass straight through, unprompted.

> [!NOTE]
> This extension does no logging. It is built for a human watching the
> session in real time, where the confirmation dialog itself is the record —
> there is nobody reading an audit trail after the fact. If you need every
> call recorded for an unattended, away-from-keyboard agent instead, see
> [`secret-sentry`][genie-secret-sentry] in my [`genie`][genie] repository,
> which uses the same sensitive-file detection to enforce an absolute,
> unconfirmable block rather than a prompt — because in that context there is
> nobody to answer one.

[genie]: https://github.com/kieranpotts/genie
[genie-secret-sentry]: https://github.com/kieranpotts/genie/blob/main/src/extensions/secret-sentry/README.md

## What it does

This extension runs the following logic on every `tool_call` event, which
fires before a tool is invoked:

1.  **Detect a sensitive file.** \
    Every path-shaped argument is checked against a list of secret and
    key-material filename patterns — `.env*`, `id_rsa`, `*.pem`, `*.key`,
    `*.p12`, `*.pfx`, `.netrc`, `.npmrc`, `.pgpass`, `credentials`,
    `.git-credentials` — matched on the basename, case-insensitively,
    wherever the file lives.

    This check runs on **every** call, including read-only ones: reading a
    private key is worth a second look even eyes-on. A match does not block
    the call outright — it routes it through confirmation below, same as a
    mutating call, with the dialog naming the file so you know why you are
    being asked.

    Arguments are read from the path-bearing keys (`path`, `paths`, `source`,
    `destination`, …), which covers common MCP filesystem server argument
    shapes. Keys that carry patterns rather than paths — `search_files` takes
    `pattern` — are not checked, so searching *for* `*.key` files by name
    does not itself prompt; only reading or writing one does.

2.  **Classify the tool: read-only versus mutating.** \
    Read-only tools (`mcp_read_file`, `mcp_list_directory`, `mcp_search_files`,
    …) pass through without a prompt, unless step 1 already flagged them.
    Mutating tools (`*_write_file`, `*_edit_file`, `*_move_file`,
    `*_create_directory`, and the unprefixed `write` / `edit`) are always
    gated.

3.  **Confirm.** \
    If either check above applies, you are shown the tool name — and, for a
    sensitive-file match, the filename — plus a summary of the operation (the
    path, or a source and destination), and asked to approve. The dialog is
    capped past 800 characters, at which point it says how much it withheld
    rather than trailing an ellipsis. Nothing gated today comes close to that
    cap; it exists for whatever is gated next.

4.  **Deny by default.** \
    The confirmation dialog has a timeout of 60s, after which the call is
    denied. A non-interactive UI also blocks the call. Only an explicit
    approval allows it.

## Configuration

None. There are no settings and no environment variables. Once installed,
the extension just does its thing.

## Installing

From this repository's root directory, run:

```sh
./run/install permission-gate
```
