import React, { useEffect, useMemo, useState } from 'react'
import { exitChordNoticeText } from './PromptInput/ExitChordNotice.js'
import { setupTerminal, shouldOfferTerminalSetup } from '../commands/terminalSetup/terminalSetup.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text, usePreviewTheme, useTheme, useThemeSetting } from '../ink.js'
import { isAnthropicAuthEnabled } from '../utils/auth.js'
import { normalizeApiKeyForConfig } from '../utils/authPortable.js'
import { getCustomApiKeyStatus } from '../utils/config.js'
import { env } from '../utils/env.js'
import { gracefulShutdown } from '../utils/gracefulShutdown.js'
import { critterDefForKey, miniArtFor } from '../utils/cockpit/critterData.js'
import type { ThemeSetting } from '../utils/theme.js'
import { bootNotes } from '../substrate/bootNotes.js'
import { ApproveApiKey } from './ApproveApiKey.js'
import { ConsoleOAuthFlow } from './ConsoleOAuthFlow.js'
import { AMBER, FAINT, IVORY, SECOND } from './mercuryPalette.js'
import { MercurySetupFrame, type SetupRailStep } from './MercurySetupFrame.js'
import { getSyntaxTheme } from './StructuredDiff/colorDiff.js'
import { StructuredDiff } from './StructuredDiff.js'
import { AnimatedCritterArt } from './mercury-ui/AnimatedCritterArt.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useInteractiveList } from './mercury-ui/useInteractiveList.js'

// ============================================================================
//  Onboarding — Mercury's OWNED first-run flow (the
//  onboarding design spec v1.1). One persistent MercurySetupFrame hosts the sequence — between
//  steps only the body, rail, and footer mutate.
//
//  The signature ("the fitting"): the theme step stages what the
//  machinery already does — moving ↑↓ live-previews the theme, and because
//  the card, the critter art, the syntax diff, and the terminal ground all
//  resolve from the live theme, the whole world re-tints per keystroke.
//  The critter wears the harness; ↵ keeps the fit.
//
//  ONE provider station ("sign in"): the /logins card itself, mounted in
//  place with the FULL nine-family catalogue (the shared row owner —
//  loginFamilyRows.ts — makes walk/card drift structurally impossible), each
//  family's existing sign-in leg run right there, plus the "sign in later"
//  row that continues the walk credential-free (the cockpit opens logged-out
//  and says so honestly). No connectivity pre-gate: reachability is each
//  leg's business, reported typed where the family is chosen — a harness
//  with eight other families and a skip row never exits over one vendor's
//  endpoints. No emoji, no new hex, house grammar only.
// ============================================================================

type StepId = 'theme' | 'provider' | 'api-key' | 'guardrails' | 'terminal'

// TWO appearances (the REACHABLE_THEME_SETTINGS vocabulary): the oasis dark
// identity and True Black — the first-run fitting offers exactly the
// reachable list; the other families stay dormant behind the
// MERCURY_THEME_PIN gate, never offered here.
const THEME_ROWS: { value: ThemeSetting; label: string }[] = [
  { value: 'dark', label: 'Oasis dark · the oasis ground' },
  { value: 'true-black', label: 'True Black · the same palette on pure black' },
]

const FITTING_PATCH = {
  oldStart: 1,
  newStart: 1,
  oldLines: 3,
  newLines: 3,
  lines: [
    ' export function bootHelm() {',
    '-  render(<Splash theme="plain" />)',
    '+  render(<Helm critter="crab" />)',
    ' }',
  ],
}

/** The mascot column for the fitting (spec tiers).
 *  Gates are FIT budgets, not taste: the whole fitting card measures 35 rows
 *  with the hero, 32 flat, ~29 mini — a tier that would scroll the header off
 *  the terminal degrades to the next one down. */
function FittingMascot({ rows, cols }: { rows: number; cols: number }): React.ReactNode {
  const accent = useSessionAccent()
  const def = critterDefForKey(accent.key)
  // Memoized above the tier gates (hook-order stability): a fresh def per
  // render defeats CritterArt's memo — the def-identity rule.
  const miniDef = React.useMemo(
    () => ({ ...def, art: miniArtFor(accent.key) }),
    [def, accent.key],
  )
  if (rows < 29) return null // lockup-only: the header Crab carries identity
  // SPECIMEN: the fitting shows the creature itself, awake — a
  // first-boot fitting room must never open on a sleeping mascot because no
  // agent has run yet (which, on first boot, none has).
  if (rows >= 36 && cols >= 100) {
    return <AnimatedCritterArt def={def} hero specimen />
  }
  if (rows >= 32) {
    return <AnimatedCritterArt def={def} specimen />
  }
  // this tier alone used the STATIC renderer, so the
  // fitting's mascot stopped blinking at exactly the terminal sizes where the
  // two tiers above it kept moving — one component, two behaviours. All three
  // tiers now ride the same animated renderer under the same gates.
  return <AnimatedCritterArt def={miniDef} mini specimen />
}

