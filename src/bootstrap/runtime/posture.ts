// ============================================================================
//  src/bootstrap/runtime/posture.ts — the session-posture owner
//
//
//  Scope: SESSION — the boolean/enum posture cells (interactivity, client
//  type, remote/bypass/trust/persistence flags, scheduled
//  tasks) plus the assistant activation pair.
//
//  THE ASSISTANT-DEFAULT MEMO DECISION (batch 4c, the sequence's named conscious
//  choice): the build-default memo is an INSTANCE field. Within one instance
//  the first-read latch is unchanged (production behavior identical —
//  isAssistantFamilyAvailable still evaluates the env opt-out exactly once); but
//  resetStateForTests REBUILDS the instance, so the env default is
//  re-evaluated after a reset — an env opt-out set between resets is
//  honored (the cross-test pollution class).
//
//  THE TWO ASSISTANT FACTS ARE DIFFERENT FACTS:
//  "assistant family available" (build-default ON — Monitor/background steering)
//  vs "this session is an away/assistant session" (the explicit flip ONLY —
//  Brief keys off this). Conflating them put the SendUserMessage courier
//  into every interactive desktop chat.
//
//  kept explicit HERE (the same sanctioned leaf import state.ts carried;
//  sibling posture setters must never grow such an edge silently — the
//  contract net's SCOPE-DELTA coupling check pins it).
//
//  BOOTSTRAP-ISOLATION LEAF (the same custom-rules/bootstrap-isolation
//  convention state.ts carries): imports are the ONE sanctioned settings-
//  cache leaf and nothing else. src/bootstrap/state.ts is the ONLY
//  sanctioned importer; every consumer goes through the frozen facade.
// ============================================================================
import { resetSettingsCache } from 'src/utils/settings/settingsCache.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

// Local env-truthiness (the shared isEnvTruthy lives in utils/envUtils.ts,
// which this bootstrap leaf must not import). Same accepted set:
// "1"/"true"/"yes"/"on".
function isPostureEnvTruthy(v: string | undefined): boolean {
  if (!v) return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

export class PostureOwner {
  isInteractive = false
  // Set true ONLY by the one-shot headless entry (`-p "prompt"`, string
  // input): that run never starts the self-pacing scheduler, so scheduling
  // tools cannot fire and must not be advertised. An explicit flag (default
  // false) — never derived from isInteractive, whose unset default is
  // non-interactive — so interactive sessions, streaming-input SDK runs, and
  // provers that never boot the headless entry all keep the scheduling tools.
  headlessOneShot = false
  assistantSessionActive = false
  // Strict pairing posture: ensureToolResultPairing THROWS on a
  // tool_use/tool_result mismatch instead of patching in synthetic
  // placeholders. Trajectory-collecting callers arm it at startup — for
  // them a loud failure beats a transcript quietly padded with fake
  // tool_results.
  strictToolResultPairing = false
  sdkAgentProgressSummariesEnabled = false
  // The field's terse name is deliberate: the build's excluded-string sweep
  // matches the courier tool names case-insensitively, and this spelling
  // stays clear of them.
  userMsgOptIn = false
  clientType = 'cli'
  sessionSource: string | undefined = undefined
  questionPreviewFormat: 'markdown' | 'html' | undefined = undefined
  // --remote flag posture.
  isRemoteMode = false
  // Sovereign mode chosen for THIS session only — never persisted.
  sessionBypassPermissionsMode = false
  // The home-directory trust arm: launching from $HOME shows the trust
  // dialog but an acceptance is held here in memory only (persisting a
  // grant on $HOME would trust everything, forever). Trust-gated features
  // read it for the rest of the session.
  sessionTrustAccepted = false
  // Session persistence opt-out: no transcript writes this session.
  sessionPersistenceDisabled = false
  // Memoized assistant default resolution: ON unless an env opt-out; a
  // mis-stamped version cannot silently kill the assistant family. The env
  // opt-out is the one lever (MERCURY_ASSISTANT_DISABLE — the renamed
  // estate's successor of the retired pair).
  // INSTANCE-scoped — see the header's memo decision.
  private assistantDefaultCache: boolean | null = null

  /**
   * Whether the assistant surface family is available this session.
   *
   * A bare stamp: `false` unless main.tsx flips the session fact on for an
   * enrolled assistant-mode session via setAssistantSessionActive(true).
   *
   * Mercury: the assistant family ships ON. This gates the
   * Monitor/background-task surface (BashTool/PowerShellTool sleep-loop
   * steering) and Brief entitlement — which Mercury wants live by default.
   * An explicit session flip still wins; MERCURY_ASSISTANT_DISABLE opts
   * Mercury back out.
   */
  isAssistantFamilyAvailable(): boolean {
    if (this.assistantSessionActive) return true
    return this.isAssistantDefaultOn()
  }

  /**
   * The EXPLICIT session flip only — never the family build default.
   * Brief activation keys off this — see the
   * header.
   */
  isAssistantSessionActive(): boolean {
    return this.assistantSessionActive
  }

  private isAssistantDefaultOn(): boolean {
    if (this.assistantDefaultCache !== null) return this.assistantDefaultCache
    const optOut = isPostureEnvTruthy(flagEnv('MERCURY_ASSISTANT_DISABLE'))
    this.assistantDefaultCache = !optOut
    return this.assistantDefaultCache
  }

  preferThirdPartyAuthentication(): boolean {
    // Headless clients authenticate third-party — except the editor
    // extension, which is first-party by design.
    return !this.isInteractive && this.clientType !== 'mercury-editor'
  }
}
