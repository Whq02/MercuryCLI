# Compatibility

Mercury keeps configuration in its `.mercury` homes, reads `MERCURY_*`
switches from `src/substrate/flagRegistry.ts`, and ships six platform archives.

Providers and platforms also have their own variables, such as
`ANTHROPIC_API_KEY` and `PATH`. [SETTINGS.md](SETTINGS.md) covers the settings
files and their grouped keys.

## Project instructions

With `briefs.profile` set to `auto` (the default), Mercury loads `MERCURY.md`
from the project's instruction chain. When that chain contains no
`MERCURY.md`, it loads the project's `AGENTS.md`. With both guides present,
`MERCURY.md` decides; it can import `AGENTS.md` explicitly with `@AGENTS.md`.
A `MERCURY.local.md` is a personal layer, loaded after the guide, so it does
not prevent `AGENTS.md` from loading. Nested guides attach when their files
are touched under the same guide choice. The `native` profile uses Mercury
instruction files only. `briefs.exclude` skips named paths or patterns, but
cannot exclude managed instructions.

## The Claude sign-in

The Claude sign-in works with your subscription and presents what the
provider's servers require. The health check's `Client contract` row and
the override that raises the presented version are on the
[health page](HEALTH-CERTIFICATE.md#client-contract).

## Child-environment contract

Mercury stamps only its own spellings into processes it spawns: an MCP
`headersHelper` receives `MERCURY_MCP_SERVER_NAME` and
`MERCURY_MCP_SERVER_URL` (`src/services/mcp/headersHelper.ts`); a hosting
application that spawns Mercury passes the `MERCURY_HOST_*` handshake. Credential-bearing variables (the session OAuth
token among them) are stripped from ordinary subprocess environments.

## Settings schema

Settings files point at Mercury's own JSON schema. The runtime generates it
from the live validator and refreshes it at
`<config-home>/schema/settings.schema.json`
(`src/utils/settings/localSchema.ts`); every user-settings write stamps
`$schema` with that path (`src/utils/settings/settings.ts`), so an editor
validates real Mercury settings offline, versioned with the installed build.
`$schema` is an editor pointer (separate from active configuration): a file carrying any other
pointer keeps validating (`src/utils/settings/types.ts`), and no foreign
schema URL is ever written.
The committed review snapshot is `scripts/settings/settings-schema.json`,
held equal to the generator.

## MCP

Mercury is a Model Context Protocol client. Server configs merge across
scopes (the project `.mercury/mcp.json` walk, the user scope, the local scope, a
managed `managed-mcp.json`, and extension-provided servers in
`src/services/mcp/config.ts`) with per-repository server selection in the
Boot Menu's MCPs & Skills record, session-scoped toggles in `/mcp`
([KIT.md](KIT.md)), project-scope server approval prompts, and a risk
ceiling (`MERCURY_MCP_MAX_RISK`). An extension declares its MCP servers in
its own manifest ([EXTENSIONS.md](EXTENSIONS.md)). A server entry that does
not match the configuration schema is dropped and named once as a warning in
`/mcp`'s diagnostics; the entries beside it load as configured.

Mercury consults no vendor registry of "official" MCP servers: every MCP
server is your own configuration, no boot makes a request on its
behalf, and no server is tagged by anyone's registry.

## Claude account connectors

Org-managed connector configs can be fetched from the Claude account API
(strictly opt-in: the registered `MERCURY_ANTHROPIC_CONNECTORS` flag alone
decides, unset is off, and the fetch also requires a Claude sign-in
with the `user:mcp_servers` scope). Ever-connected connectors are recorded
in the global config.

## Extensions

Mercury ships with no source of extensions and adds none on its own: every
source is your act (`docs/EXTENSIONS.md`).

## Skills

Skills load from Mercury's homes alone (`.mercury/skills` under the starting
project's instruction chain, `~/.mercury/skills`, the managed policy tree,
and approved extensions in `src/skills/loadSkillsDir.ts` and
`src/extensions/load/commands.ts`). A skill body's template tokens expand in
Mercury's spelling alone, `${MERCURY_SKILL_DIR}` and `${MERCURY_SESSION_ID}`.

## Credentials on macOS

Keychain writes use Mercury's own service name, keyed to the resolved auth
config home (every home's name carries a hash of its path). Reads also try
one bounded fallback entry
(`src/utils/secureStorage/macOsKeychainHelpers.ts`): a credential stored
under the raw spelling of a non-canonical config-home pin is moved to the
canonical name on the first successful read.

## Platforms

One release archive per target. The target owner is
`src/services/privateChannel/releaseTarget.ts`: the packager's and the build's
`--target` vocabulary, the archive a machine asks for (`mercury update`), and
the installers' `uname` map. Every archive carries its own Node runtime, search
binary and image processor for that platform, and the voice capture and
on-device transcriber addons where they were built (the speech model is a
one-time download into the config home, never in the archive). Every archive
also bundles the `vendor/embed` addon built for its platform and the 118 MB
`bge-base-en-v1.5` embedding model ([MNEME.md](MNEME.md)); on the Linux and
Windows archives the addon runs a vectorised maths kernel, about a tenth of a
second per Recall by meaning (a few hundredths on macOS through Accelerate). The
two Windows archives bundle the `brush` shell engine, and the Windows
recursive-delete safety rule
enforces parity across drive roots, `Users`, system folders, share roots and
PowerShell pipelines ([TRUST.md](TRUST.md)).

| target | archive | machines | built |
| --- | --- | --- | --- |
| `linux-x64` | `mercury-v<version>-linux-x64.tar.gz` | Linux on x86_64 | natively, on its own runner |
| `linux-arm64` | `mercury-v<version>-linux-arm64.tar.gz` | Linux on arm64 (aarch64) | natively, on its own arm64 runner |
| `macos-arm64` | `mercury-v<version>-macos-arm64.tar.gz` | macOS on Apple silicon | natively, on its own runner |
| `macos-x64` | `mercury-v<version>-macos-x64.tar.gz` | macOS on Intel | cross-packaged on the Apple silicon runner with the Intel packs; booted under Rosetta 2 before it publishes |
| `windows-x64` | `mercury-v<version>-windows-x64.zip` | Windows on x86_64 | natively, on its own runner |
| `windows-arm64` | `mercury-v<version>-windows-arm64.zip` | Windows on arm64 | natively, on its own arm64 runner |

Any other machine builds from source (README.md); `mercury update` states that
directly instead of guessing an archive.