/** The fitting — theme step. */
function ThemeFitting({
  onKeep,
  onExit,
}: {
  onKeep: (value: ThemeSetting) => void
  onExit: () => void
}): React.ReactNode {
  const { rows, columns } = useTerminalSize()
  const themeSetting = useThemeSetting()
  const { setPreviewTheme, savePreview, cancelPreview } = usePreviewTheme()
  const [, setTheme] = useTheme()
  const accent = useSessionAccent().accent

  const { selectedIndex, rowProps } = useInteractiveList({
    rows: THEME_ROWS,
    rowId: r => r.value,
    idNamespace: 'onboarding:theme',
    initialId: themeSetting,
    onClose: () => {
      cancelPreview()
      onExit()
    },
    actions: [
      {
        key: 'return',
        hint: '↵ keep',
        run: r => {
          if (!r) return ''
          savePreview()
          setTheme(r.value)
          onKeep(r.value)
          return ''
        },
      },
    ],
  })

  // THE FITTING: focus previews — the card, critter, diff, and the terminal
  // ground re-tint in the same frame (usePreviewTheme + token-derived art +
  // syncOasisBgToTheme are all existing machinery; this stages it).
  useEffect(() => {
    const row = THEME_ROWS[selectedIndex]
    if (row) setPreviewTheme(row.value)
  }, [selectedIndex, setPreviewTheme])

  // The syntax name follows the FOCUSED (previewed) theme — the fitting.
  const previewed = THEME_ROWS[selectedIndex]?.value ?? themeSetting
  const syntaxTheme = getSyntaxTheme(previewed)
  const syntaxLine = syntaxTheme
    ? `syntax · ${syntaxTheme.theme} · ctrl+t toggles`
    : 'syntax · off · ctrl+t enables'

  const showMascot = rows >= 29
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {showMascot ? (
          <Box flexShrink={0} marginRight={1}>
            <FittingMascot rows={rows} cols={columns} />
          </Box>
        ) : null}
        <Box flexDirection="column" justifyContent="center">
          <Box flexDirection="row" alignItems="center">
            <Text color={FAINT}>─</Text>
            <Box borderStyle="round" borderColor={FAINT} paddingX={1} flexShrink={0}>
              <Text italic color={SECOND}>
                welcome — pick our colors
              </Text>
            </Box>
          </Box>
        </Box>
      </Box>
      <Text color={SECOND}>the whole harness wears your pick — status colors stay fixed</Text>
      <Box flexDirection="column" marginTop={1}>
        {THEME_ROWS.map((r, i) => (
          <InteractiveRow key={r.value} {...rowProps(r, i)}>
            <Text>
              <Text color={i === selectedIndex ? accent : FAINT}>
                {i === selectedIndex ? ' ▸ ' : '   '}
              </Text>
              <Text color={i === selectedIndex ? IVORY : SECOND}>{r.label}</Text>
            </Text>
          </InteractiveRow>
        ))}
      </Box>
      <Box
        flexDirection="column"
        marginTop={1}
        borderTop
        borderBottom
        borderLeft={false}
        borderRight={false}
        borderStyle="dashed"
        borderColor="subtle"
      >
        <Text color={SECOND}>helm.tsx</Text>
        <StructuredDiff patch={FITTING_PATCH} dim={false} filePath="helm.tsx" firstLine={null} width={Math.min(columns - 8, 92)} />
      </Box>
      <Text color={FAINT}>{syntaxLine}</Text>
    </Box>
  )
}

/** The provider station: THE first-run sign-in moment. The /logins card
 *  itself is mounted in place — catalogue, legs, and per-leg cancel are the
 *  card's own machinery (one owner: the walk cannot drift from /logins) —
 *  and the walk adds only the "sign in later" row (the onSkip seam) plus
 *  outcome settlement into rail motion. An engine leg that settles WITHOUT
 *  a credential (a cancel/refusal receipt) returns to the catalogue with
 *  the receipt painted — never a re-onboarding wall; esc inside a pending
 *  Anthropic leg abandons to the catalogue (onAbandonLeg), while esc on the
 *  catalogue itself backs one station. */
