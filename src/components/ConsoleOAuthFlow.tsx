
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import TextInput from './TextInput.js'
import { Spinner } from './Spinner.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { PopupFormContext, usePopupCompact, usePopupMarker } from '../context/popupFormContext.js'
import { settingsPopupMarker } from '../utils/cockpit/settingsPopup.js'
import { escapeFromOutsidePress } from '../ink/recessLayer.js'
import { LoginAccountCard } from './LoginAccountCard.js'
import { collectLoginsScreenFacts, loginsArmSlots, loginsCatalogue, loginsRowStateOf } from './BootLoginsScreen.js'
import { useSignInEpoch } from '../utils/accounts/useSignInEpoch.js'
import { useCatalogueEpoch } from '../hooks/useCatalogueEpoch.js'
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
import { XaiConnect } from './XaiConnect.js'
import { MetaConnect } from './MetaConnect.js'
import { MistralConnect } from './MistralConnect.js'
import { NousConnect } from './NousConnect.js'
import { ZenConnect } from './ZenConnect.js'
import { KeyCardTitle } from './KeyCardTitle.js'
import { storeOpenaiApiKeyLogin } from '../services/providers/openai/openaiLogin.js'
import { keyPasteGuardNote } from './mercury-ui/screens/keyPasteGuards.js'
import {
  keyPageLine,
  loginFamilyFocusFor,
  loginFamilyRows,
  loginFamilyInitialFocus,
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
  | 'xai'
  | 'meta'
  | 'mistral'
  | 'nous'
  | 'zen'

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
  onAccountChange,
}: {
  onAccountChange?: (receipt: string) => void
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
  const { columns, rows } = useTerminalSize()
  const popup = React.useContext(PopupFormContext)
  const compact = usePopupCompact().compact && popup
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
  const [accountFamily, setAccountFamily] = useState<LoginFamilyValue | null>(null)
  const [menuFocus, setMenuFocus] = useState(0)
  useSignInEpoch()
  useCatalogueEpoch()
  const menuUp = leg === null && accountFamily === null && state.name === 'idle'
  const menuCount = loginFamilyRows({ engineLegs: onOpenaiDone !== undefined }).length + (onSkip !== undefined ? 1 : 0)
  usePopupMarker(compact && menuUp ? settingsPopupMarker(menuFocus + 1, menuCount) : null)
  const [code, setCodeState] = useState('')
  const codeRef = useRef('')
  const setCode = useCallback((next: string): void => {
    codeRef.current = next
    setCodeState(next)
  }, [])
  const [codeCursor, setCodeCursor] = useState(0)

  useInput(
    (_input, key, event) => {
      if (popup && key.escape && escapeFromOutsidePress()) {
        event.stopImmediatePropagation()
        if (state.name === 'success') onDone()
        else onCancel?.()
        return
      }
      if (key.escape && (state.name === 'ready' || state.name === 'waiting' || state.name === 'error')) (onAbandonLeg ?? onCancel)?.()
    },
    {
      isActive:
        (onAbandonLeg !== undefined || onCancel !== undefined) &&
        (popup || state.name === 'ready' || state.name === 'waiting' || state.name === 'error'),
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
      borderStyle={popup ? undefined : 'round'}
      borderColor={tokens.borderSubtle}
      paddingX={popup ? 0 : 1}
      gap={compact ? 0 : 1}
    >
      {compact ? null : <Text bold>{setupToken ? 'Set up a long-lived token' : 'Sign in'}</Text>}
      {children}
    </Box>
  )

  const settleLeg = (result: { ok: boolean; receipt: string }): void => {
    onOpenaiDone?.(result)
  }

  const startFamily = (value: string): void => {
    if (value === SIGN_IN_LATER_ROW.value) { onSkip?.(); return }
    if (value === 'openai' || value === 'moonshot' || value === 'zai' || value === 'deepseek' || value === 'xai' || value === 'meta' || value === 'mistral' || value === 'zen' || value === 'openrouter' || value === 'gemini' || value === 'huggingface' || value === 'nous') {
      setLeg(value)
      return
    }
    model.start(value === 'claudeai')
  }
  if (accountFamily !== null) return frame(
    <LoginAccountCard
      family={accountFamily}
      onBack={() => setAccountFamily(null)}
      onSignIn={() => { setAccountFamily(null); startFamily(accountFamily) }}
      onChanged={receipt => onAccountChange?.(receipt)}
    />,
  )

  if (leg !== null) {
    switch (leg) {
      case 'openai':
        if (onOpenaiDone === undefined) return frame(<Text dimColor>OpenAI login unavailable here.</Text>)
        return frame(
          <Box flexDirection="column" gap={compact ? 0 : 1}>
            <Text wrap="truncate-end">OpenAI — pick the credential to connect.</Text>
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

      case 'meta':
        if (onOpenaiDone === undefined) return frame(<Text dimColor>Meta login unavailable here.</Text>)
        return frame(<MetaConnect onResult={settleLeg} onBack={() => setLeg(null)} />)

      case 'mistral':
        if (onOpenaiDone === undefined) return frame(<Text dimColor>Mistral login unavailable here.</Text>)
        return frame(<MistralConnect onResult={settleLeg} onBack={() => setLeg(null)} />)

      case 'nous':
        if (onOpenaiDone === undefined) return frame(<Text dimColor>Nous Portal login unavailable here.</Text>)
        return frame(<NousConnect onResult={settleLeg} onBack={() => setLeg(null)} />)

      case 'zen':
        if (onOpenaiDone === undefined) return frame(<Text dimColor>OpenCode Zen login unavailable here.</Text>)
        return frame(<ZenConnect onResult={settleLeg} onBack={() => setLeg(null)} />)

      case 'deepseek':
        if (onOpenaiDone === undefined) return frame(<Text dimColor>DeepSeek login unavailable here.</Text>)
        return frame(<DeepseekConnect onResult={settleLeg} onBack={() => setLeg(null)} />)

      case 'xai':
        if (onOpenaiDone === undefined) return frame(<Text dimColor>xAI login unavailable here.</Text>)
        return frame(<XaiConnect onResult={settleLeg} onBack={() => setLeg(null)} />)

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
      const defaultFocus = loginFamilyInitialFocus(idleRows, recordedFocus, initialFocus)
      const facts = popup ? collectLoginsScreenFacts() : null
      const arms = popup ? loginsCatalogue() : []
      return frame(
        <Box flexDirection="column" gap={compact ? 0 : 1}>
          {compact ? null : (
            <Text>
              {startingMessage ??
                'Mercury can run on a Claude or OpenAI subscription, on usage-based billing, or on a connected engine (OpenRouter · Gemini · Hugging Face · Kimi · GLM · DeepSeek · xAI · Meta · Mistral · Nous Portal · OpenCode Zen). An API key also connects from the terminal: /router key <provider>.'}
            </Text>
          )}
          <Select
            hideIndexes
            disableSelection="numeric"
            visibleOptionCount={compact ? Math.max(1, Math.min(rows, idleRows.length)) : idleRows.length}
            defaultFocusValue={defaultFocus}
            layout={popup ? 'compact-vertical' : 'compact'}
            options={idleRows.map(row => {
              const arm = arms.find(candidate => candidate.row.value === row.value)
              const status = facts && arm ? loginsRowStateOf(arm, facts) : null
              if (compact) return status?.signedIn ? { ...row, label: `${row.label} · ${status.chip}` } : row
              return { ...row, ...(status?.signedIn ? { description: status.chip } : {}) }
            })}
            onFocus={value => setMenuFocus(Math.max(0, idleRows.findIndex(row => row.value === value)))}
            onChange={value => {
              const arm = arms.find(candidate => candidate.row.value === value)
              if (facts && arm && loginsArmSlots(arm, facts.groups.find(group => group.family.id === arm.familyId)).length > 0) {
                setAccountFamily(arm.row.value)
                return
              }
              startFamily(value)
            }}
            onCancel={onCancel}
          />
          {compact ? null : <ProviderReadinessBlock />}
        </Box>,
      )
    }

    case 'ready':
      return frame(<Text dimColor>Opening your browser…</Text>)

    case 'waiting': {
      const promptLabel = 'Paste code here if prompted > '
      const inputColumns = Math.max(10, columns - promptLabel.length - 1)
      return frame(
        <Box flexDirection="column" gap={compact ? 0 : 1}>
          {compact ? null : (
            <Text>
              A browser window has been opened — finish signing in there.
              {state.forcedMethod
                ? ` (login method pre-selected: ${state.forcedMethod})`
                : ''}
            </Text>
          )}
          {pastePromptUp ? (
            <Box flexDirection="column" gap={compact ? 0 : 1}>
              {compact ? (
                <Text dimColor wrap="truncate-end">{state.url}</Text>
              ) : (
                <Text dimColor wrap="wrap">
                  Browser did not open? Use this URL:{'\n'}
                  {state.url}
                </Text>
              )}
              {copied ? (
                <Text color={tokens.success}>Copied to clipboard</Text>
              ) : compact ? null : (
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
              {compact ? <Text dimColor>c copies the URL · esc cancels</Text> : null}
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
          <Box flexDirection="column" gap={compact ? 0 : 1}>
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
        <Box flexDirection="column" gap={compact ? 0 : 1}>
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
        <Box flexDirection="column" gap={compact ? 0 : 1}>
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
  const { compact } = usePopupCompact()
  return (
    <Box flexDirection="column" gap={compact ? 0 : 1}>
      {compact ? <KeyCardTitle family="openai">OpenAI key</KeyCardTitle> : <Text>{keyPageLine('openai')}</Text>}
      {compact ? null : <Text>Paste your OpenAI API key. It is stored in the auth-scoped secret store (mode 600), never logged; an OPENAI_API_KEY env var always wins over the store.</Text>}
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
      {compact ? null : <Text dimColor>esc back</Text>}
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
  { id: 'xai', label: 'xAI' },
  { id: 'meta', label: 'Meta' },
  { id: 'mistral', label: 'Mistral' },
  { id: 'zen', label: 'OpenCode Zen' },
  { id: 'local', label: 'Local servers' },
  { id: 'openai-compat', label: 'OpenAI-compatible' },
  { id: 'nous', label: 'Nous Portal' },
]

function ProviderReadinessBlock(): React.ReactNode {
  const tokens = useMercuryTokens()
  useCatalogueEpoch()
  useEffect(() => {
    resolveProviderUsability(undefined, { fetchCatalogues: true })
  }, [])
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
