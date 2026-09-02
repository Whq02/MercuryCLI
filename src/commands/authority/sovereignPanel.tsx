// ============================================================================
//  /sovereign — the permission-bypass indicator panel (read-only).
//
//  Sovereign mode is the operator's tool-permission-prompt bypass (the in-UI
//  parity of --dangerously-skip-permissions). This surface carries ONLY the
//  read side:
//
//    • useSovereignPosture() — the read-side hook. Reads the LIVE in-process
//                              permission mode reactively from app state
//                              (toolPermissionContext.mode === 'sovereign',
//                              the REAL prompt bypass in THIS REPL) AND a
//                              light poll of the harness flag file
//                              (harness/sovereign.json) as the fallback. NO
//                              write affordance.
//    • SovereignBanner       — the persistent conditional banner. Renders ONLY
//                              when the bypass is active, so the operator can
//                              never lose track of it. CRIMSON spine, the
//                              contract's exact wording, an age label, and one
//                              line of safety prose. Not mounted in the frame:
//                              MercuryFrame's own modeBand is the always-
//                              visible standing badge; this banner heads the
//                              panel.
//    • SovereignPanel        — the /sovereign command surface: the banner +
//                              live state + the read-only note. Sits beside
//                              the /authority and /policy views.
//
//  SAFETY: the bypass covers the permission PROMPT only — it does NOT loosen
//  the spawn allowlist or any other safety-locked control. OPT-IN (default
//  OFF) and, via this banner, always VISIBLE when on. No state is fabricated:
//  a missing source resolves to OFF (prompts active).
// ============================================================================

import * as React from 'react'
import { useEffect, useState } from 'react'
import { CRIMSON, FAINT, IVORY, SECOND, TEAL } from '../../components/mercuryPalette.js'
import { CommandCenter, Sep } from '../../components/mercury-ui/components.js'
import { Box, Text } from '../../ink.js'
import { useAppStateMaybeOutsideOfProvider } from '../../state/AppState.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  bypassAge,
  bypassSnapshot,
  type BypassSnapshot,
} from '../../utils/permissionBypassBridge.js'

// Light fallback poll for the harness flag file (the operator/coord can flip it
// out-of-band). The live in-process mode is the primary, instant signal — this
// only catches a flag-file change made by the harness UI / CLI within POLL_MS.
const POLL_MS = 1500

/** The read-side hook. Returns the honest snapshot, refreshed from the LIVE
 *  permission mode (reactive) + a light poll of the harness flag (fallback).
 *  No setter — the write side stays in the harness UI. */
export function useSovereignPosture(): { snapshot: BypassSnapshot } {
  // Reactive: the REAL prompt bypass active in THIS REPL right now.
  const bypassMode = useAppStateMaybeOutsideOfProvider(
    (s: { toolPermissionContext?: { mode?: string } } | undefined) =>
      s?.toolPermissionContext?.mode,
  ) as string | undefined

  // A tick that advances on the light poll so the harness-flag read refreshes.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick(t => (t + 1) % 1_000_000), POLL_MS)
    return () => clearInterval(timer)
  }, [])

  // Re-read whenever the live mode changes OR the poll ticks. The snapshot read
  // is cheap (one small file stat/read) and never throws.
  const snapshot = React.useMemo(
    () => bypassSnapshot({ bypassMode }),
    [bypassMode, tick],
  )

  return { snapshot }
}

/** The persistent bypass banner. Renders NOTHING when the bypass is off, so
 *  it is safe to mount anywhere; renders the loud danger banner when on.
 *  Mirrors the indicator contract (exact wording, age label). */
export function SovereignBanner(): React.ReactNode {
  const { snapshot } = useSovereignPosture()
  if (!snapshot.data.bypassOn) return null
  const age = bypassAge(snapshot.data.lastChanged)
  return (
    <Box borderStyle="round" borderColor={CRIMSON} paddingX={1}>
      <Text wrap="truncate-end">
        <Text bold color={CRIMSON}>
          ▸▸ sovereign mode — permissions bypassed
        </Text>
        {age ? <Text color={SECOND}> · since {age}</Text> : null}
        <Sep />
        <Text color={FAINT}>in-chat tool-permission prompts are auto-allowed</Text>
      </Text>
    </Box>
  )
}

/** /sovereign — the indicator surface. The persistent banner (when on), the
 *  live bypass state, and the honest read-only note. */
function SovereignPanel({ onClose }: { onClose: () => void }): React.ReactNode {
  const { snapshot } = useSovereignPosture()
  const on = snapshot.data.bypassOn
  const age = bypassAge(snapshot.data.lastChanged)
  const headColor = on ? CRIMSON : TEAL

  return (
    <CommandCenter
      view="sovereign"
      subtitle="permission-bypass indicator"
      onClose={onClose}
    >
      {/* The persistent banner — only when active. */}
      {on ? (
        <Box marginTop={1}>
          <SovereignBanner />
        </Box>
      ) : null}

      {/* Live state line. */}
      <Box marginTop={1}>
        <Text>
          <Text color={FAINT}>state </Text>
          <Text bold color={headColor}>
            {on ? 'ON — permissions bypassed' : 'OFF — prompts active (safe default)'}
          </Text>
          {age ? <Text color={SECOND}> · last changed {age}</Text> : null}
        </Text>
      </Box>

      {/* What lit it (honest provenance: live mode vs harness flag). */}
      {on ? (
        <Box>
          <Text color={FAINT}>
            via{' '}
            {snapshot.data.via === 'mode'
              ? 'live permission mode (sovereign)'
              : snapshot.data.via === 'flag'
                ? 'harness sovereign flag'
                : 'live mode + harness flag'}
          </Text>
        </Box>
      ) : null}

      {/* Safety prose — always honest, never fabricated. */}
      <Box marginTop={1} flexDirection="column">
        {on ? (
          <>
            <Text color={IVORY}>
              Every in-chat tool-permission prompt is auto-allowed and the turn
              proceeds without asking — the in-UI --dangerously-skip-permissions.
            </Text>
            <Text color={SECOND}>
              The spawn allowlist and other safety locks are unchanged. Leave
              sovereign mode to restore the prompts.
            </Text>
          </>
        ) : (
          <Text color={SECOND}>
            The safe default: the agent asks before each tool, as usual. Sovereign
            mode auto-allows every tool-permission prompt for this session — a
            real bypass, not a view filter.
          </Text>
        )}
        <Box marginTop={1}>
          <Text color={FAINT}>
            ◇ Read-only here — this surface reports the live bypass posture and
            never toggles it.
          </Text>
        </Box>
      </Box>
    </CommandCenter>
  )
}

export const call: LocalJSXCommandCall = async onDone => (
  <SovereignPanel onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} />
)
