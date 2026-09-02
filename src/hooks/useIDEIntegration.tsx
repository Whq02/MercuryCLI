// ============================================================================
// useIDEIntegration — the session mount hook (idewave spec).
//
//  Render-nothing wiring between the session screen and the editor-discovery
//  init orchestration: ONE effect, keyed on the five props, invoking the
//  orchestration with a detection callback (the auto-connect predicate plus
//  the idempotent bridge-config injection), the explicit install-request
//  kind, an onboarding callback, and an installation-status callback.
//
//  Auto-connect law: any enabling arm (persisted config, launch flag,
//  embedded editor terminal, advertised-port flag present, pending install
//  request, auto-connect env flag truthy) is vetoed ABSOLUTELY by an
//  explicitly falsy auto-connect env flag.
//
//  Injection law: an existing bridge entry returns the previous config
//  object UNCHANGED — the connection manager's memoized cache keys on object
//  identity, and a fresh object would reconnect a live bridge. The transport
//  rule is the /ide command's literal prefix test (`ws:` selects ws-ide;
//  `wss:` deliberately takes the sse-ide arm) — keep the two call sites
//  identical.
// ============================================================================

import { useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'

import type { ScopedMcpServerConfig } from '../services/mcp/types.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { getGlobalConfig } from '../utils/config.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../utils/envUtils.js'
import {
  IDE_BRIDGE_SERVER_NAME,
  initializeIdeIntegration,
  isSupportedTerminal,
  type DetectedIDEInfo,
  type IDEExtensionInstallationStatus,
  type IdeType,
} from '../utils/ide.js'
import { logError } from '../utils/log.js'


/**
 * The auto-connect flag's LIVE raw value through the registry. ONE raw value
 * serves both the truthy arm and the explicit-falsy veto.
 */
function autoConnectFlagRaw(): string | undefined {
  return flagEnv('MERCURY_IDE_AUTO_CONNECT')
}

/** An embedding editor advertised a channel port into this terminal. Value
 *  PRESENCE only — matching the port against a candidate is detection's job. */
function advertisedIdePortPresent(): boolean {
  const raw = flagEnv('MERCURY_IDE_PORT')
  return raw !== undefined && raw.trim() !== ''
}

interface UseIDEIntegrationProps {
  /** The auto-connect launch flag as the session screen received it. */
  autoConnectIdeFlag: boolean | undefined
  /** Explicit install request set by the /ide command context; wins over the
   *  embedded-terminal kind inside the orchestration. */
  ideToInstallExtension: IdeType | null
  setDynamicMcpConfig: Dispatch<SetStateAction<Record<string, ScopedMcpServerConfig> | undefined>>
  setShowIdeOnboarding: Dispatch<SetStateAction<boolean>>
  setIDEInstallationState: Dispatch<SetStateAction<IDEExtensionInstallationStatus | null>>
}

export function useIDEIntegration({
  autoConnectIdeFlag,
  ideToInstallExtension,
  setDynamicMcpConfig,
  setShowIdeOnboarding,
  setIDEInstallationState,
}: UseIDEIntegrationProps): void {
  useEffect(() => {
    const onIdeDetected = (ide: DetectedIDEInfo | null): void => {
      if (ide === null) return

      const autoConnectRaw = autoConnectFlagRaw()
      // The veto wins over every enabling arm.
      if (isEnvDefinedFalsy(autoConnectRaw)) return
      const enabled =
        getGlobalConfig().autoConnectIde === true ||
        autoConnectIdeFlag === true ||
        isSupportedTerminal() ||
        advertisedIdePortPresent() ||
        ideToInstallExtension !== null ||
        isEnvTruthy(autoConnectRaw)
      if (!enabled) return

      setDynamicMcpConfig(prev => {
        // Identity stability: an existing bridge entry keeps the PREVIOUS
        // object — never reconnect or overwrite a live bridge.
        if (prev?.[IDE_BRIDGE_SERVER_NAME] !== undefined) return prev
        return {
          ...prev,
          [IDE_BRIDGE_SERVER_NAME]: {
            // A literal prefix test: `wss:` deliberately takes the sse-ide
            // arm (identical to the /ide command).
            type: ide.url.startsWith('ws:') ? 'ws-ide' : 'sse-ide',
            url: ide.url,
            ideName: ide.name,
            ...(ide.authToken !== undefined ? { authToken: ide.authToken } : {}),
            ...(ide.ideRunningInWindows !== undefined
              ? { ideRunningInWindows: ide.ideRunningInWindows }
              : {}),
            scope: 'dynamic',
          } as ScopedMcpServerConfig,
        }
      })
    }

    // Never blocks mount: detection is fire-and-forget inside the
    // orchestration, and repeated effect runs are safe (single-flight
    // auto-pick; idempotent injection). The orchestration converts its own
    // failures into status callbacks — the catch is the last-resort guard so
    // a callback throw can never surface as an unhandled rejection.
    void initializeIdeIntegration(
      onIdeDetected,
      ideToInstallExtension,
      () => setShowIdeOnboarding(true),
      status => setIDEInstallationState(status),
    ).catch(logError)
  }, [
    autoConnectIdeFlag,
    ideToInstallExtension,
    setDynamicMcpConfig,
    setShowIdeOnboarding,
    setIDEInstallationState,
  ])
}
