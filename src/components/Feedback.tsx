
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text } from '../ink.js'
import type { CommandResultDisplay } from '../commands.js'
import type { Message } from '../types/message.js'
import TextInput from './TextInput.js'
import { Select } from './CustomSelect/select.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useRegisterOverlay } from '../context/overlayContext.js'
import { useInput } from '../ink.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { getInMemoryErrors, logError } from '../utils/log.js'
import { envDynamic } from '../utils/envDynamic.js'
import {
  getLastAPIRequest,
  getLastMainRequestId,
} from '../bootstrap/state.js'
import { getIsGit } from '../utils/git.js'
import { mkdirSync } from 'node:fs'
import { homedir, release, type as osType } from 'node:os'
import { join } from 'node:path'
import { getMercuryHome } from '../utils/envUtils.js'
import { escapeRegExp } from '../utils/stringUtils.js'
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
import {
  ISSUE_FORMS,
  ISSUE_KINDS,
  composeIssueBody,
  fullIssueTitle,
  noGhParagraph,
  promptedFields,
  type IssueForm,
  type IssueKind,
} from '../commands/feedback/issueForms.js'
import { gatherDoctorSection } from '../commands/feedback/doctorSection.js'
import {
  checkIssueAccess,
  fileIssue,
  issueRepoSlug,
  issuesPageUrl,
  type IssueAccess,
} from '../services/repoHost/ghIssue.js'
import { provenanceLine, resolveInstallProvenance } from '../services/privateChannel/installProvenance.js'
import { getMainLoopModel } from '../utils/model/model.js'
import { focusedSessionModelFacts } from '../services/engine-connector/focusedConnector.js'
import { providerFamilyOfSetting } from '../utils/model/modelTransition.js'
import { providerDisplayName } from '../services/providers/routeLaw.js'
import { CREDENTIAL_VALUE_PASSES } from '../services/providers/credentialEnvSpellings.js'


