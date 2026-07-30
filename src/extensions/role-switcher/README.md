# `role-switcher`

Out of the box, Pi has one identity: *"an expert coding assistant."* It is the
right one for writing code and the wrong one for most of the work around it.
Ask that assistant to specify requirements and it hands you an implementation
plan. Ask it to review a change and it rewrites the change.

This extension makes the identity a file you pick from a list. `/role` shows
every role it can find, and the one you choose replaces Pi's system prompt for
the rest of the session — swappable mid-conversation, with no restart.

```
/role
┌ Pick a role: ─────────────────────┐
│ — none — (Pi's default prompt)    │
│ code-reviewer                     │
│ computer-programmer               │
│ product-manager                   │
│ software-architect                │
│ software-tester                   │
│ technical-lead                    │
│ technical-writer                  │
└───────────────────────────────────┘
```

## Why not an Ollama Modelfile?

Putting the persona in a Modelfile's `SYSTEM` block is the obvious approach,
and it does not work: **Pi sends its own system prompt with every request**,
which overrides whatever the Modelfile declared. The persona has to be
installed from inside Pi or not at all.

So Modelfiles are left holding what they are actually good for — `FROM` and
`PARAMETER`, ie. model choice and tuning — and the personas move here, where
they also become swappable at runtime instead of baked into a model tag.

## Usage

| Command | Effect |
|---|---|
| `/role` | Discover roles and show the selector. |
| `/role <name>` | Select by name, skipping the menu. Tab-completes. |
| `/role none` | Clear the role, reverting to Pi's default prompt. |

Dismissing the menu (Esc) leaves the current role alone — it is not the same as
choosing *none*.

## Defining a role

A role is a Markdown file. **Its filename is the role's name and its body is
the prompt.** There is no registry and no code change: dropping
`security-analyst.md` into a roles directory is the whole operation.

