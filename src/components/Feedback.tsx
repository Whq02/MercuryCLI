// Feedback / bug report: description → consent → preparing → done.
// The report is drafted LOCALLY — nothing is uploaded anywhere; submission
// returns success without an identifier and performs no network call. The
// failure branches around a submitter are kept but unreachable at this
// snapshot. A concurrent side query drafts a title with a small fast model.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text } from '../ink.js'
import type { CommandResultDisplay } from '../commands.js'
import type { Message } from '../types/message.js'
import TextInput from './TextInput.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useInput } from '../ink.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { getInMemoryErrors, logError } from '../utils/log.js'
import { envDynamic } from '../utils/envDynamic.js'
import {
  getLastAPIRequest,
  getLastMainRequestId,
} from '../bootstrap/state.js'
import { getIsGit, getBranch, getHead, getRemoteUrl, getIsClean, hasUnpushedCommits } from '../utils/git.js'
import { getCwd } from '../utils/cwd.js'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getMercuryHome } from '../utils/envUtils.js'
import { durableAtomicPublishSync } from '../substrate/durablePublish.js'
import { sessionSmallFastModel } from '../utils/model/providerFrontier.js'
import { routedCallModelSettled } from '../services/providers/callModelRouter.js'
import { createUserMessage, normalizeMessagesForAPI } from '../utils/messages.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import type { ToolPermissionContext } from '../Tool.js'
import {
  MAX_TRANSCRIPT_READ_BYTES,
  getTranscriptPathForSession,
  loadAllSubagentTranscriptsFromDisk,
} from '../utils/sessionStorage.js'
import { getSessionId } from '../bootstrap/state.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { openBrowser } from '../utils/browser.js'
import { logForDebugging } from '../utils/debug.js'

// ── secret redaction (contract data: patterns + markers) ───────────────────

