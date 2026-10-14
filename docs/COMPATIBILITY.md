# Compatibility

Mercury stores configuration in `.mercury` directories, reads `MERCURY_*`
environment switches from `src/substrate/flagRegistry.ts`, and ships four
platform archives.

See [SETTINGS.md](SETTINGS.md) for settings files and keys.

## Project instructions

With `briefs.profile` set to `auto` (the default), Mercury loads `MERCURY.md`
from the project's instruction chain, or `AGENTS.md` when no `MERCURY.md` is
present (`MERCURY.md` can import `@AGENTS.md`). `MERCURY.local.md` loads after
the guide as a personal layer without displacing `AGENTS.md`. Nested guides
attach when files under their directories are read or edited. The `native`
profile loads Mercury instruction files only, and `briefs.exclude` skips named
non-managed paths or globs.

## The Claude sign-in and connectors

The Claude subscription sign-in presents the client-contract version tracked in
[HEALTH-CERTIFICATE.md](HEALTH-CERTIFICATE.md#client-contract). Organization
connector configs from the Claude account API are opt-in via
`MERCURY_ANTHROPIC_CONNECTORS` (off when unset) and require a sign-in with the
`user:mcp_servers` scope.

## Child-environment contract

Mercury sets only `MERCURY_*` variables on child processes: MCP `headersHelper`
commands receive `MERCURY_MCP_SERVER_NAME` and `MERCURY_MCP_SERVER_URL`
(`src/services/mcp/headersHelper.ts`), and hosting applications pass
`MERCURY_HOST_*`. Session OAuth tokens and provider credentials are stripped
from subprocess environments.

## Settings schema

The runtime generates `<config-home>/schema/settings.schema.json` from the live
validator (`src/utils/settings/localSchema.ts`) and stamps `$schema` on user
settings writes (`src/utils/settings/settings.ts`) for offline editor
validation. Files with any other `$schema` value still validate
(`src/utils/settings/types.ts`). The committed snapshot is
`scripts/settings/settings-schema.json`.

## MCP, extensions and skills

Mercury is a Model Context Protocol client merging `.mercury/mcp.json`, user,
local, `managed-mcp.json` and approved extension server definitions
(`src/services/mcp/config.ts`), controlled through the MCPs & Skills menu and
`/mcp` ([KIT.md](KIT.md)) under `MERCURY_MCP_MAX_RISK`. Invalid server entries
are skipped with a warning in `/mcp`. Mercury queries no external MCP registry.

Extensions ([EXTENSIONS.md](EXTENSIONS.md)) and skills load only from Mercury's
configured homes (`.mercury/skills`, `~/.mercury/skills`, managed policy and
approved extensions; `src/skills/loadSkillsDir.ts`,
`src/extensions/load/commands.ts`). Skill templates expand
`${MERCURY_SKILL_DIR}` and `${MERCURY_SESSION_ID}`.

## Credentials on macOS

macOS Keychain entries use Mercury's service name hashed by the resolved auth
config home (`src/utils/secureStorage/macOsKeychainHelpers.ts`), migrating a
legacy unhashed config-home entry on first read.

## Platforms

`src/services/privateChannel/releaseTarget.ts` defines the four release archive
targets (`mercury update` and the installers map the host OS and architecture
to these targets):

| target | archive | machines | built |
| --- | --- | --- | --- |
| `linux-x64` | `mercury-v<version>-linux-x64.tar.gz` | Linux on x86_64 | natively on its runner |
| `macos-arm64` | `mercury-v<version>-macos-arm64.tar.gz` | macOS on Apple silicon | natively on its runner |
| `macos-x64` | `mercury-v<version>-macos-x64.tar.gz` | macOS on Intel | cross-packaged on Apple silicon with Intel packs and tested under Rosetta 2 |
| `windows-x64` | `mercury-v<version>-windows-x64.zip` | Windows on x86_64 | natively on its runner |

Every archive bundles Node 24 LTS, `rg`, the image processor, and platform
native addons (`macos-arm64` also includes the `vendor/embed` addon and 118 MB
`bge-base-en-v1.5` embedding model; `windows-x64` includes the `brush` shell
engine and enforces Windows parity in the recursive-delete ward across drive
roots, `Users`, system folders, share roots and PowerShell pipelines, as
documented in [TRUST.md](TRUST.md)). Linux arm64 and Windows arm64 use source
builds or x64 emulation ([README.md](../README.md)).
