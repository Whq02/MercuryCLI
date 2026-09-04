
import React, {
  useCallback,
  useRef,
  useState,
} from 'react'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import TextInput from './TextInput.js'
import { Spinner } from './Spinner.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { mostRecentSignInFamily } from '../utils/model/computedDefault.js'
import { useNotifications } from '../context/notifications.js'
import { useInput } from '../ink.js'
import {
  useAnthropicLoginModel,
} from './mercury-ui/screens/anthropicLoginModel.js'
import {
  resolveProviderUsability,
  type ProviderId,
} from '../services/providers/providerUsability.js'
import { RouterOpenaiConnect } from './RouterOpenaiConnect.js'
import { RouterOpenrouterConnect } from './RouterOpenrouterConnect.js'
import { GeminiConnect } from './GeminiConnect.js'
import { HuggingfaceConnect } from './HuggingfaceConnect.js'
import { KimiConnect } from './KimiConnect.js'
import { ZaiConnect } from './ZaiConnect.js'
import { DeepseekConnect } from './DeepseekConnect.js'
import { storeOpenaiApiKeyLogin } from '../services/providers/openai/openaiLogin.js'
import { keyPasteGuardNote } from './mercury-ui/screens/keyPasteGuards.js'
import {
  loginFamilyFocusFor,
  loginFamilyRows,
  openaiArmPickRows,
  SIGN_IN_LATER_ROW,
  type LoginFamilyValue,
} from './loginFamilyRows.js'

type EngineLeg =
  | 'openai'
  | 'openai-subscription'
  | 'openai-key'
  | 'openrouter'
  | 'gemini'
  | 'huggingface'
  | 'moonshot'
  | 'zai'
  | 'deepseek'

export type LoginFamilyFocus = LoginFamilyValue