function ProviderStation({
  onSignedIn,
  onSkip,
  onBack,
}: {
  onSignedIn: () => void
  onSkip: () => void
  onBack: () => void
}): React.ReactNode {
  // Bumping the epoch remounts the card at its opening menu — the card owns
  // its state machine, so "return to the catalogue" is a fresh mount.
  const [epoch, setEpoch] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  return (
    <Box flexDirection="column">
      <ConsoleOAuthFlow
        key={epoch}
        onDone={onSignedIn}
        onCancel={onBack}
        onAbandonLeg={() => setEpoch(current => current + 1)}
        onOpenaiDone={result => {
          if (result.ok) {
            onSignedIn()
            return
          }
          setNote(result.receipt)
          setEpoch(current => current + 1)
        }}
        onSkip={onSkip}
      />
      {note !== null ? (
        <Text wrap="wrap">
          <Text color={AMBER}>{`${GLYPH.warn} `}</Text>
          <Text color={SECOND}>{note}</Text>
        </Text>
      ) : null}
    </Box>
  )
}

/** Guardrails (spec — replaces the usual "Security notes"). */
function Guardrails({ onContinue, onBack }: { onContinue: () => void; onBack: () => void }): React.ReactNode {
  const rows = [{ id: 'continue', label: 'continue' }]
  const { rowProps, selectedIndex } = useInteractiveList({
    rows,
    rowId: r => r.id,
    idNamespace: 'onboarding:guardrails',
    onClose: onBack,
    actions: [
      {
        key: 'return',
        hint: '↵ continue',
        run: () => {
          onContinue()
          return ''
        },
      },
    ],
  })
  return (
    <Box flexDirection="column">
      <Text bold color={IVORY}>
        Guardrails
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text wrap="wrap">
          <Text color={AMBER}>{`${GLYPH.warn} `}</Text>
          <Text color={IVORY}>Mercury can make mistakes</Text>
          <Text color={SECOND}> — review what it does, especially before running code.</Text>
        </Text>
        <Text wrap="wrap">
          <Text color={AMBER}>{`${GLYPH.warn} `}</Text>
          <Text color={IVORY}>Prompt injection is real</Text>
          <Text color={SECOND}> — point Mercury only at code you trust.</Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        <InteractiveRow {...rowProps(rows[0]!, 0)}>
          <Text>
            <Text color={selectedIndex === 0 ? IVORY : SECOND}>{' ▸ continue'}</Text>
          </Text>
        </InteractiveRow>
      </Box>
    </Box>
  )
}

/** Terminal keys (spec — conditional). */
function TerminalKeys({
  theme,
  onDone,
  onBack,
}: {
  theme: ThemeSetting
  onDone: () => void
  onBack: () => void
}): React.ReactNode {
  const accent = useSessionAccent().accent
  const rows = [
    { id: 'install', label: 'yes — apply the recommended settings' },
    { id: 'no', label: 'not now — /terminal-setup does it later' },
  ]
  const { selectedIndex, rowProps } = useInteractiveList({
    rows,
    rowId: r => r.id,
    idNamespace: 'onboarding:terminal',
    onClose: onBack,
    actions: [
      {
        key: 'return',
        hint: '↵ select',
        run: r => {
          if (r?.id === 'install') {
            // post-fitting the theme is always concrete; 'auto' cannot reach
            // here (savePreview stored a real value) — narrowed for the API.
            void setupTerminal(theme === 'auto' ? 'dark' : theme)
              .catch(() => {})
              .finally(onDone)
          } else {
            onDone()
          }
          return ''
        },
      },
    ],
  })
  const tweak =
    env.terminal === 'Apple_Terminal'
      ? 'Option+Enter for newlines and the visual bell need one terminal tweak.'
      : 'Shift+Enter for newlines needs one terminal tweak.'
  return (
    <Box flexDirection="column">
      <Text bold color={IVORY}>
        Terminal keys
      </Text>
      <Text color={SECOND}>{tweak}</Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((r, i) => (
          <InteractiveRow key={r.id} {...rowProps(r, i)}>
            <Text>
              <Text color={i === selectedIndex ? accent : FAINT}>
                {i === selectedIndex ? ' ▸ ' : '   '}
              </Text>
              <Text color={i === selectedIndex ? IVORY : SECOND}>{r.label}</Text>
            </Text>
          </InteractiveRow>
        ))}
      </Box>
    </Box>
  )
}

