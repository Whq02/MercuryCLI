import * as React from 'react'
import { useRef, useState } from 'react'
import { Box, Text, useInput } from '../../../screen/themedRenderer.js'
import TextInput from '../../../screen/composer/text-input/TextInput.js'
import { Select } from '../../../screen/select/index.js'
import { setClipboard } from '../../../screen/renderer/termio/osc.js'
import { errorMessageWithCause } from '../../../platform/errors/errors.js'
import { openBrowser } from '../../../platform/host-os/browser.js'
import { useTerminalSize } from '../../../screen/fullscreen-layout/useTerminalSize.js'
import { LAYOUT_BREAKPOINTS } from '../../../screen/fullscreen-layout/useLayoutTier.js'
import { useLoad } from '../../../screen/effects/effects.js'
import { useMercuryTokens } from '../../../screen/widgets/useMercuryTokens.js'
import {
  beginGeminiBrowserConnect,
  beginGeminiPlanBrowserConnect,
  geminiOauthClientConfig,
  writeGeminiOauthClientConfig,
  type GeminiConnectHandles,
} from '../../roads/gemini/geminiAccounts.js'
import {
  GEMINI_CONNECT_CANCELLED_RECEIPT,
  GEMINI_CONNECT_STOPPED_RECEIPT,
  activateGeminiSource,
  finishGeminiOauthConnect,
  finishGeminiPlanConnect,
  geminiConnectFailedReceipt,
  storeGeminiApiKeyLogin,
} from '../../roads/gemini/geminiLogin.js'
import { keyPasteGuardNote } from '../../../screen/widgets/faces/keyPasteGuards.js'
import {
  GEMINI_API_KEY_PAGE,
  GEMINI_CONNECT_INTRO,
  GEMINI_CONNECT_COMPACT_INTRO,
  GEMINI_CONNECT_TITLE,
  GEMINI_KEY_BILLING_NOTE,
  geminiConnectRowAction,
  geminiConnectRows,
  geminiGuideHint,
  geminiGuideOpeningStep,
  geminiGuidePaneLines,
  geminiGuideReturnStep,
  geminiGuideStep,
  geminiKeyLegLines,
  geminiPlanLegLines,
  liveGeminiConnectFacts,
  type GeminiConnectFacts,
  type GeminiGuideLine,
  type GeminiGuideOpenState,
  type GeminiGuideStepNumber,
} from '../gemini-connect/geminiConnectGuide.js'
import { KeyCardTitle } from './KeyCardTitle.js'
import { usePopupCompact } from '../../../screen/overlays/popupFormContext.js'
import { geminiClientSteps } from '../gemini-connect/clientSteps.js'
import { startTimeout } from '../../../platform/async/timers.js'

function GuideLines({ lines }: { lines: GeminiGuideLine[] }): React.ReactNode {
  const tokens = useMercuryTokens()
  return (
    <>
      {lines.map((line, index) => {
        switch (line.tone) {
          case 'title':
            return (
              <Text key={index} bold color={tokens.accent}>
                {line.text}
              </Text>
            )
          case 'current':
            return (
              <Text key={index} bold>
                {line.text}
              </Text>
            )
          case 'done':
            return (
              <Text key={index} color={tokens.success}>
                {line.text}
              </Text>
            )
          case 'todo':
            return (
              <Text key={index} color={tokens.textMuted}>
                {line.text}
              </Text>
            )
          case 'detail':
            return (
              <Text key={index} color={tokens.textSecondary} wrap="wrap">
                {line.text}
              </Text>
            )
          case 'address':
            return (
              <Text key={index} color={tokens.info} wrap="wrap">
                {line.text}
              </Text>
            )
          case 'note':
            return (
              <Text key={index} color={tokens.warning} wrap="wrap">
                {line.text}
              </Text>
            )
          case 'status':
            return (
              <Text key={index} color={tokens.textMuted}>
                {line.text}
              </Text>
            )
          default:
            return (
              <Text key={index} dimColor>
                {line.text}
              </Text>
            )
        }
      })}
    </>
  )
}