export function redactSensitiveInfo(text: string): string {
  let result = text
  // Provider API keys: quoted (≥24 key chars) and bare (≥10, not adjacent
  // to an alphanumeric or quote).
  result = result.replace(/["']sk-ant[A-Za-z0-9_-]{24,}["']/g, '[REDACTED_API_KEY]')
  result = result.replace(
    /(?<![A-Za-z0-9"'])sk-ant[A-Za-z0-9_-]{10,}(?![A-Za-z0-9"'])/g,
    '[REDACTED_API_KEY]',
  )
  // Cloud access keys: the labelled quoted form and the AKIA form.
  result = result.replace(/AWS[ _-]?key["'\s:=]+["']AWS[A-Z0-9]{20,}["']/gi, '[REDACTED_AWS_KEY]')
  result = result.replace(/(?<![A-Za-z0-9])AKIA[A-Z0-9]{16}(?![A-Za-z0-9])/g, '[REDACTED_AWS_KEY]')
  // Google API keys.
  result = result.replace(
    /(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9])/g,
    '[REDACTED_GCP_KEY]',
  )
  // Service-account addresses.
  result = result.replace(
    /[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com/g,
    '[REDACTED_GCP_SERVICE_ACCOUNT]',
  )
  // Header values: the captured prefix stays, only the value is replaced.
  result = result.replace(
    /(x-api-key["'\s:=]+)["']?[A-Za-z0-9_-]+["']?/gi,
    '$1[REDACTED]',
  )
  result = result.replace(
    /(authorization["'\s:=]+)["']?(?:bearer\s+)?[A-Za-z0-9._-]+["']?/gi,
    '$1[REDACTED]',
  )
  // Environment assignments.
  result = result.replace(/(AWS[_-][A-Z_-]*["'\s:=]+)["']?[^\s"']+["']?/gi, '$1[REDACTED_AWS_VALUE]')
  result = result.replace(
    /(GOOGLE[_-][A-Z_-]*["'\s:=]+)["']?[^\s"']+["']?/gi,
    '$1[REDACTED_GCP_VALUE]',
  )
  // The value class excludes '[' so an already-substituted redaction marker
  // from the header/env passes above is never re-clobbered.
  result = result.replace(
    /((?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)["'\s:=]+)["']?[^\s"'[]+["']?/gi,
    '$1[REDACTED_TOKEN]',
  )
  return result
}

// ── issue-draft URL (contract data: labels + the 7250 cap) ─────────────────

const ISSUE_URL_CAP = 7250
const TRUNCATION_NOTE = '\n\n[Truncated]'
const SAFETY_MARGIN = 50

/** Back off to before the last percent sign when a cut lands inside a
 *  percent escape. */
function percentSafeTruncate(encoded: string, budget: number): string {
  if (encoded.length <= budget) return encoded
  let cut = encoded.slice(0, Math.max(0, budget))
  const lastPercent = cut.lastIndexOf('%')
  if (lastPercent > cut.length - 3) cut = cut.slice(0, lastPercent)
  return cut
}

export function createGitHubIssueUrl(
  feedbackId: string,
  title: string,
  description: string,
  errors: { error: string; timestamp: string }[],
): string {
  const repoUrl = flagEnv('MERCURY_ISSUES_REPO_URL')
  if (!repoUrl) return ''
  const safeTitle = redactSensitiveInfo(title)
  const safeDescription = redactSensitiveInfo(description)
  const bodyPrefix = `**Bug Description**\n${safeDescription}\n\n**Environment Info**\n- Platform: ${process.platform}\n- Terminal: ${envDynamic.terminal ?? 'unknown'}\n- Version: ${typeof MACRO !== 'undefined' && MACRO.VERSION ? MACRO.VERSION : 'unknown'}\n- Feedback ID: ${feedbackId}\n\n**Errors**\n\`\`\`json\n`
  const bodySuffix = '\n```\n'
  const errorsJson = JSON.stringify(errors, null, 2)
  const base = `${repoUrl.replace(/\/$/, '')}/issues/new?title=${encodeURIComponent(safeTitle)}&labels=${encodeURIComponent('user-reported,bug')}&body=`
  const encodedPrefix = encodeURIComponent(bodyPrefix)
  const encodedSuffix = encodeURIComponent(bodySuffix)
  const encodedNote = encodeURIComponent(TRUNCATION_NOTE)
  const ellipsis = encodeURIComponent('…')

  const errorSpace =
    ISSUE_URL_CAP - base.length - encodedPrefix.length - encodedSuffix.length - encodedNote.length
  if (errorSpace <= 0) {
    // Even the frame does not fit: encode the whole body and truncate it.
    const whole = encodeURIComponent(bodyPrefix + errorsJson + bodySuffix)
    const budget =
      ISSUE_URL_CAP - base.length - ellipsis.length - encodedNote.length - SAFETY_MARGIN
    return base + percentSafeTruncate(whole, budget) + ellipsis + encodedNote
  }
  const encodedErrors = encodeURIComponent(errorsJson)
  if (encodedErrors.length <= errorSpace) {
    return base + encodedPrefix + encodedErrors + encodedSuffix
  }
  return (
    base +
    encodedPrefix +
    percentSafeTruncate(encodedErrors, errorSpace - ellipsis.length) +
    ellipsis +
    encodedSuffix +
    encodedNote
  )
}

// ── title generation ───────────────────────────────────────────────────────

const GENERIC_TITLE = 'Bug report from Mercury'

export function fallbackTitle(description: string): string {
  const firstLine = (description.split('\n')[0] ?? '').trim()
  let candidate: string
  if (firstLine.length >= 6 && firstLine.length <= 60) {
    candidate = firstLine
  } else {
    let cut = firstLine.slice(0, 60)
    const boundary = cut.lastIndexOf(' ')
    if (boundary > 30) cut = cut.slice(0, boundary)
    candidate = firstLine.length > 60 ? `${cut}…` : cut
  }
  if (candidate.length < 10) return GENERIC_TITLE
  return candidate
}

const TITLE_SYSTEM_PROMPT = [
  'Generate a concise, technical issue title (max 80 chars) for this bug report for Mercury, a terminal software-development harness.',
  'The first element must be a bracketed type marker, e.g. [Bug], [Crash], [Performance], [UI].',
  'Be specific and use technical vocabulary. For long error messages, extract the key error. Be direct — no filler.',
  'If the issue cannot be determined, answer exactly: [Bug] Report needs triage.',
  'Any model API errors mentioned come from the configured provider.',
  'Your response is used directly as the title with no commentary.',
  'Examples:',
  '[Bug] Scroll position resets when a background task completes',
  '[Crash] TypeError in transcript renderer on empty tool result',
  '[Performance] Startup takes 8s with large session index',
].join('\n')

async function generateTitle(
  description: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    // The title rides the SESSION FAMILY's small-fast tier through the
    // routed seam (trust-combo census): the model id decides the
    // wire, so /feedback titles generate on every family — and every
    // failure mode still degrades to the mechanical fallback title.
    const answer = await routedCallModelSettled({
      messages: [createUserMessage({ content: description })],
      systemPrompt: asSystemPrompt([TITLE_SYSTEM_PROMPT]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal,
      options: {
        getToolPermissionContext: async () => ({}) as ToolPermissionContext,
        model: sessionSmallFastModel(),
        maxOutputTokensOverride: 100,
        isNonInteractiveSession: false,
        // 'feedback' is this surface's REGISTERED QuerySource; the old
        // side-query spelling 'bug_report_title' was a loose string the
        // typed union never carried.
        querySource: 'feedback',
        agents: [],
        hasAppendSystemPrompt: false,
        skipCacheWrite: true,
        mcpTools: [],
      },
    })
    if ((answer as { isApiErrorMessage?: boolean }).isApiErrorMessage) {
      return fallbackTitle(description)
    }
    const content = answer.message.content
    const text = (Array.isArray(content) ? content : [])
      .filter(block => (block as { type?: string }).type === 'text')
      .map(block => (block as { text?: string }).text ?? '')
      .join('')
      .trim()
    if (text === '' || text.startsWith('API Error')) return fallbackTitle(description)
    return text
  } catch {
    return fallbackTitle(description)
  }
}

// ── report assembly (local only) ───────────────────────────────────────────

/** The draft's one home: <config-home>/feedback/bug-<stamp>.json — written
 *  through the atomic-publish law, fail-soft (a refused write logs and the
 *  done screen says so; the flow never fails over a draft). */
function persistDraftLocally(report: Record<string, unknown>, title: string | null): string | null {
  try {
    const dir = join(getMercuryHome(), 'feedback')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const path = join(dir, `bug-${stamp}.json`)
    durableAtomicPublishSync(path, `${JSON.stringify({ title, ...report }, null, 2)}\n`)
    return path
  } catch (persistError) {
    logError(persistError)
    return null
  }
}

async function gatherReport(
  description: string,
  messages: Message[],
  backgroundTasks: {
    [taskId: string]: {
      type: string
      identity?: { agentId: string }
      messages?: Message[]
    }
  },
): Promise<Record<string, unknown>> {
  const lastAssistant = [...messages]
    .reverse()
    .find(message => message.type === 'assistant')
  const errors = getInMemoryErrors().map(entry => ({
    ...entry,
    error: redactSensitiveInfo(entry.error),
  }))
  const isGit = await getIsGit().catch(() => false)

  let rawTranscript: string | undefined
  try {
    const path = getTranscriptPathForSession(getSessionId())
    const { statSync, readFileSync } = await import('fs')
    const stat = statSync(path)
    if (stat.size <= MAX_TRANSCRIPT_READ_BYTES) {
      rawTranscript = readFileSync(path, 'utf8')
    } else {
      logForDebugging(`feedback: transcript over the read cap (${stat.size} bytes), skipped`)
    }
  } catch {
    rawTranscript = undefined
  }

  const fromDisk = await loadAllSubagentTranscriptsFromDisk().catch(
    () => ({}) as Record<string, Message[]>,
  )
  const fromTasks: Record<string, Message[]> = {}
  for (const task of Object.values(backgroundTasks)) {
    if (task.identity?.agentId && task.messages) {
      fromTasks[task.identity.agentId] = task.messages
    }
  }

  return {
    message_count: messages.length,
    datetime: new Date().toISOString(),
    description,
    platform: process.platform,
    is_git: isGit,
    terminal: envDynamic.terminal ?? 'unknown',
    version: typeof MACRO !== 'undefined' && MACRO.VERSION ? MACRO.VERSION : 'unknown',
    transcript: normalizeMessagesForAPI(messages),
    errors,
    last_api_request: getLastAPIRequest(),
    last_request_id: (lastAssistant as { requestId?: string } | undefined)?.requestId ?? getLastMainRequestId(),
    subagent_transcripts: { ...fromDisk, ...fromTasks },
    raw_transcript: rawTranscript,
  }
}

// ── the surface ────────────────────────────────────────────────────────────

type Step = 'description' | 'consent' | 'preparing' | 'done'

export function Feedback({
  abortSignal,
  messages,
  initialDescription = '',
  onDone,
  backgroundTasks = {},
}: {
  abortSignal: AbortSignal
  messages: Message[]
  initialDescription?: string
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
  backgroundTasks?: {
    [taskId: string]: {
      type: string
      identity?: { agentId: string }
      messages?: Message[]
    }
  }
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns } = useTerminalSize()
  const [step, setStep] = useState<Step>('description')
  const [description, setDescription] = useState(initialDescription)
  const [cursorOffset, setCursorOffset] = useState(initialDescription.length)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState<string | null>(null)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const preparedRef = useRef(false)
  const doneMessageRef = useRef<string>(
    'Bug report drafted locally — nothing was uploaded.',
  )

  const finish = useCallback(
    (message: string) => {
      onDone(message, { display: 'system' })
    },
    [onDone],
  )

  const prepare = useCallback(async () => {
    if (preparedRef.current) return
    preparedRef.current = true
    setStep('preparing')
    try {
      const titlePromise = generateTitle(description, abortSignal)
      const report = await gatherReport(description, messages, backgroundTasks)
      // The DRAFT is a real file: the old path built the whole report and
      // dropped it on the next line (`void report`), then said "drafted
      // locally" about an artifact that existed nowhere — the operator's bug
      // report was simply lost (TASK-017 S2,
      // feedback-report-built-then-discarded). Nothing is uploaded, exactly
      // as the consent copy promises; the draft lands under the config home
      // and the done screen names it.
      const generated = await titlePromise
      const draftPath = persistDraftLocally(report, generated)
      setSavedPath(draftPath)
      doneMessageRef.current =
        draftPath !== null
          ? `Bug report drafted locally at ${draftPath} — nothing was uploaded.`
          : 'Bug report drafted locally — the draft file could not be written (see the error log); nothing was uploaded.'
      setTitle(generated)
      setStep('done')
    } catch (prepareError) {
      logError(prepareError)
      preparedRef.current = false
      setError('Preparing the report failed — try again.')
      setStep('description')
    }
  }, [description, messages, backgroundTasks, abortSignal])

  // Consent step: Enter or space prepares.
  useInput(
    (input, key) => {
      if (step === 'consent' && (key.return || input === ' ')) {
        void prepare()
      } else if (step === 'done') {
        const repoConfigured = Boolean(flagEnv('MERCURY_ISSUES_REPO_URL'))
        if (key.return && repoConfigured && title !== null) {
          const url = createGitHubIssueUrl('', title, description, getInMemoryErrors())
          if (url !== '') void openBrowser(url)
          finish(doneMessageRef.current)
        } else {
          finish(doneMessageRef.current)
        }
      }
    },
    { isActive: step === 'consent' || step === 'done' },
  )

  // Escape before done: a distinct cancelled result.
  useKeybinding(
    'confirm:no',
    () => {
      if (step === 'done') finish(doneMessageRef.current)
      else onDone('Bug report cancelled', { display: 'system' })
    },
    { context: 'Confirmation', isActive: step !== 'preparing' },
  )

  const repoConfigured = Boolean(flagEnv('MERCURY_ISSUES_REPO_URL'))

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tokens.borderSubtle}
      paddingX={1}
      gap={1}
    >
      <Text bold>Report a bug</Text>
      {step === 'description' ? (
        <Box flexDirection="column" gap={1}>
          <Text>Describe what happened:</Text>
          <TextInput
            value={description}
            onChange={value => {
              // Editing clears a prior failure so a retry keeps the text.
              if (error !== null) setError(null)
              setDescription(value)
            }}
            onSubmit={value => {
              if (value.trim() !== '') setStep('consent')
            }}
            onExit={() => onDone('Bug report cancelled', { display: 'system' })}
            columns={Math.max(30, columns - 6)}
            multiline
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            placeholder="What went wrong?"
          />
          {error !== null ? <Text color={tokens.failureText}>{error}</Text> : null}
          <Text dimColor>enter to continue · esc to cancel</Text>
        </Box>
      ) : null}
      {step === 'consent' ? (
        <Box flexDirection="column" gap={1}>
          <Text>This report will include:</Text>
          <Box flexDirection="column">
            <Text>- Your description of the problem</Text>
            <Text>
              - Environment: {process.platform}, {envDynamic.terminal ?? 'unknown terminal'},
              v{typeof MACRO !== 'undefined' && MACRO.VERSION ? MACRO.VERSION : '?'}
            </Text>
            <GitStateLine />
            <Text>- The current session transcript</Text>
          </Box>
          <Text>
            The report is drafted locally — nothing is uploaded anywhere.
          </Text>
          <Text dimColor>enter or space to prepare · esc to cancel</Text>
        </Box>
      ) : null}
      {step === 'preparing' ? <Text dimColor>Preparing the report…</Text> : null}
      {step === 'done' ? (
        <Box flexDirection="column" gap={1}>
          <Text color={tokens.success}>
            {savedPath !== null
              ? `Report drafted locally — saved to ${savedPath} · nothing was uploaded.`
              : 'Report drafted locally — the draft file could not be written (see the error log) · nothing was uploaded.'}
          </Text>
          {title !== null ? <Text dimColor>Title: {title}</Text> : null}
          {repoConfigured ? (
            <Text dimColor>
              enter to open a pre-filled issue draft in the browser · any other
              key to close
            </Text>
          ) : (
            <Text dimColor>
              Set MERCURY_ISSUES_REPO_URL to enable a pre-filled issue draft.
              Press any key to close.
            </Text>
          )}
        </Box>
      ) : null}
    </Box>
  )
}

/** The git block of the consent list, resolved asynchronously. */
function GitStateLine(): React.ReactNode {
  const [line, setLine] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const isGit = await getIsGit().catch(() => false)
      if (!isGit) {
        if (!cancelled) setLine(null)
        return
      }
      const cwd = getCwd()
      const [branch, head, remote, clean, unpushed] = await Promise.all([
        getBranch(cwd).catch(() => ''),
        getHead().catch(() => ''),
        getRemoteUrl().catch(() => null),
        getIsClean().catch(() => true),
        hasUnpushedCommits().catch(() => false),
      ])
      const parts = [
        branch && `branch ${branch}`,
        head && `commit ${head.slice(0, 8)}`,
        remote && `remote ${remote}`,
        unpushed ? 'unsynced' : null,
        clean ? null : 'local changes',
      ].filter(Boolean)
      if (!cancelled) setLine(parts.join(', '))
    })()
    return () => {
      cancelled = true
    }
  }, [])
  if (line === null) return null
  return <Text>- Git repository state: {line}</Text>
}

export default Feedback