type Props = {
  /** Resolves with the rail this journey ACTUALLY walked (the visible
   *  steps, each done) so the workspace-trust gate can continue the same
   *  rail instead of asserting steps the flow never had. */
  onDone(completedRail: SetupRailStep[]): void
}

export function Onboarding({ onDone }: Props): React.ReactNode {
  const [stepIndex, setStepIndex] = useState(0)
  const [oauthEnabled] = useState(() => isAnthropicAuthEnabled())
  const [theme] = useTheme()
  const exitState = useExitOnCtrlCDWithKeybindings()
  const notes = bootNotes()

  const apiKeyNeedingApproval = useMemo(() => {
    if (!process.env.ANTHROPIC_API_KEY) {
      return ''
    }
    const truncated = normalizeApiKeyForConfig(process.env.ANTHROPIC_API_KEY)
    if (getCustomApiKeyStatus(truncated) === 'new') {
      return truncated
    }
    return ''
  }, [])

  const stepIds = useMemo(() => {
    const ids: StepId[] = ['theme']
    // THE one provider station — the full /logins catalogue, every family's
    // existing leg, and the "sign in later" row. Offered only where
    // Anthropic auth isn't externally provisioned (an external token/key IS
    // a credential; the walk then carries no sign-in station, as before).
    if (oauthEnabled) ids.push('provider')
    if (apiKeyNeedingApproval) ids.push('api-key')
    ids.push('guardrails')
    if (shouldOfferTerminalSetup()) ids.push('terminal')
    return ids
  }, [oauthEnabled, apiKeyNeedingApproval])

  const currentId = stepIds[stepIndex]

  function advance(): void {
    if (stepIndex < stepIds.length - 1) {
      setStepIndex(stepIndex + 1)
    } else {
      onDone(stepIds.map(id => ({ key: id, label: railLabels[id], state: 'done' as const })))
    }
  }

  function back(): void {
    if (stepIndex > 0) setStepIndex(stepIndex - 1)
  }

  // ── the rail: REAL steps only, trust as the standing tail ──
  const railLabels: Record<StepId, string> = {
    theme: 'theme',
    provider: 'sign in',
    'api-key': 'key',
    guardrails: 'guardrails',
    terminal: 'terminal',
  }
  const railSteps: SetupRailStep[] = [
    ...stepIds.map(
      (id, idx): SetupRailStep => ({
        key: id,
        label: railLabels[id],
        state: idx < stepIndex ? 'done' : idx === stepIndex ? 'current' : 'pending',
      }),
    ),
    { key: 'trust', label: 'trust', state: 'pending' },
  ]
  const totalTags = stepIds.length + 1 // + trust
  const stepTag = `${railLabels[currentId ?? 'theme']} · ${stepIndex + 1}/${totalTags}`

  const footers: Record<StepId, string> = {
    theme: '↑↓ preview · ↵ keep · esc exits',
    provider: '↑↓ move · ↵ choose · esc back',
    'api-key': '↑↓ move · ↵ select',
    guardrails: '↵ continue · esc back',
    terminal: '↑↓ move · ↵ select · esc skip',
  }
  const footer = exitState.pending
    ? exitChordNoticeText(exitState.keyName)
    : footers[currentId ?? 'theme']

  let body: React.ReactNode = null
  switch (currentId) {
    case 'theme':
      body = (
        <ThemeFitting
          onKeep={() => advance()}
          onExit={() => {
            void gracefulShutdown(0)
          }}
        />
      )
      break
    case 'provider':
      // Advance ONLY through a settled outcome (onSignedIn / onSkip). Esc on
      // the catalogue backs a station — it must never advance: the rail
      // derives 'done' from position, so an esc that advanced painted
      // "sign in ✓" with no credential (the
      // signin-marked-done-without-credential).
      body = <ProviderStation onSignedIn={advance} onSkip={advance} onBack={back} />
      break
    case 'api-key':
      body = (
        <ApproveApiKey
          customApiKeyTruncated={apiKeyNeedingApproval}
          onDone={() => advance()}
        />
      )
      break
    case 'guardrails':
      body = <Guardrails onContinue={advance} onBack={back} />
      break
    case 'terminal':
      body = <TerminalKeys theme={theme} onDone={advance} onBack={back} />
      break
  }

  return (
    <MercurySetupFrame
      title="first run"
      stepTag={stepTag}
      steps={railSteps}
      footer={footer}
      bootNotes={notes}
    >
      {body}
    </MercurySetupFrame>
  )
}
