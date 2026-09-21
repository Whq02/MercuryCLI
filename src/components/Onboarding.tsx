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
import { DEFAULT_THEME_SETTING } from '../utils/systemTheme.js'
import type { ThemeSetting } from '../utils/theme.js'
import { bootNotes } from '../substrate/bootNotes.js'
import { ApproveApiKey } from './ApproveApiKey.js'
import { ConsoleOAuthFlow } from './ConsoleOAuthFlow.js'
import { AMBER, FAINT, IVORY, SECOND } from './mercuryPalette.js'
import { MercurySetupFrame, useFirstRunCardsCentred, type SetupRailStep } from './MercurySetupFrame.js'
import { getSyntaxTheme } from './StructuredDiff/colorDiff.js'
import { StructuredDiff } from './StructuredDiff.js'
import { AnimatedCritterArt } from './mercury-ui/AnimatedCritterArt.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useInteractiveList } from './mercury-ui/useInteractiveList.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'


type StepId = 'theme' | 'provider' | 'api-key' | 'guardrails' | 'terminal'

const THEME_ROWS: { value: ThemeSetting; label: string }[] = [
  { value: 'dark', label: 'Oasis dark · Oasis background' },
  { value: 'true-black', label: 'True Black · the same palette on a pure black background' },
]

const THEME_WORDS = {
  bubble: 'Choose your theme',
  tagline: 'Your theme applies throughout Mercury. Status colors stay the same.',
  fileName: 'helm.tsx',
}

const GUARDRAILS_WORDS = {
  title: 'Guardrails',
  mistakes: 'Mercury can make mistakes.',
  mistakesTail: ' Review its work, especially before running code.',
  injection: 'Prompt injection can mislead the agent.',
  injectionTail: ' Only use Mercury with code you trust.',
  row: ' ▸ continue',
}

const TERMINAL_WORDS = {
  title: 'Terminal keys',
  appleTweak: 'Option+Enter for newlines and the visual bell need one terminal tweak.',
  tweak: 'Set up Shift+Enter to add a new line in your terminal.',
  install: 'yes, apply the recommended settings',
  later: 'not now; use /terminal-setup later',
}

export const SIGN_IN_WORDS = {
  intro: 'Use a Claude or OpenAI subscription, usage-based billing, or connect OpenRouter, Gemini, Hugging Face, Kimi, GLM or DeepSeek. To add an API key from the terminal, run /router key <provider>.',
}

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

function FittingMascot({ rows, cols }: { rows: number; cols: number }): React.ReactNode {
  const accent = useSessionAccent()
  const def = critterDefForKey(accent.key)
  const miniDef = React.useMemo(
    () => ({ ...def, art: miniArtFor(accent.key) }),
    [def, accent.key],
  )
  if (rows < 29) return null
  if (rows >= 36 && cols >= 100) {
    return <AnimatedCritterArt def={def} hero specimen />
  }
  if (rows >= 32) {
    return <AnimatedCritterArt def={def} specimen />
  }
  return <AnimatedCritterArt def={miniDef} mini specimen />
}

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

  useEffect(() => {
    const row = THEME_ROWS[selectedIndex]
    if (row) setPreviewTheme(row.value)
  }, [selectedIndex, setPreviewTheme])

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
                {THEME_WORDS.bubble}
              </Text>
            </Box>
          </Box>
        </Box>
      </Box>
      <Text color={SECOND}>{THEME_WORDS.tagline}</Text>
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
        <Text color={SECOND}>{THEME_WORDS.fileName}</Text>
        <StructuredDiff patch={FITTING_PATCH} dim={false} filePath={THEME_WORDS.fileName} firstLine={null} width={Math.min(columns - 8, 92)} />
      </Box>
      <Text color={FAINT}>{syntaxLine}</Text>
    </Box>
  )
}

function ProviderStation({
  onSignedIn,
  onSkip,
  onBack,
}: {
  onSignedIn: () => void
  onSkip: () => void
  onBack: () => void
}): React.ReactNode {
  const [epoch, setEpoch] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  return (
    <Box flexDirection="column">
      <ConsoleOAuthFlow
        key={epoch}
        startingMessage={SIGN_IN_WORDS.intro}
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

function Guardrails({ onContinue, onBack }: { onContinue: () => void; onBack: () => void }): React.ReactNode {
  const tokens = useMercuryTokens()
  const mark = useFirstRunCardsCentred() ? tokens.cardBrown : AMBER
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
        {GUARDRAILS_WORDS.title}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text wrap="wrap">
          <Text color={mark}>{`${GLYPH.warn} `}</Text>
          <Text color={IVORY}>{GUARDRAILS_WORDS.mistakes}</Text>
          <Text color={SECOND}>{GUARDRAILS_WORDS.mistakesTail}</Text>
        </Text>
        <Text wrap="wrap">
          <Text color={mark}>{`${GLYPH.warn} `}</Text>
          <Text color={IVORY}>{GUARDRAILS_WORDS.injection}</Text>
          <Text color={SECOND}>{GUARDRAILS_WORDS.injectionTail}</Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        <InteractiveRow {...rowProps(rows[0]!, 0)}>
          <Text>
            <Text color={selectedIndex === 0 ? IVORY : SECOND}>{GUARDRAILS_WORDS.row}</Text>
          </Text>
        </InteractiveRow>
      </Box>
    </Box>
  )
}

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
    { id: 'install', label: TERMINAL_WORDS.install },
    { id: 'no', label: TERMINAL_WORDS.later },
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
            void setupTerminal(theme === 'auto' ? DEFAULT_THEME_SETTING : theme)
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
  const tweak = env.terminal === 'Apple_Terminal' ? TERMINAL_WORDS.appleTweak : TERMINAL_WORDS.tweak
  return (
    <Box flexDirection="column">
      <Text bold color={IVORY}>
        {TERMINAL_WORDS.title}
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
  const totalTags = stepIds.length + 1
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
      firstRunCard
      footer={footer}
      bootNotes={notes}
    >
      {body}
    </MercurySetupFrame>
  )
}