Optionally it opens with a YAML frontmatter block declaring the harness
settings that role wants — see [Role settings](#role-settings) below:

```markdown
---
tools: [read, grep, find, ls]
---

You are a meticulous code reviewer.
```

Two locations are searched, in this order:

| Location | Scope |
|---|---|
| `~/.pi/roles/*.md` | Yours, available in every project. |
| `.pi/roles/*.md` | The project's, relative to Pi's working directory. |

A project role **shadows** a user role of the same name — entirely, not merged,
because a persona that is half one instruction set and half another is not a
persona. Names are sorted for the menu, so its order never depends on the
filesystem's.

The search is not recursive, deliberately: a role's name is its basename, so
two files of the same name in different subdirectories would be one role with
two definitions and no way to say which won.

`none` is reserved for clearing the selection, so a file called `none.md`
cannot be selected.

### Editing the prompt takes effect immediately

The active role's file is **re-read on every turn**, so editing its body changes
the next message's behavior with no re-selection and no restart. That is the
whole point of the per-turn read: writing a good persona is an edit-and-resend
loop, and anything slower discourages the iteration.

**Frontmatter is the exception** — it applies when you select the role. Edit it
and re-run `/role <name>`. See [Role settings](#role-settings) for why.

### The seven roles this repository ships

`run/install role-switcher` copies the roles in `src/roles/` to `~/.pi/roles/`:
`product-manager`, `software-architect`, `technical-lead`,
`computer-programmer`, `code-reviewer`, `software-tester`, and
`technical-writer` — one per stage of the work, each written to stay in its own
lane and hand off rather than to do everything.

They are **seeds, not managed files.** An existing role of the same name is
left alone, because these files are meant to be edited and an installer that
overwrote them would discard your wording on every run. Delete one and re-run
the installer to get the original back.

## Role settings

A role can declare more than a persona. The frontmatter block sets the harness
up for the kind of work that role does:

| Key | Example | Effect |
|---|---|---|
| `tools` | `tools: [read, grep, find, ls]` | Replaces the active tool set. |
| `thinking` | `thinking: high` | Sets the thinking level. One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `provider` + `model` | `provider: anthropic`<br>`model: claude-sonnet-5` | Switches model. **Both keys are required** — the model registry is looked up by provider *and* id, so an id alone is ambiguous. |

Unknown keys are ignored, so a role file can carry notes. Anything present but
unusable — a bad thinking level, a `model` with no `provider`, a tool name that
does not exist here — is **reported as a warning and skipped**, and the role
still activates. A broken setting never costs you the persona.

`tools: []` is meaningful and honored: it means *no tools*, which is right for a
role that only talks. It is distinct from omitting the key, which leaves tools
alone.

### Four things to know before using them

**1. Settings apply when you select a role — once.** Not per turn. `/role`'s
handler runs outside any turn, which is the only safe place: Pi's per-turn model
auth pre-check runs *before* `before_agent_start`, and `setActiveTools` rebuilds
the base system prompt, so pushing either from inside that hook would bypass the
preflight or compose the prompt from a stale tool list.

**2. They are not restored when you clear the role.** `/role none` drops the
persona and **leaves the settings as the role set them.** Picking a role is
picking a setup; giving the persona back is not the same as giving the setup
back. If you want the old model, switch to it with `/model`.

**3. `model` and `thinking` change your global defaults.** Pi's setters write
through to `settings.json` (`setDefaultModelAndProvider`,
`setDefaultThinkingLevel`), so a role's model becomes your default model for
future sessions — exactly as if you had run `/model` yourself. `tools` is
session-scoped and writes nothing. This is why the confirmation message names
what changed rather than applying it quietly.

**4. Your manual changes win.** Nothing re-asserts a role's settings, so a
`/model` after selecting a role simply sticks. The role is not authoritative
over the session; it configured it once.

### Tool names are environment-specific

`tools` lists names as *this* setup registers them. At-keyboard with Pi's
built-ins that is `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`; behind
an MCP gateway it is `mcp_read_file` and friends. `pi.getAllTools()` is the
authority — run `/role` and read the warning if a name is wrong.

If **none** of a role's tool names exist here, the tool set is **left
unchanged** and you get a warning. That guard is deliberate: resolving a
mismatched list to "no valid tools" and applying it would silently leave an
agent that cannot read a file.

### What the shipped roles declare

The four analysis roles — `code-reviewer`, `product-manager`,
`software-architect`, `technical-lead` — ship with a read-only tool set
(`read`, `grep`, `find`, `ls`; no `bash`, `edit`, or `write`), because each of
their prompts already says it hands implementation to someone else. A reviewer
that cannot rewrite the code it is reviewing is strictly better at reviewing.
`computer-programmer`, `software-tester`, and `technical-writer` keep the full
set, since all three legitimately write files.

**None of them sets `model` or `thinking`**, deliberately: your model ids are
yours, and both keys would rewrite your global defaults on first selection. Add
them yourself if you want them.

## What a role prompt actually contains

This is the part worth understanding before writing a role, because it is not
obvious and getting it wrong is silent.

Pi applies what this extension returns **verbatim**
(`this.agent.state.systemPrompt = result.systemPrompt`). Returning a role
file's raw contents would therefore also discard everything Pi assembles
*around* its identity text — and nothing would report the loss. So the
extension rebuilds those sections around the role text:

| Section | Kept? | Note |
|---|---|---|
| Role body | ✅ | First, so the identity leads. Frontmatter is stripped — configuration must not reach the model as instructions. |
| Available tools | ✅ | Rebuilt from the same options Pi used. |
| Guidelines | ✅ | Including any the harness added, de-duplicated. |
| `appendSystemPrompt` | ✅ | In Pi's position, before project context. |
| Project context (`AGENTS.md`) | ✅ | As `<project_instructions>`, unchanged. |
| Skills | ✅ | Rendered by Pi's own `formatSkillsForPrompt`. |
| Current working directory | ✅ | |
| Pi's *"expert coding assistant"* identity | ❌ | Replaced — the point of the extension. |
| Pi's documentation pointer | ❌ | See below. |

**The tools list and the guidelines are added back deliberately.** Pi drops
both when given a custom prompt, assuming whoever replaced the identity also
described the tools. A role file here is a persona, not a tool manual, so those
two sections are reproduced rather than lost.

**Pi's documentation pointer is deliberately omitted** — the block naming the
harness's own README, docs, and examples. It is guidance for working on Pi
itself, it is long, and a `product-manager` or `technical-writer` has no use for
it. A role that needs it can say so in its own text.

> [!NOTE]
> `prompt.ts` is a deliberate re-implementation of the `customPrompt` branch of
> Pi's `buildSystemPrompt`, which is **not** exported from the package — only
> its options type is. Section order and wording mirror upstream so the two can
> be diffed when Pi is upgraded. Keep it that way.

## Session behavior

The selection is recorded in the session as a `role-selection` entry, so
**resuming a session restores its role** rather than silently reverting to
Pi's default. Switching sessions resets first, so a role never leaks from one
conversation into another.

If the active role's file is deleted or emptied mid-session, the turn falls
back to Pi's default prompt and you are warned **once**. The selection is
kept rather than cleared — the file may be mid-edit or briefly moved — so the
role resumes if the file comes back.

## Configuration

None. No settings and no environment variables; the roles directories are the
whole interface.

## Known wrinkle: resuming a session

Resuming restores the **persona** — the selection is recorded in the session, so
the prompt comes back — but it does not re-run the role's frontmatter, because
settings apply only on explicit selection. In practice `model` and `thinking`
are already where the role left them (they persist to `settings.json`), so only
`tools` differs. Re-run `/role <name>` if you want the tool set back.

## Installing

From this repository's root directory, run:

```sh
./run/install role-switcher
```

This installs the extension **and** seeds `~/.pi/roles/`. Then, in Pi:

```sh
/reload
```
