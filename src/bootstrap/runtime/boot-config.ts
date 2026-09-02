// ============================================================================
//  src/bootstrap/runtime/boot-config.ts — the boot-config family owner
//
//
//  Scope: PROCESS — effectively write-once at boot (main()/CLI flag parsing).
//  No conversation/session boundary resets this family; resetStateForTests
//  rebuilds the instance wholesale. Setters are kept (behavior change is out
//  of the scope); write-once tightening is a future, separate decision.
//
//  BOOTSTRAP-ISOLATION LEAF (the same custom-rules/bootstrap-isolation
//  convention state.ts carries): this module imports ONLY types. No
//  src/utils value imports — the settings → state → settings cycle is
//  exactly what bootstrap exists to break. src/bootstrap/state.ts is the
//  ONLY sanctioned importer; every consumer goes through the frozen facade.
// ============================================================================
import type { SettingSource } from 'src/utils/settings/constants.js'

// One --channels/--dangerously-load-development-channels entry. `dev` marks
// PER-ENTRY which flag delivered it — the allowlist gate reads the entry's
// own bit, never the session-wide hasDevChannels bit, so accepting the dev
// dialog for dev entries cannot smuggle allowlist-bypass onto the plain
// --channels entries riding the same session.
export type ChannelEntry =
  | { kind: 'extension'; name: string; label?: string; dev?: boolean }
  | { kind: 'server'; name: string; dev?: boolean }

export class BootConfigOwner {
  flagSettingsPath: string | undefined = undefined
  flagSettingsInline: Record<string, unknown> | null = null
  allowedSettingSources: SettingSource[] = [
    'userSettings',
    'projectSettings',
    'localSettings',
    'flagSettings',
    'policySettings',
  ]
  sessionIngressToken: string | null | undefined = undefined
  oauthTokenFromFd: string | null | undefined = undefined
  apiKeyFromFd: string | null | undefined = undefined
  // --extension <path> loads: live for this session only, never persisted.
  sessionExtensions: Array<string> = []
  // The --channels selection: the operator's own servers whose channel
  // notifications may register in this session under the development
  // bypass. An extension's channels never ride this list — the approval
  // card is their consent (services/mcp/channelNotification.ts).
  allowedChannels: ChannelEntry[] = []
  // Whether ANY allowedChannels entry rode the dangerous dev flag — so
  // ChannelsNotice names the right flag in its policy-blocked messages.
  hasDevChannels = false
  // The operator's added directories (--add-dir at boot; the session's
  // workspace, mirrored by the instruction engine): one more instruction
  // root each — the engine's root chains, the @import boundary and the
  // nested-guide ladders read them, as do skills discovery and the
  // bare-mode instruction law.
  addedDirectories: string[] = []
  // The agent identity the MAIN thread runs as (--agent flag or settings).
  mainThreadAgentType: string | undefined = undefined
  // Direct-connect server URL, surfaced in the header when set.
  directConnectServerUrl: string | undefined = undefined
}
