import * as React from 'react'
import { useLoad, useTimer } from '../../screen/effects/effects.js'
import { Box, Text } from '../../screen/themedRenderer.js'
import {
  resolveTerminalProfile,
  type TerminalProfileResolution,
} from '../../screen/renderer/terminal-session/terminalProfile.js'
import {
  detectWindowsHostInventory,
  hostSetupActions,
  inventoryLines,
  launchHostSetupAction,
  type HostSetupAction,
  type WindowsHostInventory,
} from '../../screen/renderer/terminal-session/windowsHostSetup.js'
import { Select } from '../../screen/select/index.js'
import { MercurySetupFrame } from './MercurySetupFrame.js'
import { GLYPH } from '../../screen/theme/glyphs.js'
import { useMercuryTokens } from '../../screen/widgets/useMercuryTokens.js'
import { pollUntil } from '../../platform/async/deadline.js'


const RERESOLVE_TICK_MS = 150
const RERESOLVE_TICKS = 8

const INSTALL_WATCH_TICK_MS = 5_000
const INSTALL_WATCH_TICKS = 36

export function TerminalProfileCard({
  resolution,
  onDone,
}: {
  resolution: TerminalProfileResolution
  onDone: (choice: 'exit' | 'continue') => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [inventory, setInventory] = React.useState<WindowsHostInventory | null>(null)
  const [note, setNote] = React.useState<string | null>(null)
  const doneRef = React.useRef(false)
  const finish = (choice: 'exit' | 'continue'): void => {
    if (doneRef.current) return
    doneRef.current = true
    onDone(choice)
  }

  useTimer(signal => {
    let ticks = 0
    void pollUntil(
      () => {
        if (ticks > 0) {
          const live = resolveTerminalProfile()
          if (live.verdict !== 'unsupported') {
            finish('continue')
            return true
          }
          if (ticks >= RERESOLVE_TICKS) return false
        }
        ticks += 1
        return undefined
      },
      RERESOLVE_TICK_MS,
      Infinity,
      () => false,
      { signal, onAbort: () => false },
    )
  }, [])

  useLoad(signal => {
    void detectWindowsHostInventory().then(inv => {
      if (!signal.aborted && process.platform === 'win32') setInventory(inv)
    })
  }, [])

  const [installWatch, setInstallWatch] = React.useState<HostSetupAction['id'] | null>(null)
  useTimer(signal => {
    if (installWatch === null || process.platform !== 'win32') return
    let ticks = 0
    void pollUntil(
      async () => {
        if (ticks > 0) {
          const inv = await detectWindowsHostInventory()
          if (signal.aborted) return false
          setInventory(inv)
          const landed =
            installWatch === 'install-windows-terminal'
              ? inv.windowsTerminal === 'present'
              : inv.pwsh7 === 'present'
          if (landed || ticks >= INSTALL_WATCH_TICKS) {
            setInstallWatch(null)
            return true
          }
        }
        ticks += 1
        return undefined
      },
      INSTALL_WATCH_TICK_MS,
      Infinity,
      () => false,
      { signal, onAbort: () => false },
    )
  }, [installWatch])

  const failing = resolution.checks.filter(c => c.requirement === 'required' && !c.ok)
  const missingRecs = resolution.checks.filter(c => c.requirement === 'recommended' && !c.ok)
  const actions = inventory ? hostSetupActions(inventory) : []

  const runAction = (action: HostSetupAction): void => {
    if (action.command && launchHostSetupAction(action)) {
      setNote(
        `${action.id === 'install-pwsh7' ? 'PowerShell 7' : 'Windows Terminal'} is installing in a separate window — when it finishes, relaunch Mercury from Windows Terminal.`,
      )
      setInstallWatch(action.id)
    } else {
      setNote(`Install from ${action.url}, then relaunch Mercury from Windows Terminal.`)
    }
  }

  const presenceGlyph = (state: string): { glyph: string; tone: string } =>
    state === 'present'
      ? { glyph: GLYPH.ok, tone: tokens.success }
      : state === 'missing'
        ? { glyph: GLYPH.fail, tone: tokens.warning }
        : { glyph: GLYPH.pending, tone: tokens.textMuted }

  return (
    <MercurySetupFrame
      title="terminal check"
      stepTag="terminal · 1/1"
      steps={[{ key: 'terminal', label: 'terminal', state: 'current' }]}
      tone="trust"
      footer="↑↓ move · ↵ select · esc exits"
    >
      <Box flexDirection="column" gap={1}>
        <Text>
          This window cannot show Mercury the way it is designed
          <Text color={tokens.textMuted}> (terminal profile v{resolution.version})</Text>.
        </Text>
        <Box flexDirection="column">
          {failing.map(c => (
            <Box key={c.id} flexDirection="column">
              <Text>
                <Text color={tokens.warning}>{GLYPH.warn} </Text>
                <Text bold>{c.label}</Text>
                <Text color={tokens.textMuted}> — {c.evidence}</Text>
              </Text>
              <Text color={tokens.textSecondary}>{`  ${c.remediation}`}</Text>
            </Box>
          ))}
          {missingRecs.length > 0 ? (
            <Text color={tokens.textMuted}>
              {`${missingRecs.length} recommended capabilit${missingRecs.length === 1 ? 'y' : 'ies'} also absent — /health lists them.`}
            </Text>
          ) : null}
        </Box>
        {inventory !== null || process.platform === 'win32' ? (
          <Box flexDirection="column">
            <Text color={tokens.textMuted}>on this machine:</Text>
            {inventoryLines(
              inventory ?? { windowsTerminal: 'unknown', pwsh7: 'unknown', winget: 'unknown' },
            ).map(line => {
              const p = presenceGlyph(line.state)
              return (
                <Text key={line.label}>
                  <Text color={p.tone}>{`  ${p.glyph} `}</Text>
                  <Text>{line.label}</Text>
                  <Text color={tokens.textMuted}>
                    {` — ${line.state === 'present' ? 'installed' : line.state === 'missing' ? 'not installed' : 'not confirmed'} · ${line.note}`}
                  </Text>
                </Text>
              )
            })}
          </Box>
        ) : null}
        {note ? <Text color={tokens.textSecondary}>{note}</Text> : null}
        <Select
          options={[
            { label: 'Continue anyway (the screen will not be the complete design)', value: 'continue' },
            { label: 'Exit — relaunch in a supported terminal', value: 'exit' },
            ...actions.map(a => ({ label: a.label, value: a.id })),
          ]}
          onChange={(value: string) => {
            if (value === 'exit' || value === 'continue') {
              finish(value)
              return
            }
            const action = actions.find(a => a.id === value)
            if (action) runAction(action)
          }}
          onCancel={() => finish('exit')}
        />
      </Box>
    </MercurySetupFrame>
  )
}
