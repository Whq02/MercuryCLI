# Compatibility

Mercury's configuration is native and singular: `MERCURY_*` environment
flags registered in the in-code registry (`src/substrate/flagRegistry.ts`;
rendered on demand to an untracked path), `MERCURY.md` instruction files, and
the `.mercury` config homes. No foreign product's environment spelling is
honored anywhere — every runtime env read is a registered `MERCURY_*` name
(the registry proof re-extracts the reads from source and fails on any
unregistered spelling). The interop surfaces that DO remain are wire
identifiers external services require, enumerated below with their owners;
the identity suite (`scripts/identity/`) pins each one and bounds the total.

## Wire identifiers (kept because a server or an external artifact requires them)

- The coding-product API beta token `claude-code-20250219`
  (`src/constants/betas.ts`, exported as `CODING_20250219_BETA_HEADER`) — the
  provider matches the token byte-exact.
- The OAuth app identity: the production client id, the
  `?app=claude-code` success URLs, the `claude_cli` API-key/roles endpoints,
  the `user:sessions:claude_code` scope, and the client-id metadata document
  URL (`src/constants/oauth.ts`) — all matched literally by the sign-in
  servers.
- The client-contract version on the claude.ai sign-in door
  (`ANTHROPIC_CLIENT_CONTRACT_VERSION` in `src/constants/oauth.ts`): the
  subscription endpoint classes a request carrying that app identity as the
  vendor's own CLI and gates models on a minimum client version, read as a
  number from the `cc_version` field of the billing attribution line in the
  system prompt (never from the User-Agent). Mercury presents the declared
  contract version there and nowhere else. When the floor moves,
  `MERCURY_ANTHROPIC_CLIENT_CONTRACT=<version>` raises it without a rebuild;
  the doctor's "Client contract" row shows what is presented; and the gate's
  refusal is reported as what it is — the version read, the version
  required, and that override — never as the vendor's updater advice.
- The User-Agent surface (`src/utils/userAgent.ts`, `src/utils/http.ts`) is
  uniform: every Mercury-owned connection presents the product identity,
  `mercury/<version>` — the provider-API agent appends a parenthesised tail
  (the entrypoint, optional `agent-sdk/…` and `client-app/…`, and the
  turn-scoped `workload/…` segment). Provider-side client identification
  rides the auth material and the app/session headers, not this string. The
  user-initiated web-fetch agent is `Mozilla/5.0 (compatible;
  Mercury/<version>)` — the version alone; no URL, repository name or
  operator identity rides an outbound header.
- The API session header `X-Claude-Code-Session-Id` and the opt-in
  `x-anthropic-additional-protection` header (`src/services/api/client.ts`)
  — server-read request shape; only the opt-in env label is Mercury's
  (`MERCURY_ADDITIONAL_PROTECTION`).
- The IDE websocket auth header `X-Claude-Code-Ide-Authorization` and the
  JetBrains plugin directory name (`src/services/mcp/client.ts`;
  `src/utils/jetbrains.ts` reads the name from that tool's row in the
  signature table, `src/utils/knownAgentClis.ts`) — the installed IDE
  extensions read that exact header and live in that exact directory.
- Foreign-artifact detection: the GitHub Actions context (`src/utils/env.ts`),
  the harness-state classifier behind `/health`
  (`src/utils/knownAgentClis.ts` — Mercury's own fingerprint decides what is
  foreign; the signature table only names a recognized writer), and the
  `.claude/**` permission-dialog patterns
  (`src/tools/FileEditTool/constants.ts`) — reading the external world by
  its real names, never wearing them.
- Defensive scrubs: `src/utils/subprocessEnv.ts` and
  `src/daemon/ownedDaemon.ts` strip foreign session/credential env a nested
  boot may inherit (another tool's token never reaches Mercury's children).

## Child-environment contract

Mercury stamps only its own spellings into processes it spawns: an MCP
`headersHelper` receives `MERCURY_MCP_SERVER_NAME` and
`MERCURY_MCP_SERVER_URL` (`src/services/mcp/headersHelper.ts`); teammate
processes carry `MERCURY_TEAMMATE_COMMAND` / `MERCURY_AGENT_COLOR`
(`src/utils/swarm/constants.ts`); SDK-spawned children receive the
`MERCURY_SDK_*` handshake. Credential-bearing variables (the session OAuth
token among them) are stripped from ordinary subprocess environments.

## Settings schema

Settings files point at Mercury's own JSON schema. The runtime generates it
from the live validator and refreshes it at
`<config-home>/schema/settings.schema.json`
(`src/utils/settings/localSchema.ts`); every user-settings write stamps
`$schema` with that path (`src/utils/settings/settings.ts`), so an editor
validates real Mercury settings offline, versioned with the installed build.
`$schema` is an editor pointer, not configuration: a file carrying any other
pointer keeps validating (`src/utils/settings/types.ts`), and no foreign
schema URL is ever written.
The committed review snapshot is `scripts/settings/settings-schema.json`,
held equal to the generator.

## MCP

Mercury is a Model Context Protocol client. Server configs merge across
scopes — the project `.mcp.json` walk, the user scope, the local scope, a
managed `managed-mcp.json`, and extension-provided servers
(`src/services/mcp/config.ts`) — with per-repository server selection in the
boot menu's MCPs & Skills record, session-scoped toggles in `/mcp`
([KIT.md](KIT.md)), project-scope server approval prompts, and a risk
ceiling (`MERCURY_MCP_MAX_RISK`). An extension declares its MCP servers in
its own manifest ([EXTENSIONS.md](EXTENSIONS.md)).

Mercury consults no vendor registry of "official" MCP servers: every MCP
server is the operator's own configuration, no boot makes a request on its
behalf, and no server is tagged by anyone's registry (the identity gate's
dist invariants hold the vendor registry path at zero).

## claude.ai account connectors

Org-managed connector configs can be fetched from the claude.ai account API —
strictly opt-in (`src/services/mcp/claudeai.ts`): the registered
`MERCURY_CLAUDEAI_MCP` flag alone decides, unset is off, and the fetch
additionally requires a Claude OAuth token carrying the `user:mcp_servers`
scope. Ever-connected connectors are recorded in the global config.

## Extensions

Mercury ships with no source of extensions and adds none on its own: every
source is an operator act (`docs/EXTENSIONS.md`).

## Skills

Skills load from Mercury's homes alone — `.mercury/skills` under the project
tree and under each added directory, `~/.mercury/skills`, the managed policy
tree, and approved extensions (`src/skills/loadSkillsDir.ts`,
`src/extensions/load/commands.ts`). A skill body's template tokens expand in
Mercury's spelling alone, `${MERCURY_SKILL_DIR}` and `${MERCURY_SESSION_ID}`.
Another product's skills folder is never read and its template spelling stays
literal in the body.

## Credentials on macOS

Keychain writes use Mercury's own service name (keyed to the resolved auth
config home). Reads also try two bounded fallback entries
(`src/utils/secureStorage/macOsKeychainHelpers.ts`): a credential stored
under the vendor CLI's service name is carried across to the Mercury name on
the first token refresh, and one stored under the raw spelling of a
non-canonical config-home pin is moved to the canonical name on the first
successful read.
