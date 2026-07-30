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

A role is a Markdown file. **Its filename is the role's name and its contents
are the prompt.** There is no registry and no code change: dropping
`security-analyst.md` into a roles directory is the whole operation.

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

### Editing a role takes effect immediately

The active role's file is **re-read on every turn**, so editing it changes the
next message's behavior with no re-selection and no restart. That is the whole
point of the per-turn read: writing a good persona is an edit-and-resend loop,
and anything slower discourages the iteration.

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
| Role text | ✅ | First, so the identity leads. |
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

## Not implemented

Role files are prompt text only. They carry **no frontmatter**, and so cannot
yet declare a model, a tool subset, or a thinking level — all of which a role
is a natural place to set. Adding it means parsing frontmatter (Pi exports
`parseFrontmatter` and `stripFrontmatter`) and would change what a role file
means, so it is left out until it is actually wanted.

## Installing

From this repository's root directory, run:

```sh
./run/install role-switcher
```

This installs the extension **and** seeds `~/.pi/roles/`. Then, in Pi:

```sh
/reload
```