export function redactSensitiveInfo(text: string): string {
  let result = text
  result = result.replace(/["']sk-ant[A-Za-z0-9_-]{24,}["']/g, '[REDACTED_API_KEY]')
  for (const pass of CREDENTIAL_VALUE_PASSES) {
    result = result.replace(new RegExp(pass.pattern.source, pass.pattern.flags), pass.marker)
  }
  result = result.replace(/AWS[ _-]?key["'\s:=]+["']AWS[A-Z0-9]{20,}["']/gi, '[REDACTED_AWS_KEY]')
  result = result.replace(/(?<![A-Za-z0-9])AKIA[A-Z0-9]{16}(?![A-Za-z0-9])/g, '[REDACTED_AWS_KEY]')
  result = result.replace(
    /[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com/g,
    '[REDACTED_GCP_SERVICE_ACCOUNT]',
  )
  result = result.replace(
    /(x-api-key["'\s:=]+)["']?[A-Za-z0-9_-]+["']?/gi,
    '$1[REDACTED]',
  )
  result = result.replace(
    /(authorization["'\s:=]+)["']?(?:bearer\s+)?[A-Za-z0-9._-]+["']?/gi,
    '$1[REDACTED]',
  )
  result = result.replace(/(AWS[_-][A-Z_-]*["'\s:=]+)["']?[^\s"']+["']?/gi, '$1[REDACTED_AWS_VALUE]')
  result = result.replace(
    /(GOOGLE[_-][A-Z_-]*["'\s:=]+)["']?[^\s"']+["']?/gi,
    '$1[REDACTED_GCP_VALUE]',
  )
  result = result.replace(
    /((?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)["'\s:=]+)["']?[^\s"'[]+["']?/gi,
    '$1[REDACTED_TOKEN]',
  )
  const home = homedir()
  if (home.length > 1) {
    const spellings = new Set([home, ...(process.platform === 'win32' ? [home.replace(/\\/g, '/')] : [])])
    for (const spelling of spellings) {
      result = result.replace(new RegExp(`${escapeRegExp(spelling)}(?=$|[\\\\/\\s"'\`:;,)\\]>])`, 'g'), '~')
    }
  }
  return result
}


const ISSUE_URL_CAP = 7250
const TRUNCATION_NOTE = '\n\n[Truncated]'
const SAFETY_MARGIN = 50

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


const GENERIC_TITLE = 'Bug report from Mercury'

export function fallbackTitle(description: string, generic: string = GENERIC_TITLE): string {
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
  if (candidate.length < 10) return generic
  return candidate
}

function titleSystemPrompt(form: IssueForm): string {
  return [
    `Generate a concise, technical issue title (max 80 chars) for this ${form.name.toLowerCase()} about Mercury, a terminal software-development harness.`,
    'No prefix, no brackets, no trailing period — the title starts with the subject.',
    'Be specific and use technical vocabulary. For long error messages, extract the key error. Be direct — no filler.',
    'If the issue cannot be determined, answer exactly: Report needs triage.',
    'Any model API errors mentioned come from the configured provider.',
    'Your response is used directly as the title with no commentary.',
    'Examples:',
    'Scroll position resets when a background task completes',
    'TypeError in transcript renderer on empty tool result',
    'Startup takes 8s with large session index',
  ].join('\n')
}

const TITLE_DEADLINE_MS = 15_000

async function generateTitle(
  form: IssueForm,
  description: string,
  outer: AbortSignal,
): Promise<string> {
  const generic = `${form.name} from Mercury`
  const controller = new AbortController()
  const onOuter = (): void => controller.abort(outer.reason)
  outer.addEventListener('abort', onOuter, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('title deadline')), TITLE_DEADLINE_MS)
  try {
    const answer = await Promise.race([
      routedCallModelSettled({
        messages: [createUserMessage({ content: description })],
        systemPrompt: asSystemPrompt([titleSystemPrompt(form)]),
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal: controller.signal,
        options: {
          getToolPermissionContext: async () => ({}) as ToolPermissionContext,
          model: sessionSmallFastModel(),
          maxOutputTokensOverride: 100,
          isNonInteractiveSession: false,
          querySource: 'feedback',
          agents: [],
          hasAppendSystemPrompt: false,
          skipCacheWrite: true,
          mcpTools: [],
        },
      }),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
      }),
    ])
    if ((answer as { isApiErrorMessage?: boolean }).isApiErrorMessage) {
      return fallbackTitle(description, generic)
    }
    const content = answer.message.content
    const text = (Array.isArray(content) ? content : [])
      .filter(block => (block as { type?: string }).type === 'text')
      .map(block => (block as { text?: string }).text ?? '')
      .join('')
      .trim()
    if (text === '' || text.startsWith('API Error')) return fallbackTitle(description, generic)
    return text
  } catch {
    return fallbackTitle(description, generic)
  } finally {
    clearTimeout(timer)
    outer.removeEventListener('abort', onOuter)
  }
}


function productVersion(): string {
  return typeof MACRO !== 'undefined' && MACRO.VERSION ? MACRO.VERSION : 'unknown'
}

function platformLine(): string {
  const name =
    process.platform === 'darwin'
      ? 'macOS'
      : process.platform === 'win32'
        ? 'Windows'
        : process.platform === 'linux'
          ? 'Linux'
          : process.platform
  return `${name} · ${osType()} ${release()} · ${process.arch} · ${envDynamic.terminal ?? 'unknown terminal'}`
}

function installLine(): string {
  try {
    const p = resolveInstallProvenance()
    const option =
      p.kind === 'development'
        ? 'Built from source (node dist/mercury.mjs)'
        : p.kind === 'managed'
          ? 'A release archive (mercury install)'
          : p.kind === 'extracted-release'
            ? 'A release archive (run in place, not installed)'
            : p.invokedPath.startsWith(join(getMercuryHome(), 'runtime'))
              ? 'The mercury launcher over a deployed runtime'
              : 'Unrecognized install shape'
    return `${option} — ${provenanceLine(p)}`
  } catch {
    return 'unknown — the install probe threw'
  }
}

function modelFacts(): { family: string; model: string } {
  try {
    const model = focusedSessionModelFacts()?.effective ?? getMainLoopModel()
    const route = providerFamilyOfSetting(model)
    return { family: route === 'unrecognised' ? 'Not sure' : providerDisplayName(route), model }
  } catch {
    return { family: 'Not sure', model: '(unknown)' }
  }
}


type RecentError = { error: string; timestamp: string }

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
): Promise<{ report: Record<string, unknown>; errors: RecentError[] }> {
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
    errors,
    report: {
      message_count: messages.length,
      datetime: new Date().toISOString(),
      description,
      platform: process.platform,
      is_git: isGit,
      terminal: envDynamic.terminal ?? 'unknown',
      version: productVersion(),
      transcript: normalizeMessagesForAPI(messages),
      errors,
      last_api_request: getLastAPIRequest(),
      last_request_id: (lastAssistant as { requestId?: string } | undefined)?.requestId ?? getLastMainRequestId(),
      subagent_transcripts: { ...fromDisk, ...fromTasks },
      raw_transcript: rawTranscript,
    },
  }
}

function draftPaths(kind: IssueKind): { json: string; body: string } | null {
  try {
    const dir = join(getMercuryHome(), 'feedback')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    return { json: join(dir, `${kind}-${stamp}.json`), body: join(dir, `${kind}-${stamp}.md`) }
  } catch (pathError) {
    logError(pathError)
    return null
  }
}

function writeDraftFile(path: string, content: string): boolean {
  try {
    durableAtomicPublishSync(path, content)
    return true
  } catch (persistError) {
    logError(persistError)
    return false
  }
}

function draftJson(record: Record<string, unknown>): string {
  return `${JSON.stringify(record, null, 2)}\n`
}


function wrapLine(line: string, width: number): string[] {
  if (line.length <= width) return [line]
  const out: string[] = []
  let rest = line
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width)
    if (cut < width / 2) cut = width
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^ /, '')
  }
  out.push(rest)
  return out
}

export function bodyLines(body: string, width: number): string[] {
  return body.replace(/\n$/, '').split('\n').flatMap(line => wrapLine(line, width))
}

export function bodyByteCount(body: string): number {
  return Buffer.byteLength(body, 'utf8')
}


type Step =
  | 'kind'
  | 'ask'
  | 'preparing'
  | 'review'
  | 'filing'
  | 'done'
  | 'unavailable'
  | 'failed'

function surfaceTitle(form: IssueForm | null): string {
  if (form === null) return 'Feedback — which kind?'
  switch (form.kind) {
    case 'bug':
      return 'Report a bug'
    case 'provider':
      return 'Report a provider or model problem'
    case 'feature':
      return 'Request a feature'
  }
}

export function Feedback({
  abortSignal,
  messages,
  initialDescription = '',
  onDone,
  backgroundTasks = {},
  kind,
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
  kind?: IssueKind
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns, rows } = useTerminalSize()
  const [form, setForm] = useState<IssueForm | null>(kind !== undefined ? ISSUE_FORMS[kind] : null)
  const [step, setStep] = useState<Step>(kind !== undefined ? 'ask' : 'kind')
  const [askIndex, setAskIndex] = useState(0)
  const [draft, setDraft] = useState(initialDescription)
  const [cursorOffset, setCursorOffset] = useState(initialDescription.length)
  const answersRef = useRef<Record<string, string>>({})
  const [title, setTitle] = useState<string | null>(null)
  const [body, setBody] = useState('')
  const [scroll, setScroll] = useState(0)
  const [paths, setPaths] = useState<{ json: string; body: string } | null>(null)
  const [access, setAccess] = useState<IssueAccess | null>(null)
  const [failure, setFailure] = useState<{ note: string; remedy: string } | null>(null)
  const [issueUrl, setIssueUrl] = useState<string | null>(null)
  const slugRef = useRef(issueRepoSlug())
  const recordRef = useRef<Record<string, unknown> | null>(null)
  const preparedRef = useRef(false)
  const finishedRef = useRef(false)
  const doneMessageRef = useRef<string>('Report closed — nothing was filed.')

  const finish = useCallback(
    (message: string) => {
      if (finishedRef.current) return
      finishedRef.current = true
      onDone(message, { display: 'system' })
    },
    [onDone],
  )

  const cancel = useCallback(() => {
    finish(`${form?.name ?? 'Feedback'} cancelled — nothing was filed.`)
  }, [finish, form])

  const prompted = form !== null ? promptedFields(form) : []
  const field = prompted[askIndex] ?? null

  const keptMessage = useCallback(
    (p: { json: string; body: string } | null): string =>
      p !== null
        ? `${form?.name ?? 'Report'} drafted locally at ${p.json} — nothing was filed.`
        : `${form?.name ?? 'Report'} drafted locally — the draft file could not be written (see the error log); nothing was filed.`,
    [form],
  )

  const prepare = useCallback(async () => {
    if (form === null || preparedRef.current) return
    preparedRef.current = true
    setStep('preparing')
    const words = answersRef.current
    const description = prompted.find(f => f.source === 'words') !== undefined
      ? (words[prompted.find(f => f.source === 'words')!.id] ?? '')
      : ''
    const slug = slugRef.current
    try {
      const [gathered, generated, doctor, reach] = await Promise.all([
        gatherReport(description, messages, backgroundTasks),
        generateTitle(form, description, abortSignal),
        gatherDoctorSection({ signal: abortSignal }),
        checkIssueAccess(slug),
      ])
      const facts = modelFacts()
      const values: Record<string, string> = {
        ...words,
        version: `Mercury ${productVersion()}`,
        platform: platformLine(),
        install: installLine(),
        family: facts.family,
        model: facts.model,
        doctor,
      }
      const composed = redactSensitiveInfo(composeIssueBody(form, { values, recentErrors: gathered.errors }))
      const fullTitle = fullIssueTitle(form, redactSensitiveInfo(generated))
      const p = draftPaths(form.kind)
      const bodyWritten = p !== null && writeDraftFile(p.body, composed)
      const record: Record<string, unknown> = {
        title: fullTitle,
        kind: form.kind,
        issue_repo: slug,
        body_path: bodyWritten ? p!.body : null,
        ...gathered.report,
      }
      recordRef.current = record
      const draftWritten = p !== null && writeDraftFile(p.json, draftJson(record))
      const written = draftWritten && bodyWritten ? p : null
      setPaths(written)
      setBody(composed)
      setTitle(fullTitle)
      setAccess(reach)
      setScroll(0)
      if (written === null) {
        setFailure({
          note: 'the draft files could not be written under the config home (see the error log)',
          remedy: 'free disk space or fix the permissions of the config home, then run the command again',
        })
        doneMessageRef.current = keptMessage(null)
        setStep('failed')
        return
      }
      if (reach.state !== 'ok') {
        doneMessageRef.current = keptMessage(written)
        setStep('unavailable')
        return
      }
      doneMessageRef.current = keptMessage(written)
      setStep('review')
    } catch (prepareError) {
      logError(prepareError)
      preparedRef.current = false
      setFailure({
        note: `preparing the report failed: ${prepareError instanceof Error ? prepareError.message : String(prepareError)}`,
        remedy: 'run the command again',
      })
      doneMessageRef.current = keptMessage(null)
      setStep('failed')
    }
  }, [form, prompted, messages, backgroundTasks, abortSignal, keptMessage])

  const file = useCallback(async () => {
    if (form === null || paths === null || title === null) return
    setStep('filing')
    const result = await fileIssue({ slug: slugRef.current, title, bodyFile: paths.body })
    if (result.state === 'filed') {
      if (recordRef.current !== null) {
        writeDraftFile(paths.json, draftJson({ ...recordRef.current, issue_url: result.url }))
      }
      setIssueUrl(result.url)
      doneMessageRef.current = `${form.name} filed at ${result.url} — the local draft is at ${paths.json}`
      setStep('done')
      return
    }
    setFailure(result)
    doneMessageRef.current = `${form.name} not filed — ${result.note}; the draft is at ${paths.json}`
    setStep('failed')
  }, [form, paths, title])

  const advance = useCallback(
    (value: string) => {
      if (field === null || form === null) return
      const text = value.trim()
      if (field.source === 'words' && text === '') return
      answersRef.current[field.id] = text
      if (askIndex + 1 < prompted.length) {
        setAskIndex(askIndex + 1)
        setDraft('')
        setCursorOffset(0)
        return
      }
      void prepare()
    },
    [field, form, askIndex, prompted.length, prepare],
  )

  const boxWidth = Math.max(30, columns - 8)
  const lines = step === 'review' ? bodyLines(body, boxWidth) : []
  const viewRows = Math.max(6, Math.min(lines.length, rows - 16))
  const maxScroll = Math.max(0, lines.length - viewRows)
  const bytes = bodyByteCount(body)

  useEffect(() => {
    if (scroll > maxScroll) setScroll(maxScroll)
  }, [scroll, maxScroll])

  useRegisterOverlay('feedback-review', step === 'review', { ownsPageKeys: true })

  useInput(
    (input, key) => {
      if (step === 'review') {
        if (key.return) {
          void file()
        } else if (key.upArrow) {
          setScroll(s => Math.max(0, s - 1))
        } else if (key.downArrow) {
          setScroll(s => Math.min(maxScroll, s + 1))
        } else if (key.pageUp) {
          setScroll(s => Math.max(0, s - viewRows))
        } else if (key.pageDown) {
          setScroll(s => Math.min(maxScroll, s + viewRows))
        }
        return
      }
      if (step === 'done' || step === 'failed') {
        finish(doneMessageRef.current)
        return
      }
      if (step === 'unavailable') {
        const repoConfigured = Boolean(flagEnv('MERCURY_ISSUES_REPO_URL'))
        if (key.return && repoConfigured && title !== null) {
          const description = answersRef.current[prompted.find(f => f.source === 'words')?.id ?? ''] ?? ''
          const url = createGitHubIssueUrl('', title, description, getInMemoryErrors())
          if (url !== '') void openBrowser(url)
        }
        finish(doneMessageRef.current)
      }
    },
    { isActive: step === 'review' || step === 'done' || step === 'unavailable' || step === 'failed' },
  )

  useKeybinding(
    'confirm:no',
    () => {
      if (step === 'review' || step === 'done' || step === 'unavailable' || step === 'failed') {
        finish(doneMessageRef.current)
      } else {
        cancel()
      }
    },
    { context: 'Confirmation', isActive: step !== 'preparing' && step !== 'filing' },
  )

  const repoConfigured = Boolean(flagEnv('MERCURY_ISSUES_REPO_URL'))
  const slug = slugRef.current

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tokens.borderSubtle}
      paddingX={1}
      gap={1}
    >
      <Text bold>{surfaceTitle(form)}</Text>
      {step === 'kind' ? (
        <Box flexDirection="column" gap={1}>
          <Text>Which form does this follow?</Text>
          <Select
            options={ISSUE_KINDS.map(k => ({
              label: ISSUE_FORMS[k].name,
              value: k,
              description: ISSUE_FORMS[k].description,
            }))}
            onChange={value => {
              const chosen = ISSUE_FORMS[value as IssueKind]
              setForm(chosen)
              setAskIndex(0)
              setStep('ask')
            }}
            onCancel={cancel}
          />
          <Text dimColor>↑↓ choose · enter to continue · esc to cancel</Text>
        </Box>
      ) : null}
      {step === 'ask' && field !== null ? (
        <Box flexDirection="column" gap={1}>
          <Text>
            {field.label}
            {field.source === 'ask' ? <Text dimColor> (optional — enter to skip)</Text> : null}:
          </Text>
          {field.prompt !== undefined ? <Text dimColor>{field.prompt}</Text> : null}
          <TextInput
            value={draft}
            onChange={setDraft}
            onSubmit={advance}
            onExit={cancel}
            columns={Math.max(30, columns - 6)}
            multiline
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            placeholder={field.source === 'words' ? 'What happened?' : ''}
          />
          <Text dimColor>enter to continue · esc to cancel</Text>
        </Box>
      ) : null}
      {step === 'preparing' ? <Text dimColor>Preparing the report…</Text> : null}
      {step === 'review' && form !== null ? (
        <Box flexDirection="column" gap={1}>
          <Text>
            This exact body ({bytes} bytes) will be filed as a new issue in {slug} through your own gh, titled:
          </Text>
          <Text bold>{title}</Text>
          <Box flexDirection="column" borderStyle="single" borderColor={tokens.borderSubtle} paddingX={1}>
            {lines.slice(scroll, scroll + viewRows).map((line, i) => (
              <Text key={scroll + i}>{line === '' ? ' ' : line}</Text>
            ))}
          </Box>
          <Text dimColor>
            {lines.length > viewRows
              ? `lines ${scroll + 1}–${Math.min(lines.length, scroll + viewRows)} of ${lines.length} · ↑↓ pgup pgdn scroll · `
              : ''}
            The session transcript stays in the local draft ({paths?.json}) and is not sent.
          </Text>
          <Text dimColor>enter to file it · esc to keep the draft only</Text>
        </Box>
      ) : null}
      {step === 'filing' ? <Text dimColor>Filing through gh…</Text> : null}
      {step === 'done' && form !== null ? (
        <Box flexDirection="column" gap={1}>
          <Text color={tokens.success}>Filed: {issueUrl}</Text>
          <Text dimColor>
            The body that left the box: {paths?.body} · the local draft (with the transcript): {paths?.json}
          </Text>
          <Text dimColor>press any key to close</Text>
        </Box>
      ) : null}
      {step === 'unavailable' && access !== null && access.state !== 'ok' ? (
        <Box flexDirection="column" gap={1}>
          <Text>
            {noGhParagraph({
              note: access.note,
              remedy: access.remedy,
              slug,
              draftPath: paths?.json ?? null,
              bodyPath: paths?.body ?? null,
            })}
          </Text>
          {repoConfigured ? (
            <Text dimColor>
              enter to open a pre-filled issue draft in the browser · any other key to close
            </Text>
          ) : (
            <Text dimColor>press any key to close</Text>
          )}
        </Box>
      ) : null}
      {step === 'failed' && failure !== null ? (
        <Box flexDirection="column" gap={1}>
          <Text color={tokens.failureText}>Not filed: {failure.note}</Text>
          <Text>
            {failure.remedy}.
            {paths !== null
              ? ` The body to paste is at ${paths.body} and the local draft at ${paths.json}; the issues page is ${issuesPageUrl(slug)}.`
              : ''}
          </Text>
          <Text dimColor>press any key to close</Text>
        </Box>
      ) : null}
    </Box>
  )
}

export default Feedback