export function ConsoleOAuthFlow({
  onDone,
  onCancel,
  onOpenaiDone,
  startingMessage,
  mode = 'login',
  forceLoginMethod,
  initialFocus,
  onSkip,
  onAbandonLeg,
}: {
  onDone: () => void
  onCancel?: () => void
  onOpenaiDone?: (result: { ok: boolean; receipt: string }) => void
  startingMessage?: string
  mode?: 'login' | 'setup-token'
  forceLoginMethod?: 'claudeai' | 'console'
  initialFocus?: LoginFamilyFocus
  onSkip?: () => void
  onAbandonLeg?: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns } = useTerminalSize()
  const { addNotification } = useNotifications()
  const setupToken = mode === 'setup-token'

  const model = useAnthropicLoginModel(
    {
      onDone,
      ...(mode !== undefined ? { mode } : {}),
      ...(forceLoginMethod !== undefined ? { forceLoginMethod } : {}),
    },
    { notify: notice => addNotification(notice) },
  )
  const state = model.flow
  const pastePromptUp = model.pastePromptUp
  const copied = model.copied
  const shadowWarning = model.shadowWarning
  const accountLabel = model.accountLabel

  const [leg, setLeg] = useState<EngineLeg | null>(null)
  const [code, setCodeState] = useState('')
  const codeRef = useRef('')
  const setCode = useCallback((next: string): void => {
    codeRef.current = next
    setCodeState(next)
  }, [])
  const [codeCursor, setCodeCursor] = useState(0)

  useInput(
    (_input, key) => {
      if (key.escape) (onAbandonLeg ?? onCancel)?.()
    },
    {
      isActive:
        (onAbandonLeg !== undefined || onCancel !== undefined) &&
        (state.name === 'ready' || state.name === 'waiting' || state.name === 'error'),
    },
  )

  useInput(
    (input, key, event) => {
      if (
        input === 'c' &&
        !key.ctrl && !key.meta &&
        state.name === 'waiting' &&
        pastePromptUp &&
        codeRef.current === ''
      ) {
        event.stopImmediatePropagation()
        model.copyUrl()
      }
    },
    { isActive: state.name === 'waiting' && pastePromptUp },
  )

  const submitCode = useCallback(
    (raw: string) => {
      if (!model.submitCode(raw)) {
        setCode('')
        setCodeCursor(0)
      }
    },
    [model],
  )

  const frame = (children: React.ReactNode): React.ReactNode => (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tokens.borderSubtle}
      paddingX={1}
      gap={1}
    >
      <Text bold>{setupToken ? 'Set up a long-lived token' : 'Sign in'}</Text>
      {children}
    </Box>
  )

  const settleLeg = (result: { ok: boolean; receipt: string }): void => {
    onOpenaiDone?.(result)
  }

  if (leg !== null) {
    switch (leg) {
      case 'openai':
        if (onOpenaiDone === undefined) return frame(<Text dimColor>OpenAI login unavailable here.</Text>)
        return frame(
          <Box flexDirection="column" gap={1}>
            <Text>OpenAI — pick the credential to connect.</Text>
            <Select
              options={[...openaiArmPickRows]}
              onChange={value => setLeg(value === 'key' ? 'openai-key' : 'openai-subscription')}
              onCancel={() => setLeg(null)}
            />
          </Box>,
        )

      case 'openai-subscription':
        if (onOpenaiDone === undefined) return frame(<Text dimColor>OpenAI login unavailable here.</Text>)
        return frame(<OpenaiSubscriptionLeg onOpenaiDone={settleLeg} />)

      case 'openrouter':
        if (onOpenaiDone === undefined)
          return frame(<Text dimColor>OpenRouter login unavailable here.</Text>)
        return frame(<RouterOpenrouterConnect onResult={settleLeg} />)

      case 'gemini':
        if (onOpenaiDone === undefined)
          return frame(<Text dimColor>Gemini login unavailable here.</Text>)
        return frame(<GeminiConnect onResult={settleLeg} />)

      case 'huggingface':
        if (onOpenaiDone === undefined)
          return frame(<Text dimColor>Hugging Face login unavailable here.</Text>)
        return frame(<HuggingfaceConnect onResult={settleLeg} />)

      case 'moonshot':
        if (onOpenaiDone === undefined) return frame(<Text dimColor>Kimi login unavailable here.</Text>)
        return frame(<KimiConnect onResult={settleLeg} />)

      case 'zai':
        if (onOpenaiDone === undefined) return frame(<Text dimColor>GLM (Z.AI) login unavailable here.</Text>)
        return frame(<ZaiConnect onResult={settleLeg} />)

      case 'deepseek':
        if (onOpenaiDone === undefined) return frame(<Text dimColor>DeepSeek login unavailable here.</Text>)
        return frame(<DeepseekConnect onResult={settleLeg} onBack={() => setLeg(null)} />)

      case 'openai-key':
        if (onOpenaiDone === undefined) return frame(<Text dimColor>OpenAI login unavailable here.</Text>)
        return frame(<OpenaiKeyLeg onOpenaiDone={settleLeg} onBack={() => setLeg('openai')} />)
    }
  }

  switch (state.name) {
    case 'idle': {
      const idleRows = [
        ...loginFamilyRows({ engineLegs: onOpenaiDone !== undefined }),
        ...(onSkip !== undefined ? [SIGN_IN_LATER_ROW] : []),
      ]
      const recordedFocus = loginFamilyFocusFor(mostRecentSignInFamily())
      const defaultFocus =
        initialFocus ?? (idleRows.some(row => row.value === recordedFocus) ? recordedFocus : undefined)
      return frame(
        <Box flexDirection="column" gap={1}>
          <Text>
            {startingMessage ??
              'Mercury can run on a Claude or OpenAI subscription, on usage-based billing, or on a connected engine (OpenRouter · Gemini · Hugging Face · Kimi · GLM · DeepSeek). An API key also connects from the terminal: /router key <provider>.'}
          </Text>
          <Select
            visibleOptionCount={idleRows.length}
            defaultFocusValue={defaultFocus}
            options={idleRows}
            onChange={value => {
              if (value === SIGN_IN_LATER_ROW.value) {
                onSkip?.()
                return
              }
              if (value === 'openai') {
                setLeg('openai')
                return
              }
              if (value === 'moonshot' || value === 'zai' || value === 'deepseek') {
                setLeg(value)
                return
              }
              if (value === 'openrouter') {
                setLeg('openrouter')
                return
              }
              if (value === 'gemini') {
                setLeg('gemini')
                return
              }
              if (value === 'huggingface') {
                setLeg('huggingface')
                return
              }
              model.start(value === 'claudeai')
            }}
            onCancel={onCancel}
          />
          <ProviderReadinessBlock />
        </Box>,
      )
    }

    case 'ready':
      return frame(<Text dimColor>Opening your browser…</Text>)

    case 'waiting': {
      const promptLabel = 'Paste code here if prompted > '
      const inputColumns = Math.max(10, columns - promptLabel.length - 1)
      return frame(
        <Box flexDirection="column" gap={1}>
          <Text>
            A browser window has been opened — finish signing in there.
            {state.forcedMethod
              ? ` (login method pre-selected: ${state.forcedMethod})`
              : ''}
          </Text>
          {pastePromptUp ? (
            <Box flexDirection="column" gap={1}>
              <Text dimColor wrap="wrap">
                Browser did not open? Use this URL:{'\n'}
                {state.url}
              </Text>
              {copied ? (
                <Text color={tokens.success}>Copied to clipboard</Text>
              ) : (
                <Text dimColor>press c to copy the URL</Text>
              )}
              <Box>
                <Text>{promptLabel}</Text>
                <TextInput
                  value={code}
                  onChange={setCode}
                  onSubmit={submitCode}
                  mask="*"
                  columns={inputColumns}
                  cursorOffset={codeCursor}
                  onChangeCursorOffset={setCodeCursor}
                />
              </Box>
            </Box>
          ) : null}
        </Box>,
      )
    }

    case 'creating-key':
      return frame(
        <Box>
          <Spinner />
          <Text> Minting the key…</Text>
        </Box>,
      )

    case 'success':
      if (setupToken && state.token !== undefined) {
        return frame(
          <Box flexDirection="column" gap={1}>
            <Text color={tokens.success}>Token created. It is valid for one year.</Text>
            <Text bold>{state.token}</Text>
            <Text color={tokens.warning}>
              It will not be shown again — store it now.
            </Text>
            <Text dimColor>
              Export it as MERCURY_OAUTH_TOKEN to use it.
            </Text>
          </Box>,
        )
      }
      return frame(
        <Box flexDirection="column" gap={1}>
          <SuccessEnterConfirms onDone={onDone} />
          <Text color={tokens.success}>
            Signed in{accountLabel !== null ? ` as ${accountLabel}` : ''}.
          </Text>
          {state.warning !== undefined ? (
            <Text color={tokens.warning}>{state.warning}</Text>
          ) : null}
          {shadowWarning !== null ? (
            <Text color={tokens.warning}>{shadowWarning}</Text>
          ) : null}
          <Text dimColor>press Enter to continue</Text>
        </Box>,
      )

    case 'error':
      return frame(
        <Box flexDirection="column" gap={1}>
          <ErrorEnterRetries
            hasRetry={state.retry !== undefined}
            onRetry={() => {
              setCode('')
              setCodeCursor(0)
              model.retry()
            }}
          />
          <Text color={tokens.failureText}>{state.message}</Text>
          {state.retry !== undefined ? (
            <Text dimColor>press Enter to retry</Text>
          ) : null}
        </Box>,
      )

    case 'about-to-retry':
      return frame(<Text dimColor>Retrying…</Text>)
  }
}