export function GeminiConnect({
  onResult,
}: {
  onResult: (result: { ok: boolean; receipt: string }) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const size = useTerminalSize()
  const compact = size.columns < LAYOUT_BREAKPOINTS.cockpitMin || size.rows < LAYOUT_BREAKPOINTS.cockpitMinRows
  const popupCompact = usePopupCompact().compact
  const [leg, setLeg] = useState<'choice' | 'key' | 'guide' | 'plan'>('choice')
  const [facts, setFacts] = useState<GeminiConnectFacts>(() => liveGeminiConnectFacts())
  const [step, setStep] = useState<GeminiGuideStepNumber>(1)
  const [opened, setOpened] = useState<GeminiGuideOpenState | undefined>(undefined)
  const [note, setNote] = useState<string | undefined>(undefined)
  const [field, setField] = useState<'id' | 'secret'>('id')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [clientCursor, setClientCursor] = useState(0)
  const [paste, setPasteState] = useState('')
  const pasteRef = useRef('')
  const setPaste = (next: string): void => {
    pasteRef.current = next
    setPasteState(next)
  }
  const [cursorOffset, setCursorOffset] = useState(0)
  const [phase, setPhase] = useState<'starting' | 'waiting' | 'exchanging'>('starting')
  const [listenerNote, setListenerNote] = useState<string | undefined>(undefined)
  const [authorizeUrl, setAuthorizeUrl] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const handlesRef = useRef<GeminiConnectHandles | undefined>(undefined)
  const settledRef = useRef(false)
  const openRunRef = useRef(0)
  const stepFiveBackRef = useRef<'step4' | 'choice'>('step4')

  const settle = (receipt: string, ok = false): void => {
    if (settledRef.current) return
    settledRef.current = true
    setClientSecret('')
    setPaste('')
    onResult({ ok, receipt })
  }

  const backToChoice = (): void => {
    openRunRef.current += 1
    setClientSecret('')
    setPaste('')
    setFacts(liveGeminiConnectFacts())
    setNote(undefined)
    setLeg('choice')
  }

  const enterStep = (next: GeminiGuideStepNumber, withNote?: string): void => {
    openRunRef.current += 1
    setClientSecret('')
    setPaste('')
    setNote(withNote)
    setOpened(undefined)
    if (next === 5) {
      const stored = geminiOauthClientConfig()?.clientId ?? ''
      setClientId(stored)
      setClientCursor(stored.length)
      setField('id')
    }
    if (next === 6) {
      setPhase('starting')
      setAuthorizeUrl(undefined)
      setListenerNote(undefined)
      setCursorOffset(0)
    }
    setStep(next)
    setLeg('guide')
  }

  const openStepPage = (target: GeminiGuideStepNumber): void => {
    const page = geminiGuideStep(target).page
    if (!page) return
    const run = (openRunRef.current += 1)
    setOpened('opening')
    void openBrowser(page.address).then(ok => {
      if (run === openRunRef.current && !settledRef.current) setOpened(ok ? 'opened' : 'failed')
    })
  }

  useLoad(signal => {
    if (leg !== 'guide' && leg !== 'plan') return
    if (leg === 'guide' && step <= 4) {
      openStepPage(step)
      return
    }
    if (leg === 'guide' && step !== 6) return
    const plan = leg === 'plan'
    const handles = plan
      ? beginGeminiPlanBrowserConnect({ onListenerIssue: message => setListenerNote(message) })
      : beginGeminiBrowserConnect({ onListenerIssue: message => setListenerNote(message) })
    handlesRef.current = handles
    setAuthorizeUrl(handles.authorizeUrl || undefined)
    setPhase('waiting')
    handles.result
      .then(async () => {
        if (signal.aborted || settledRef.current) return
        const outcome = plan ? await finishGeminiPlanConnect() : await finishGeminiOauthConnect()
        if (!signal.aborted) settle(outcome.receipt, outcome.ok)
      })
      .catch(error => {
        if (signal.aborted || settledRef.current) return
        const failure = errorMessageWithCause(error)
        const back = plan ? undefined : geminiGuideReturnStep(failure)
        if (back === undefined) {
          settle(geminiConnectFailedReceipt(error))
          return
        }
        enterStep(back, failure)
      })
    return () => {
      handlesRef.current = undefined
      handles.cancel('cancelled from the connect surface')
    }
  }, [leg, step])

  useInput((input, key, event) => {
    if ((leg !== 'guide' && leg !== 'plan') || (leg === 'guide' && step === 5)) return
    if (key.escape) {
      if (step === 6 || leg === 'plan') {
        handlesRef.current?.cancel('cancelled from the connect surface')
        settle(GEMINI_CONNECT_STOPPED_RECEIPT)
        return
      }
      if (step === 1) {
        backToChoice()
        return
      }
      enterStep((step - 1) as GeminiGuideStepNumber)
      return
    }
    if (leg === 'guide' && step <= 4) {
      if (key.return) {
        if (step === 4) stepFiveBackRef.current = 'step4'
        enterStep((step + 1) as GeminiGuideStepNumber)
        return
      }
      if (input === 'o' && !key.ctrl && !key.meta) openStepPage(step)
      return
    }
    if (input === 'c' && !key.ctrl && !key.meta && pasteRef.current === '' && phase !== 'exchanging' && authorizeUrl) {
      event.stopImmediatePropagation()
      void setClipboard(authorizeUrl).then(sequence => {
        if (sequence) process.stdout.write(sequence)
        setCopied(true)
        startTimeout(() => setCopied(false), 2000)
      })
    }
  })

  const submitPaste = (raw: string): void => {
    const value = raw.trim()
    if (!value) return
    setPaste('')
    setCursorOffset(0)
    setPhase('exchanging')
    handlesRef.current?.completeWithRedirect(value)
  }

  const submitClientId = (raw: string): void => {
    const value = raw.trim()
    if (!value) {
      setNote('The client id is required (the secret is optional for Desktop clients).')
      return
    }
    setClientId(value)
    setClientCursor(0)
    setField('secret')
    setNote(undefined)
  }

  const submitClientSecret = (raw: string): void => {
    try {
      writeGeminiOauthClientConfig({
        clientId,
        ...(raw.trim() ? { clientSecret: raw.trim() } : {}),
      })
    } catch (error) {
      setNote(`Could not store the client config: ${String((error as Error).message ?? error)}`)
      return
    }
    setFacts(liveGeminiConnectFacts())
    enterStep(6)
  }

  if (leg === 'choice') {
    return (
      <Box flexDirection="column" paddingX={popupCompact ? 0 : 1} gap={popupCompact ? 0 : 1}>
        <Text bold color={tokens.accent} wrap="truncate-end">
          {GEMINI_CONNECT_TITLE}
        </Text>
        <Text color={tokens.textSecondary} wrap={popupCompact ? 'truncate-end' : 'wrap'}>
          {popupCompact ? GEMINI_CONNECT_COMPACT_INTRO : GEMINI_CONNECT_INTRO}
        </Text>
        <Select
          options={geminiConnectRows(facts)}
          onChange={value => {
            if (value !== 'client' && geminiConnectRowAction(facts, value) === 'activate') {
              const outcome = activateGeminiSource(value === 'key' ? 'api-key' : value === 'plan' ? 'plan' : 'oauth')
              settle(outcome.receipt, outcome.ok)
              return
            }
            if (value === 'plan') {
              setPhase('starting')
              setAuthorizeUrl(undefined)
              setListenerNote(undefined)
              setPaste('')
              setCursorOffset(0)
              setLeg('plan')
              return
            }
            if (value === 'key') {
              setLeg('key')
              return
            }
            if (value === 'client') {
              stepFiveBackRef.current = 'choice'
              enterStep(5)
              return
            }
            stepFiveBackRef.current = 'step4'
            enterStep(geminiGuideOpeningStep(facts))
          }}
          onCancel={() => settle(GEMINI_CONNECT_CANCELLED_RECEIPT)}
        />
      </Box>
    )
  }

  if (leg === 'key') {
    return <GeminiKeyLeg onResult={settle} onBack={backToChoice} />
  }

  if (leg === 'plan') {
    return (
      <Box flexDirection="column" paddingX={popupCompact ? 0 : 1}>
        {popupCompact ? null : <GuideLines lines={geminiPlanLegLines(phase === 'waiting' ? 'opened' : undefined)} />}
        {phase === 'exchanging' ? <Text color={tokens.textSecondary}>Exchanging the authorization code and reading your plan…</Text> : null}
        {listenerNote ? <Text color={tokens.warning}>{listenerNote}</Text> : null}
        {authorizeUrl && phase !== 'exchanging' ? (
          <>
            {popupCompact ? null : <Text color={tokens.textMuted}>If nothing opened, visit:</Text>}
            <Text color={tokens.info} wrap={popupCompact ? 'truncate-end' : 'wrap'}>
              {authorizeUrl}
            </Text>
            <Box>
              <Text color={tokens.textMuted}>or paste the redirected URL: </Text>
              <TextInput
                value={paste}
                onChange={setPaste}
                onSubmit={submitPaste}
                mask="*"
                cursorOffset={cursorOffset}
                onChangeCursorOffset={setCursorOffset}
                columns={48}
                onEscape={() => {
                  handlesRef.current?.cancel('cancelled from the connect surface')
                  settle(GEMINI_CONNECT_CANCELLED_RECEIPT)
                }}
              />
            </Box>
          </>
        ) : null}
        {copied ? <Text color={tokens.success}>Copied to clipboard</Text> : null}
        <Text dimColor>{geminiGuideHint(6)}</Text>
      </Box>
    )
  }

  if (step <= 4) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <GuideLines lines={geminiGuidePaneLines({ step, ...(opened ? { opened } : {}), ...(note ? { note } : {}), compact })} />
        <Text dimColor>{geminiGuideHint(step)}</Text>
      </Box>
    )
  }

  return geminiClientSteps({ GuideLines, step, tokens, compact, popupCompact, field, setField, clientId, setClientId, submitClientId, clientCursor, setClientCursor, stepFiveBackRef, backToChoice, enterStep, clientSecret, setClientSecret, submitClientSecret, note, setNote, phase, listenerNote, authorizeUrl, paste, setPaste, submitPaste, cursorOffset, setCursorOffset, handlesRef, settle, copied })
}

