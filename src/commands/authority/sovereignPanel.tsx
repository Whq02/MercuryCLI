
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

const POLL_MS = 1500

export function useSovereignPosture(): { snapshot: BypassSnapshot } {
  const bypassMode = useAppStateMaybeOutsideOfProvider(
    (s: { toolPermissionContext?: { mode?: string } } | undefined) =>
      s?.toolPermissionContext?.mode,
  ) as string | undefined

  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick(t => (t + 1) % 1_000_000), POLL_MS)
    return () => clearInterval(timer)
  }, [])

  const snapshot = React.useMemo(
    () => bypassSnapshot({ bypassMode }),
    [bypassMode, tick],
  )

  return { snapshot }
}

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
      {}
      {on ? (
        <Box marginTop={1}>
          <SovereignBanner />
        </Box>
      ) : null}

      {}
      <Box marginTop={1}>
        <Text>
          <Text color={FAINT}>state </Text>
          <Text bold color={headColor}>
            {on ? 'ON — permissions bypassed' : 'OFF — prompts active (safe default)'}
          </Text>
          {age ? <Text color={SECOND}> · last changed {age}</Text> : null}
        </Text>
      </Box>

      {}
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

      {}
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