function OpenaiSubscriptionLeg({
  onOpenaiDone,
}: {
  onOpenaiDone: (result: { ok: boolean; receipt: string }) => void
}): React.ReactNode {
  const [mode, setMode] = useState<'browser' | 'device'>('browser')
  return (
    <RouterOpenaiConnect
      key={mode}
      mode={mode}
      onDone={() => {}}
      onResult={onOpenaiDone}
      {...(mode === 'browser' ? { onSwitchToDevice: () => setMode('device') } : {})}
    />
  )
}

function OpenaiKeyLeg({
  onOpenaiDone,
  onBack,
}: {
  onOpenaiDone: (result: { ok: boolean; receipt: string }) => void
  onBack: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [key, setKey] = useState('')
  const [cursor, setCursor] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [storing, setStoring] = useState(false)
  useInput((_input, k) => {
    if (k.escape && !storing) onBack()
  })
  const submit = (raw: string): void => {
    const value = raw.trim()
    if (!value) return
    const guard = keyPasteGuardNote(value, {
      stores: 'an OpenAI key. Anthropic usage-based billing signs in through the Console row instead',
    })
    if (guard !== null) {
      setNote(guard)
      return
    }
    setStoring(true)
    void storeOpenaiApiKeyLogin(value).then(outcome => {
      if (!outcome.stored) {
        setStoring(false)
        setNote(outcome.receipt)
        return
      }
      onOpenaiDone({ ok: outcome.ok, receipt: outcome.receipt })
    })
  }
  return (
    <Box flexDirection="column" gap={1}>
      <Text>Paste your OpenAI API key. It is stored in the auth-scoped secret store (mode 600), never logged; an OPENAI_API_KEY env var always wins over the store.</Text>
      <Box>
        <Text>Key: </Text>
        <TextInput
          value={key}
          onChange={setKey}
          onSubmit={submit}
          mask="*"
          columns={48}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
        />
      </Box>
      {storing ? <Text dimColor>Storing and checking the live catalogue…</Text> : null}
      {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
      <Text dimColor>esc back</Text>
    </Box>
  )
}

function SuccessEnterConfirms({ onDone }: { onDone: () => void }): React.ReactNode {
  useInput((input, key) => {
    if (key.return || key.escape) onDone()
  })
  return null
}

function ErrorEnterRetries({
  hasRetry,
  onRetry,
}: {
  hasRetry: boolean
  onRetry: () => void
}): React.ReactNode {
  useInput((input, key) => {
    if (key.return && hasRetry) onRetry()
  })
  return null
}

const READINESS_ROWS: ReadonlyArray<{ id: ProviderId; label: string }> = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'huggingface', label: 'Hugging Face' },
  { id: 'moonshot', label: 'Kimi (Moonshot)' },
  { id: 'zai', label: 'GLM (Z.AI)' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'local', label: 'Local servers' },
  { id: 'openai-compat', label: 'OpenAI-compatible' },
]

function ProviderReadinessBlock(): React.ReactNode {
  const tokens = useMercuryTokens()
  const map = resolveProviderUsability()
  return (
    <Box flexDirection="column">
      <Text dimColor bold>
        Provider readiness
      </Text>
      {READINESS_ROWS.map(({ id, label }) => {
        const lane = map[id]
        const status = lane.usable
          ? `ready · ${lane.credential}${lane.limit === 'rejected' ? ' · window reached' : ''}`
          : (lane.blockers[0] ?? 'not ready')
        return (
          <Box key={id}>
            <Box width={21} flexShrink={0}>
              <Text dimColor>
                {'  '}
                {label}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text color={lane.usable ? tokens.success : undefined} dimColor={!lane.usable}>
                {status}
              </Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

export default ConsoleOAuthFlow
