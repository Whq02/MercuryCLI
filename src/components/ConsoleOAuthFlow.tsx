// The login card: the in-chat SKIN over the ONE Anthropic sign-in machine
// (anthropicLoginModel: idle → platform setup | ready →
// waiting → creating key → success | error → about-to-retry, the console
// arm's mint, the setup-token arm, the retry topology and every flow
// sentence live THERE; this file owns the menus, the paste draft, geometry
// and paint). The engine families' legs stay this card's own dispatch —
// each provider's connect surface settles through onOpenaiDone, the generic
// engine-leg settlement (receipt + authVersion bump; no Anthropic
// credential changes).

import React, {
  useCallback,
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

/** The engine families' leg screens — this card's own dispatch beside the
 *  Anthropic machine (the machine stays idle while a leg is open). */
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

/** The provider rows a caller may pre-focus (/logins <family>) — the row
 *  owner's vocabulary (loginFamilyRows.ts), re-exported for callers. */
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
  /** The cancel channel (esc on the opening menu, or while waiting on the
   *  browser / an error): the flow was ABANDONED and no credential exists.
   *  Cancellation must never ride onDone — a caller records onDone as a
   *  settled sign-in. When absent, esc is left to the host's own
   *  cancellation handling (the /login container owns it from any state). */
  onCancel?: () => void
  /** Engine-leg settlement (OpenAI subscription/key · OpenRouter · Gemini —
   *  receipt-shaped, no Anthropic credential change). When absent every
   *  engine row is hidden — a host that cannot settle the outcome must not
   *  offer the leg. */
  onOpenaiDone?: (result: { ok: boolean; receipt: string }) => void
  startingMessage?: string
  mode?: 'login' | 'setup-token'
  forceLoginMethod?: 'claudeai' | 'console'
  /** Pre-FOCUS a provider row on the opening menu (a caller arriving from a
   *  family-shaped pick — /logins <family>); the operator still confirms
   *  with ↵. Never skips a screen. */
  initialFocus?: LoginFamilyFocus
  /** First-run seam: when present the opening menu appends the owner's
   *  "sign in later" row and settles it here — the host continues with NO
   *  credential. /logins hosts never pass it (inside the cockpit, esc
   *  already closes the card), so the row cannot appear there. */
  onSkip?: () => void
  /** Splits the cancel channel for hosts whose esc means different things
   *  on the opening menu vs inside a pending Anthropic leg (the first-run
   *  walk: back a station vs back to this catalogue). When present, esc on
   *  ready/waiting/error rides THIS channel; the opening menu keeps
   *  onCancel. Absent, both ride onCancel as before. */
  onAbandonLeg?: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns } = useTerminalSize()
  const { addNotification } = useNotifications()
  const setupToken = mode === 'setup-token'

  // THE MACHINE (anthropicLoginModel): both Anthropic arms' states, beats
  // and sentences. This skin hands it the in-chat notification queue — the
  // machine itself never requires one (the Boot face mounts without it).
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
  const [code, setCode] = useState('')
  const [codeCursor, setCodeCursor] = useState(0)

  // Esc on the flow's OWN screens (opening the browser · waiting on it · an
  // error) abandons the flow through the CANCEL channel — unmount cleanup
  // releases the pending OAuth service. Never onDone: no credential was
  // created. A host that distinguishes menu-esc from leg-esc (the first-run
  // walk) supplies onAbandonLeg and these states ride it instead. The idle
  // menu cancels through the Select's own esc, and every provider leg owns
  // its esc entirely (back out of a key screen, cancel a device wait) —
  // this handler stays off those states so it can never preempt them.
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

  // 'c' while the paste prompt is up copies the URL (the machine owns the
  // clipboard write and the ack beat; the draft-empty gate is this skin's —
  // typing a code that contains a c must keep typing).
  useInput(
    (input, key) => {
      if (
        input === 'c' &&
        !key.ctrl && !key.meta &&
        state.name === 'waiting' &&
        pastePromptUp &&
        code === ''
      ) {
        model.copyUrl()
        setCode('')
        setCodeCursor(0)
      }
    },
    { isActive: state.name === 'waiting' && pastePromptUp },
  )

  const submitCode = useCallback(
    (raw: string) => {
      // A parse-refusal lands the machine's error state (retry = the
      // waiting screen) — the draft clears so the retry types fresh.
      if (!model.submitCode(raw)) {
        setCode('')
        setCodeCursor(0)
      }
    },
    [model],
  )

  // ── screens ──────────────────────────────────────────────────────────────
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

  // A settled engine leg forwards its outcome to the host. The sign-in
  // ledger (the computed default orders by it) records at the DRIVERS — the
  // credential-landing sites — so no skin records anything here.
  const settleLeg = (result: { ok: boolean; receipt: string }): void => {
    onOpenaiDone?.(result)
  }

  // The engine families' legs — the card's own dispatch (the machine stays
  // idle beneath an open leg; its screens can never collide with one).
  if (leg !== null) {
    switch (leg) {
      case 'openai':
        // THE FAMILY'S TWO-ARM CHOICE (OS-AUTH-1: the OpenAI key moved home
        // from the console door). The option rows come from THE row owner
        // (loginFamilyRows.openaiArmPickRows) — the face layer renders the
        // same pair by construction.
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
        // The subscription connect surface (browser PKCE + the device-code
        // switch, outcome-settled). The leg is only reachable when the host
        // settles OpenAI outcomes.
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
      // The catalogue rows come from THE row owner (loginFamilyRows.ts) —
      // the /logins card and the first-run walk render the same list by
      // construction. The engine rows ride the settlement gate (a host that
      // cannot settle engine outcomes must not offer them); the walk's
      // "sign in later" row rides the onSkip seam.
      const idleRows = [
        ...loginFamilyRows({ engineLegs: onOpenaiDone !== undefined }),
        ...(onSkip !== undefined ? [SIGN_IN_LATER_ROW] : []),
      ]
      // The most recent sign-in's row (the default provider), only when this
      // host renders it (a host without engine legs hides the engine rows).
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
            // Every row stays on one screen — the count follows the owner's
            // list; a fixed number would hide added rows behind a scroll.
            visibleOptionCount={idleRows.length}
            // A caller's family-shaped pick first; else the operator's
            // recorded default provider's own row (the row owner's map), so
            // a sovereign home's card opens on its lane, not on whichever
            // vendor sits first; else the list's first row.
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
              // The console row is purely Anthropic (OS-AUTH-1's split):
              // both roads mint through the machine's console arm.
              model.start(value === 'claudeai')
            }}
            // Esc on the opening menu is a CANCEL, never a done: routing it
            // to onDone recorded "Login successful" with no credential
            // (the esc-cancels-login-as-success). With no onCancel
            // prop the host's own esc handling owns cancellation.
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
      // The console arm's mint runs behind this screen (the machine's
      // settle).
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
  // Browser PKCE first; 'd' remounts in device-code mode (the headless path
  // lives HERE since the /router arm retired — no capability lost).
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
    // The one guard spelling (keyPasteGuards) — the redirect sentence rides
    // the stores clause verbatim.
    const guard = keyPasteGuardNote(value, {
      stores: 'an OpenAI key. Anthropic usage-based billing signs in through the Console row instead',
    })
    if (guard !== null) {
      setNote(guard)
      return
    }
    setStoring(true)
    // The leg's logic lives in openaiLogin (one driver, shared with the
    // Boot face's logins layer); the receipt proves the live catalogue.
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
  // A credential exists on this screen: esc settles DONE exactly like ↵ —
  // a successful sign-in must never report "interrupted".
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

/** Display order + names for the readiness block: every routed family,
 *  the two no-login lanes (local · compat) included — they flip ready by
 *  discovery/config, and the row says so instead of hiding them. */
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

/**
 * The ten-family readiness column under the sign-in menu: ONE resolver
 * (resolveProviderUsability) feeds every row, and a not-ready family
 * renders its typed blocker VERBATIM — never a generic "unavailable".
 * Reads are sync over owning stores/caches (no network on paint).
 */
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
        // Two layout columns, not one padded string: a status longer than
        // the pane (Kimi's, Local servers') wraps inside its own column —
        // a flush-left continuation under the label column reads broken.
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
