import * as React from 'react'
import { Box, Text } from '../ink.js'
import {
  resolveTerminalProfile,
  type TerminalProfileResolution,
} from '../ink/session/terminalProfile.js'
import {
  detectWindowsHostInventory,
  hostSetupActions,
  inventoryLines,
  launchHostSetupAction,
  type HostSetupAction,
  type WindowsHostInventory,
} from '../ink/session/windowsHostSetup.js'
import { Select } from './CustomSelect/index.js'
import { MercurySetupFrame } from './MercurySetupFrame.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'

// ============================================================================
//  TerminalProfileCard — the requirement surface.
//
//  Shown BEFORE the main interface when the host misses a REQUIRED profile
//  capability. The doctrine it enforces: Mercury never silently presents a
//  degraded cockpit — the host either satisfies the full profile, or the
//  operator sees exactly what is missing, what to run instead, and makes the
//  continue decision knowingly. Wears the trust-tone MercurySetupFrame (a
//  boundary surface, not identity red). Non-interactive paths (-p/SDK) never
//  mount this — they never reach showSetupScreens.
//
//  Two friend-path behaviors:
//   · SELF-CLEARING: mounting this card arms raw mode, which fires the boot
//     querier batch (App.tsx) — on Windows Terminal running as the OS
//     default terminal (no WT_SESSION injected) the DECRQM 2026 answer
//     upgrades the sync-output latch within milliseconds, the re-resolve
//     below flips the verdict, and the card dismisses itself instead of
//     telling an operator inside Windows Terminal to go run Windows
//     Terminal. True conhost never answers; the card stays.
//   · DEPENDENCY INVENTORY: on win32 the card detects Windows Terminal /
//     PowerShell 7 / winget presence and offers the install as a selectable
//     action (launched in a separate console window) instead of a bare
//     "relaunch" instruction.
// ============================================================================

/** How long the self-clearing re-resolve keeps watching the live latch. The
 *  DECRQM answer arrives with the first input frames (milliseconds); this is
 *  a generous ceiling, not a wait the operator notices. */
const RERESOLVE_TICK_MS = 150
const RERESOLVE_TICKS = 8

/** How the card watches its OWN install land: after launching winget in its
 *  separate window, re-probe the dependency inventory on a slow beat until
 *  the target reads present (the launch evicted its cached verdict, and a
 *  'missing' re-checks on a bounded window — windowsHostSetup.ts), so the
 *  row heals on screen instead of staying red until a relaunch. Bounded:
 *  a stalled or abandoned install stops the watch, and the card's note
 *  already told the operator what to do next. */
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

  // Self-clearing: re-read the LIVE profile while the boot querier batch
  // settles; a verdict that is not unsupported means the host proved
  // itself (the default-terminal case) — continue without ceremony.
  React.useEffect(() => {
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
      const live = resolveTerminalProfile()
      if (live.verdict !== 'unsupported') {
        clearInterval(timer)
        finish('continue')
        return
      }
      if (ticks >= RERESOLVE_TICKS) clearInterval(timer)
    }, RERESOLVE_TICK_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Dependency inventory (win32 only — elsewhere detection reports unknown
  // and renders nothing).
  React.useEffect(() => {
    let alive = true
    void detectWindowsHostInventory().then(inv => {
      if (alive && process.platform === 'win32') setInventory(inv)
    })
    return () => {
      alive = false
    }
  }, [])

  // The install watch: a launched install re-probes the inventory until the
  // target lands (never-stale law — the card's own action is a writer of
  // the truth its rows paint, so it must reach the reader).
  const [installWatch, setInstallWatch] = React.useState<HostSetupAction['id'] | null>(null)
  React.useEffect(() => {
    if (installWatch === null || process.platform !== 'win32') return
    let alive = true
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
      void detectWindowsHostInventory().then(inv => {
        if (!alive) return
        setInventory(inv)
        const landed =
          installWatch === 'install-windows-terminal'
            ? inv.windowsTerminal === 'present'
            : inv.pwsh7 === 'present'
        if (landed || ticks >= INSTALL_WATCH_TICKS) {
          clearInterval(timer)
          setInstallWatch(null)
        }
      })
    }, INSTALL_WATCH_TICK_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
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

  // BFF-03: esc ENDS THE PROCESS on this card (the Select's
  // onCancel → finish('exit')) — a quitting key must be advertised; the
  // walk's own vocabulary ('esc exits', Onboarding's theme step) is the
  // spelling the footer speaks.
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
          This terminal does not satisfy Mercury&apos;s full profile
          <Text color={tokens.textMuted}> (v{resolution.version})</Text>.
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
          // The block's rows are RESERVED
          // from the first frame on win32 — the probe used to mount this
          // whole section ~1s after paint, re-laying the card under the
          // operator. The roster is fixed (two lines); until the probe
          // lands each paints its honest 'not confirmed' state, and the
          // probe then fills the SAME rows in place.
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
            // Continue leads (first-contact law): a first-run gate whose
            // DEFAULT keystroke ends the process teaches the wrong thing
            // about the product's confidence in itself — the caveat text
            // already carries the honesty.
            { label: 'Continue anyway (not the complete design)', value: 'continue' },
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
