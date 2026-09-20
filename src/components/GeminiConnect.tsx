import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import TextInput from './TextInput.js'
import { Select } from './CustomSelect/index.js'
import { setClipboard } from '../ink/termio/osc.js'
import { errorMessageWithCause } from '../utils/errors.js'
import { openBrowser } from '../utils/browser.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { LAYOUT_BREAKPOINTS } from '../hooks/useLayoutTier.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import {
  beginGeminiBrowserConnect,
  geminiOauthClientConfig,
  GEMINI_CLIENT_STORED_UNVERIFIED_NOTE,
  writeGeminiOauthClientConfig,
  type GeminiConnectHandles,
} from '../services/providers/gemini/geminiAccounts.js'
import {
  GEMINI_CONNECT_CANCELLED_RECEIPT,
  GEMINI_CONNECT_STOPPED_RECEIPT,
  finishGeminiOauthConnect,
  geminiConnectFailedReceipt,
  storeGeminiApiKeyLogin,
} from '../services/providers/gemini/geminiLogin.js'
import { keyPasteGuardNote } from './mercury-ui/screens/keyPasteGuards.js'
import {
  GEMINI_API_KEY_PAGE,
  GEMINI_CONNECT_INTRO,
  GEMINI_CONNECT_TITLE,
  geminiConnectRows,
  geminiGuideHint,
  geminiGuideOpeningStep,
  geminiGuidePaneLines,
  geminiGuideReturnStep,
  geminiGuideStep,
  geminiKeyLegLines,
  liveGeminiConnectFacts,
  type GeminiConnectFacts,
  type GeminiGuideLine,
  type GeminiGuideOpenState,
  type GeminiGuideStepNumber,
} from './geminiConnectGuide.js'

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
  const [leg, setLeg] = useState<'choice' | 'key' | 'guide'>('choice')
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
    onResult({ ok, receipt })
  }

  const backToChoice = (): void => {
    setFacts(liveGeminiConnectFacts())
    setNote(undefined)
    setLeg('choice')
  }

  const enterStep = (next: GeminiGuideStepNumber, withNote?: string): void => {
    setNote(withNote)
    setOpened(undefined)
    if (next === 5) {
      const stored = geminiOauthClientConfig()?.clientId ?? ''
      setClientId(stored)
      setClientSecret('')
      setClientCursor(stored.length)
      setField('id')
    }
    if (next === 6) {
      setPhase('starting')
      setAuthorizeUrl(undefined)
      setListenerNote(undefined)
      setPaste('')
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

  useEffect(() => {
    if (leg !== 'guide') return
    if (step <= 4) {
      openStepPage(step)
      return
    }
    if (step !== 6) return
    const handles = beginGeminiBrowserConnect({
      onListenerIssue: message => setListenerNote(message),
    })
    handlesRef.current = handles
    setAuthorizeUrl(handles.authorizeUrl || undefined)
    setPhase('waiting')
    handles.result
      .then(async () => {
        const outcome = await finishGeminiOauthConnect()
        settle(outcome.receipt, outcome.ok)
      })
      .catch(error => {
        if (settledRef.current) return
        const failure = errorMessageWithCause(error)
        const back = geminiGuideReturnStep(failure)
        if (back === undefined) {
          settle(geminiConnectFailedReceipt(error))
          return
        }
        enterStep(back, failure)
      })
    return () => {
      handlesRef.current = undefined
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leg, step])

  useInput((input, key, event) => {
    if (leg !== 'guide' || step === 5) return
    if (key.escape) {
      if (step === 6) {
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
    if (step <= 4) {
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
        setTimeout(() => setCopied(false), 2000)
      })
    }
  })

  const submitPaste = (raw: string): void => {
    const value = raw.trim()
    if (!value) return
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
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Text bold color={tokens.accent}>
          {GEMINI_CONNECT_TITLE}
        </Text>
        <Text color={tokens.textSecondary} wrap="wrap">
          {GEMINI_CONNECT_INTRO}
        </Text>
        <Select
          options={geminiConnectRows(facts)}
          onChange={value => {
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

  if (step <= 4) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <GuideLines lines={geminiGuidePaneLines({ step, ...(opened ? { opened } : {}), ...(note ? { note } : {}), compact })} />
        <Text dimColor>{geminiGuideHint(step)}</Text>
      </Box>
    )
  }

  if (step === 5) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <GuideLines lines={geminiGuidePaneLines({ step, compact })} />
        <Text color={tokens.textSecondary} wrap="wrap">
          {GEMINI_CLIENT_STORED_UNVERIFIED_NOTE}
        </Text>
        {field === 'id' ? (
          <Box>
            <Text>Client id: </Text>
            <TextInput
              value={clientId}
              onChange={setClientId}
              onSubmit={submitClientId}
              columns={48}
              cursorOffset={clientCursor}
              onChangeCursorOffset={setClientCursor}
              onEscape={() => {
                if (stepFiveBackRef.current === 'choice') backToChoice()
                else enterStep(4)
              }}
            />
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text>
              Client id: <Text color={tokens.success}>{clientId}</Text> ✓
            </Text>
            <Box>
              <Text>Client secret (optional, ↵ skips): </Text>
              <TextInput
                value={clientSecret}
                onChange={setClientSecret}
                onSubmit={submitClientSecret}
                mask="*"
                columns={40}
                cursorOffset={clientCursor}
                onChangeCursorOffset={setClientCursor}
                onEscape={() => {
                  setField('id')
                  setClientCursor(clientId.length)
                  setNote(undefined)
                }}
              />
            </Box>
          </Box>
        )}
        {note !== undefined ? (
          <Text color={tokens.warning} wrap="wrap">
            {note}
          </Text>
        ) : null}
        <Text dimColor>{geminiGuideHint(5, field)}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <GuideLines lines={geminiGuidePaneLines({ step: 6, compact })} />
      {phase === 'exchanging' ? <Text color={tokens.textSecondary}>Exchanging the authorization code…</Text> : null}
      {listenerNote ? <Text color={tokens.warning}>{listenerNote}</Text> : null}
      {authorizeUrl && phase !== 'exchanging' ? (
        <>
          <Text color={tokens.textMuted}>If nothing opened, visit:</Text>
          <Text color={tokens.info} wrap="wrap">
            {authorizeUrl}
          </Text>
          <Box>
            <Text color={tokens.textMuted}>or paste the redirected URL: </Text>
            <TextInput
              value={paste}
              onChange={setPaste}
              onSubmit={submitPaste}
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

function GeminiKeyLeg({
  onResult,
  onBack,
}: {
  onResult: (receipt: string, ok?: boolean) => void
  onBack: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [opened, setOpened] = useState<GeminiGuideOpenState>('opening')
  const [key, setKey] = useState('')
  const [cursor, setCursor] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [storing, setStoring] = useState(false)
  useEffect(() => {
    let live = true
    void openBrowser(GEMINI_API_KEY_PAGE.address).then(ok => {
      if (live) setOpened(ok ? 'opened' : 'failed')
    })
    return () => {
      live = false
    }
  }, [])
  const submit = (raw: string): void => {
    const value = raw.trim()
    if (!value) return
    const guard = keyPasteGuardNote(value, { stores: 'a Google Gemini key (AIza…)' })
    if (guard !== null) {
      setNote(guard)
      return
    }
    setStoring(true)
    void storeGeminiApiKeyLogin(value).then(outcome => {
      if (!outcome.stored) {
        setStoring(false)
        setNote(outcome.receipt)
        return
      }
      onResult(outcome.receipt, outcome.ok)
    })
  }
  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      <Box flexDirection="column">
        <GuideLines lines={geminiKeyLegLines(opened)} />
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
      {storing ? <Text dimColor>Storing and checking the live catalogue…</Text> : null}
      {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
      <Text dimColor>esc back</Text>
    </Box>
  )
}