function GeminiKeyLeg({
  onResult,
  onBack,
}: {
  onResult: (receipt: string, ok?: boolean) => void
  onBack: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { compact } = usePopupCompact()
  const [opened, setOpened] = useState<GeminiGuideOpenState>('opening')
  const [key, setKey] = useState('')
  const [cursor, setCursor] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [storing, setStoring] = useState(false)
  const storingRef = useRef(false)
  useLoad(signal => {
    void openBrowser(GEMINI_API_KEY_PAGE.address).then(ok => {
      if (!signal.aborted) setOpened(ok ? 'opened' : 'failed')
    })
  }, [])
  const submit = (raw: string): void => {
    if (storingRef.current) return
    const value = raw.trim()
    if (!value) return
    const guard = keyPasteGuardNote(value, { stores: 'a Google Gemini key (AIza…)' })
    if (guard !== null) {
      setNote(guard)
      return
    }
    storingRef.current = true
    setStoring(true)
    void storeGeminiApiKeyLogin(value).then(outcome => {
      storingRef.current = false
      if (!outcome.stored) {
        setStoring(false)
        setNote(outcome.receipt)
        return
      }
      setKey('')
      onResult(outcome.receipt, outcome.ok)
    }).catch(error => {
      storingRef.current = false
      setStoring(false)
      setNote(errorMessageWithCause(error))
    })
  }
  return (
    <Box flexDirection="column" gap={compact ? 0 : 1} paddingX={compact ? 0 : 1}>
      <Box flexDirection="column">
        {compact ? <KeyCardTitle family="gemini">Gemini key</KeyCardTitle> : <GuideLines lines={geminiKeyLegLines(opened)} />}
      </Box>
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
          onEscape={onBack}
        />
      </Box>
      {compact ? <Text color={tokens.textSecondary} wrap="truncate-end">{GEMINI_KEY_BILLING_NOTE}</Text> : null}
      {storing ? <Text dimColor>Storing and checking the live catalogue…</Text> : null}
      {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
      {compact ? null : <Text dimColor>esc back</Text>}
    </Box>
  )
}
