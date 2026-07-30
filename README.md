# Pi [![CI check pipeline status][ci-badge]][ci-workflow]

**My extensions for the [Pi coding agent][pi].**

These extensions are for using Pi for at-keyboard AI-assisted software
development. See also my [Genie][genie] project, which wraps Pi with
hardened infrastructure — a sandboxed container, model routing proxy,
and a gated MCP server — for secure away-from-keyboard agentic loop
workflows.

> [!WARNING]
> These tools are built for my personal use and they are volatile. They
> may change, break, or be removed at any time. They carry no support or
> stability guarantees. You're welcome, of course, to fork this repository and
> use it as a basis for engineering your own extensions around Pi. But I
> don't recommend you use these tools as-is.

## ☑️ Requirements

The only requirement is the [Pi coding agent][pi], installed locally and
in your `PATH`:

```sh
npm install -g @earendil-works/pi-coding-agent
```

## 🧭 Usage

This repository packages the following Pi extensions. Click the link to see
its README, which provides detailed usage instructions.

- [**`pickling-penguins`**](./src/extensions/pickling-penguins/README.md): \
  Cosmetic-only replacement for Pi's "Working..." status line. Just for fun.

- [**`permission-gate`**](./src/extensions/permission-gate/README.md): \
  Interactive, default-deny confirmation before any mutating tool call or any
  call touching a sensitive file (secrets, key material). Built for eyes-on,
  at-keyboard use — no logging, the dialog itself is the record. See
  [`genie`][genie] for the away-from-keyboard, unattended counterpart.

An install script is provided to automate the installation of these extensions
into Pi. First, make the script executable:

```sh
chmod +x run/install
```

Then run the script from the root of this repository:

```sh
./run/install
```

The available options are:

| Invocation              | Effect                                |
| ----------------------- | ------------------------------------- |
| `./run/install`         | Install all available extensions.     |
| `./run/install <name>…` | Install one or more named extensions. |
| `./run/install -l`      | List available extensions and exit.   |
| `./run/install --list`  | Same as `-l`.                         |
| `./run/install -h`      | Show usage help and exit.             |
| `./run/install --help`  | Same as `-h`.                         |

Examples:

```sh
./run/install                             # Install all extensions.
./run/install pickling-penguins           # Install the picking penguins extension only.
./run/install permission-gate             # Install the permission gate only.
./run/install --list                      # See what's available to install.
```

The same script can be used to update the installed extensions to the latest
versions in this repository. If an extension is already installed, it is first
backed-up to `~/.pi/agent/extensions/<name>.backup.<timestamp>/`.

Alternatively, you can manually install extensions simply by copying them
over. There is no build step.

```sh
cp -R src/extensions/pickling-penguins ~/.pi/agent/extensions/pickling-penguins
```

New and updated extensions will be loaded next time you run `pi`. If you're
already in Pi, use the `/reload` prompt to reload all extensions, skills, etc.:

```sh
/reload
```

> [!TIP]
> `/reload` is a useful for hot-reloading extensions
> during their development.

## 📓 Developer documentation

See the [contributing guidelines](./CONTRIBUTING.md).

-----

Copyright © 2020-present Kieran Potts, [MIT license](./LICENSE.txt)

Acknowledgements: The structure of this project was inspired by
Owain Lewis's [`pi-extensions`][owain-pi-extensions].
Owain's "funny status" extension was the direct inspiration for
[`pickling-penguins`](./src/extensions/pickling-penguins/README.md),
my first Pi extension. The [Pi example extensions][pi-example-extensions]
are another useful reference point.

[ci-badge]: https://github.com/kieranpotts/pi/actions/workflows/check.yaml/badge.svg
[ci-workflow]: https://github.com/kieranpotts/pi/actions/workflows/check.yaml
[genie]: https://github.com/kieranpotts/genie
[owain-pi-extensions]: https://github.com/owainlewis/pi-extensions/
[pi]: https://pi.dev/
[pi-example-extensions]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/README.md
