import React, { useCallback, useRef, useState } from 'react'
import type { CommandResultDisplay } from '../catalogue/commands.js'
import type { Message } from '../../engine/message-shapes/message.js'
import { useKeybinding } from '../../screen/keys/useKeybinding.js'
import { useRegisterOverlay } from '../../screen/overlays/overlayHooks.js'
import { useInput } from '../../screen/themedRenderer.js'
import { useMercuryTokens } from '../../screen/widgets/useMercuryTokens.js'
import { useElevatedSurface } from '../../screen/widgets/useElevatedSurface.js'
import { useTerminalSize } from '../../screen/fullscreen-layout/useTerminalSize.js'
import { getInMemoryErrors, logError } from '../../platform/logs/errorLog.js'
import { envDynamic } from '../../platform/environment/envProbes.js'
import {
  getLastAPIRequest,
  getLastMainRequestId,
} from '../../boot/process-state/processState.js'
import { getIsGit } from '../../platform/git/git.js'
import { mkdirSync } from 'node:fs'
import { homedir, release, type as osType } from 'node:os'
import { join } from 'node:path'
import { getMercuryHome } from '../../platform/environment/envUtils.js'
import { escapeRegExp } from '../../platform/text/strings.js'
import { toPosixSeparators } from '../../platform/host-os/paths.js'
import { platformDisplayName } from '../../platform/host-os/words.js'
import { durableAtomicPublishSync } from '../../platform/substrate/durablePublish.js'
import { utilityCallFor } from '../../models/catalogue/utilityModel.js'
import { routedCallModelSettled } from '../../models/roads/callModelRouter.js'
import { createUserMessage, normalizeMessagesForAPI } from '../../engine/messages/messages.js'
import { asSystemPrompt } from '../../engine/system-prompt/systemPromptType.js'
import type { ToolPermissionContext } from '../../tools/kit/tool.js'
import {
  MAX_TRANSCRIPT_READ_BYTES,
  getTranscriptPathForSession,
  loadAllSubagentTranscriptsFromDisk,
} from '../../sessions/transcripts/sessionStorage.js'
import { historyHead, historyRange } from '../../sessions/transcripts/historyParts.js'
import { getSessionId } from '../../boot/process-state/processState.js'
import { openBrowser } from '../../platform/host-os/browser.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { ISSUE_FORMS, composeIssueBody, healthPointer, fullIssueTitle, issueFormUrl, promptedFields, type IssueForm, type IssueKind } from './issueForms.js'
import { gatherHealthSection } from './healthSection.js'
import { checkIssueAccess, fileIssue, issueRepoSlug, type IssueAccess } from '../../platform/repo-host/ghIssue.js'
import { provenanceLine, resolveInstallProvenance } from '../../platform/update-channel/installProvenance.js'
import { getEngineModel } from '../../models/catalogue/engineModel.js'
import { focusedSessionModelFacts } from '../../engine/connector/focusedConnector.js'
import { providerFamilyOfSetting } from '../../models/catalogue/modelTransition.js'
import { providerDisplayName } from '../../models/roads/routeLaw.js'
import { CREDENTIAL_VALUE_PASSES } from '../../models/sign-in/credentials/credentialEnvSpellings.js'
import { feedbackView, type Step } from '../../screen/feedback/feedbackView.js'
import { getErrnoCode } from '../../platform/errors/errors.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { withDeadline } from '../../platform/async/deadline.js'


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
    const spellings = new Set([home, toPosixSeparators(home)])
    for (const spelling of spellings) {
      result = result.replace(new RegExp(`${escapeRegExp(spelling)}(?=$|[\\\\/\\s"'\`:;,)\\]>])`, 'g'), '~')
    }
  }
  return result
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


function productVersion(): string {
  return typeof MACRO !== 'undefined' && MACRO.VERSION ? MACRO.VERSION : 'unknown'
}

function platformLine(): string {
  return `${platformDisplayName()} · ${osType()} ${release()} · ${process.arch} · ${envDynamic.terminal ?? 'unknown terminal'}`
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
            : p.kind === 'homebrew'
              ? 'Homebrew (brew install Whq02/mercury/mercury)'
              : p.kind === 'npm'
                ? 'npm (npm install -g mercury-tech-cli)'
                : p.kind === 'nix'
                  ? 'Nix (nix profile add github:Whq02/MercuryCLI)'
                  : p.invokedPath.startsWith(join(getMercuryHome(), 'runtime'))
                    ? 'The mercury launcher over a deployed runtime'
                    : 'Unrecognized install shape'
    return `${option} — ${provenanceLine(p)}`
  } catch (error) {
    passedOver(error)
    return 'unknown — the install probe threw'
  }
}

function modelFacts(): { family: string; model: string } {
  try {
    const model = focusedSessionModelFacts()?.effective ?? getEngineModel()
    const route = providerFamilyOfSetting(model)
    return { family: route === 'unrecognised' ? 'Not sure' : providerDisplayName(route), model }
  } catch {
    return { family: 'Not sure', model: '(unknown)' }
  }
}


type RecentError = { error: string; timestamp: string }

const EMPTY_PERMISSION_CONTEXT: ToolPermissionContext = {
  mode: 'default',
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: false,
}

async function generateTitle(
  form: IssueForm,
  description: string,
  signal: AbortSignal,
): Promise<string> {
  const generic = `${form.name} from Mercury`
  const fallback = (): string => fallbackTitle(description, generic)
  if (signal.aborted) return fallback()
  const controller = new AbortController()
  try {
    const { thinkingConfig, ...call } = utilityCallFor()
    const response = await withDeadline(
      routedCallModelSettled({
        messages: [
          createUserMessage({
            content: description,
          }),
        ],
        systemPrompt: asSystemPrompt([titleSystemPrompt(form)]),
        thinkingConfig,
        tools: [],
        signal: controller.signal,
        options: {
          ...call,
          getToolPermissionContext: async () => EMPTY_PERMISSION_CONTEXT,
          isNonInteractiveSession: true,
          querySource: 'feedback',
          agents: [],
          hasAppendSystemPrompt: false,
          mcpTools: [],
          maxOutputTokensOverride: 100,
        },
      }),
      TITLE_DEADLINE_MS,
      () => {
        controller.abort()
        return null
      },
      {
        signal,
        onAbort: () => {
          controller.abort(signal.reason)
          return null
        },
      },
    )
    if (response === null || response.isApiErrorMessage) return fallback()
    const text = response.message.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim()
    if (text === '' || text.startsWith('API Error')) return fallback()
    return text
  } catch (error) {
    passedOver(error)
    return fallback()
  } finally {
    if (!controller.signal.aborted) controller.abort()
  }
}

function autoFieldValue(fieldId: string): string {
  switch (fieldId) {
    case 'version':
      return `Mercury ${productVersion()}`
    case 'platform':
      return redactSensitiveInfo(platformLine())
    case 'os':
      return platformDisplayName()
    case 'install':
      return redactSensitiveInfo(installLine())
    case 'family':
      return modelFacts().family
    case 'model':
      return modelFacts().model
    default:
      return ''
  }
}

export async function gatherReport(
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
  const errors: RecentError[] = getInMemoryErrors().map(entry => ({
    error: redactSensitiveInfo(entry.error),
    timestamp: entry.timestamp,
  }))
  const recordProbeError = (prefix: string, err: unknown): void => {
    logError(err)
    const msg = err instanceof Error ? err.message : String(err)
    errors.push({
      error: redactSensitiveInfo(`${prefix} ${msg}`),
      timestamp: new Date().toISOString(),
    })
  }

  const [isGit, diskSubagents] = await Promise.all([
    getIsGit().catch((err): boolean | undefined => {
      recordProbeError('git repository probe failed:', err)
      return undefined
    }),
    loadAllSubagentTranscriptsFromDisk().catch((err): Record<string, Message[]> => {
      recordProbeError(
        'subagent transcripts could not be read from disk; the report carries only those in memory:',
        err,
      )
      return {}
    }),
  ])

  const sessionId = getSessionId()
  let rawTranscript: string | null = null
  try {
    const transcriptPath = getTranscriptPathForSession(sessionId)
    const head = historyHead(transcriptPath)
    const totalSize = head.before + (head.end - head.start)
    if (totalSize > MAX_TRANSCRIPT_READ_BYTES) {
      logForDebugging(`feedback: transcript over the read cap (${totalSize} bytes), skipped`)
    } else if (totalSize > 0) {
      rawTranscript = redactSensitiveInfo(historyRange(head, 0, totalSize).toString('utf8'))
    }
  } catch (err) {
    const code = getErrnoCode(err)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      const detail = err instanceof Error ? err.message : String(err)
      logError(err)
      errors.push({
        error: redactSensitiveInfo(`session transcript could not be read from disk: ${detail}`),
        timestamp: new Date().toISOString(),
      })
    }
  }

  const subagentTranscripts: Record<string, unknown[]> = {}
  for (const [agentId, subMessages] of Object.entries(diskSubagents)) {
    subagentTranscripts[agentId] = normalizeMessagesForAPI(subMessages)
  }
  for (const task of Object.values(backgroundTasks)) {
    const agentId = task.identity?.agentId
    if (agentId && task.messages) {
      subagentTranscripts[agentId] = normalizeMessagesForAPI(task.messages)
    }
  }

  let lastAssistantRequestId: string | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.type === 'assistant' && msg.requestId) {
      lastAssistantRequestId = msg.requestId
      break
    }
  }

  const report: Record<string, unknown> = {
    message_count: messages.length,
    datetime: new Date().toISOString(),
    description: redactSensitiveInfo(description),
    version: productVersion(),
    platform: redactSensitiveInfo(platformLine()),
    install: redactSensitiveInfo(installLine()),
    model: modelFacts(),
    is_git: isGit,
    terminal: envDynamic.terminal ?? 'unknown',
    session_id: sessionId,
    last_request_id: lastAssistantRequestId ?? getLastMainRequestId() ?? null,
    last_api_request: getLastAPIRequest(),
    errors,
    transcript: normalizeMessagesForAPI(messages),
    ...(rawTranscript !== null ? { raw_transcript: rawTranscript } : {}),
    ...(Object.keys(subagentTranscripts).length > 0 ? { subagent_transcripts: subagentTranscripts } : {}),
  }

  return { report, errors }
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

function bodyLines(body: string, width: number): string[] {
  return body.replace(/\n$/, '').split('\n').flatMap(line => wrapLine(line, width))
}

function bodyByteCount(body: string): number {
  return Buffer.byteLength(body, 'utf8')
}


function surfaceTitle(form: IssueForm | null): string {
  if (form === null) return 'Feedback — which kind?'
  switch (form.kind) {
    case 'tester':
      return 'Tester report'
    case 'bug':
      return 'Report a bug'
    case 'provider':
      return 'Report a provider or model problem'
    case 'feature':
      return 'Request a feature'
  }
}

const DRAFT_WRITE_FAILURE = {
  note: 'the draft files could not be written under the config home (see the error log)',
  remedy: 'free disk space or fix the permissions of the config home, then run the command again',
}

function keptMessage(
  activeForm: IssueForm | null,
  draftOut: { json: string; body: string } | null,
): string {
  const name = activeForm?.name ?? 'Report'
  return draftOut !== null
    ? `${name} drafted locally at ${draftOut.json} — nothing was filed.`
    : `${name} drafted locally — the draft file could not be written (see the error log); nothing was filed.`
}

function buildFormValues(
  activeForm: IssueForm,
  finalAnswers: Record<string, string>,
  healthText: string | null,
): Record<string, string> {
  const values: Record<string, string> = {}
  for (const f of activeForm.fields) {
    if (f.source === 'words' || f.source === 'ask') {
      values[f.id] = redactSensitiveInfo(finalAnswers[f.id] ?? '')
    } else if (f.source === 'health') {
      values[f.id] = redactSensitiveInfo(healthText ?? '')
    } else {
      values[f.id] = autoFieldValue(f.id)
    }
  }
  return values
}

function buildPrefilledUrl(
  activeForm: IssueForm,
  slug: string,
  finalTitle: string,
  values: Record<string, string>,
  bodyPath: string,
): string {
  const urlValues: Record<string, string> = { ...values }
  for (const f of activeForm.fields) {
    if (f.source === 'health') {
      urlValues[f.id] = healthPointer(redactSensitiveInfo(bodyPath))
    }
  }
  return redactSensitiveInfo(issueFormUrl(activeForm, { slug, title: finalTitle, values: urlValues }))
}

function descriptionOf(activeForm: IssueForm, finalAnswers: Record<string, string>): string {
  const wordsField = activeForm.fields.find(f => f.source === 'words')
  return (
    (wordsField ? finalAnswers[wordsField.id] : undefined) ??
    Object.values(finalAnswers).filter(Boolean).join('\n\n')
  )
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
  const surfaceRef = useElevatedSurface()
  const { columns, rows } = useTerminalSize()
  const slug = issueRepoSlug()
  const initialForm = kind !== undefined ? ISSUE_FORMS[kind] : null

  const [form, setForm] = useState<IssueForm | null>(initialForm)
  const [step, setStep] = useState<Step>(initialForm !== null ? 'ask' : 'kind')
  const [askIndex, setAskIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState(initialDescription)
  const [cursorOffset, setCursorOffset] = useState(initialDescription.length)
  const [title, setTitle] = useState<string | null>(null)
  const [body, setBody] = useState('')
  const [scroll, setScroll] = useState(0)
  const [paths, setPaths] = useState<{ json: string; body: string } | null>(null)
  const [access, setAccess] = useState<IssueAccess | null>(null)
  const [failure, setFailure] = useState<{ note: string; remedy: string } | null>(null)
  const [issueUrl, setIssueUrl] = useState<string | null>(null)
  const [formUrl, setFormUrl] = useState<string | null>(null)

  const draftRecordRef = useRef<Record<string, unknown> | null>(null)
  const closingMessageRef = useRef('Report closed — nothing was filed.')
  const cancelledRef = useRef(false)
  const doneRef = useRef(false)
  const preparingRef = useRef(false)
  const openingBrowserRef = useRef(false)

  useRegisterOverlay('feedback-review', step === 'review', { ownsPageKeys: true })

  const finishOnce = useCallback(
    (result: string) => {
      if (doneRef.current) return
      doneRef.current = true
      onDone(result, { display: 'system' })
    },
    [onDone],
  )

  const cancel = useCallback(() => {
    cancelledRef.current = true
    const name = form?.name ?? 'Feedback'
    finishOnce(`${name} cancelled — nothing was filed.`)
  }, [finishOnce, form])

  useKeybinding(
    'confirm:no',
    () => {
      if (step === 'review' || step === 'done' || step === 'unavailable' || step === 'failed') {
        finishOnce(closingMessageRef.current)
      } else {
        cancel()
      }
    },
    {
      context: 'Confirmation',
      isActive: step !== 'preparing' && step !== 'filing',
    },
  )

  const prepare = useCallback(
    async (activeForm: IssueForm, finalAnswers: Record<string, string>) => {
      if (preparingRef.current) return
      preparingRef.current = true
      try {
        const description = descriptionOf(activeForm, finalAnswers)
        const needsHealth = activeForm.fields.some(f => f.source === 'health')

        const [{ report, errors }, draftedTitle, healthText, accessResult] = await Promise.all([
          gatherReport(description, messages, backgroundTasks),
          activeForm.kind === 'tester'
            ? Promise.resolve(fallbackTitle(description, `${activeForm.name} from Mercury`))
            : generateTitle(activeForm, description, abortSignal),
          needsHealth ? gatherHealthSection({ signal: abortSignal }) : Promise.resolve<string | null>(null),
          checkIssueAccess(slug),
        ])

        if (cancelledRef.current || abortSignal.aborted) return

        const values = buildFormValues(activeForm, finalAnswers, healthText)
        const finalTitle = redactSensitiveInfo(fullIssueTitle(activeForm, draftedTitle))
        const finalBody = redactSensitiveInfo(composeIssueBody(activeForm, { values, recentErrors: errors }))
        const outPaths = draftPaths(activeForm.kind)
        if (outPaths === null) {
          setFailure(DRAFT_WRITE_FAILURE)
          closingMessageRef.current = keptMessage(activeForm, null)
          setStep('failed')
          return
        }

        const prefilledUrl =
          accessResult.state !== 'ok'
            ? buildPrefilledUrl(activeForm, slug, finalTitle, values, outPaths.body)
            : null

        const draftRecord: Record<string, unknown> = {
          ...report,
          kind: activeForm.kind,
          title: finalTitle,
          issue_repo: slug,
          body_path: outPaths.body,
          ...(prefilledUrl !== null ? { issue_form_url: prefilledUrl } : {}),
        }

        const wroteBody = writeDraftFile(outPaths.body, finalBody)
        const wroteJson = writeDraftFile(outPaths.json, draftJson(draftRecord))
        if (!wroteBody || !wroteJson) {
          setFailure(DRAFT_WRITE_FAILURE)
          closingMessageRef.current = keptMessage(activeForm, null)
          setStep('failed')
          return
        }

        draftRecordRef.current = draftRecord
        setPaths(outPaths)
        setTitle(finalTitle)
        setBody(finalBody)
        setScroll(0)
        setAccess(accessResult)
        setFormUrl(prefilledUrl)
        if (accessResult.state !== 'ok' && prefilledUrl !== null) {
          closingMessageRef.current = `${keptMessage(activeForm, outPaths)} The prefilled issue form (copy the link if no browser opened; it is also in the draft): ${prefilledUrl}`
          setStep('unavailable')
        } else {
          closingMessageRef.current = keptMessage(activeForm, outPaths)
          setStep('review')
        }
      } catch (err) {
        logError(err)
        if (cancelledRef.current || abortSignal.aborted) return
        const detail = err instanceof Error ? err.message : String(err)
        setFailure({
          note: `preparing the report failed: ${detail}`,
          remedy: 'run the command again',
        })
        closingMessageRef.current = keptMessage(activeForm, null)
        setStep('failed')
      }
    },
    [abortSignal, backgroundTasks, messages, slug],
  )

  const activeFields = promptedFields(form ?? ISSUE_FORMS.bug)
  const field = activeFields[askIndex] ?? activeFields[0]!

  const advance = useCallback(
    (value: string) => {
      if (form === null) return
      const fields = promptedFields(form)
      const current = fields[askIndex]
      if (current === undefined) return
      const trimmed = value.trim()
      if ((current.source === 'words' || current.required) && trimmed === '') return
      const nextAnswers = { ...answers, [current.id]: trimmed }
      setAnswers(nextAnswers)
      if (askIndex + 1 < fields.length) {
        setAskIndex(askIndex + 1)
        setDraft('')
        setCursorOffset(0)
        return
      }
      setStep('preparing')
      void prepare(form, nextAnswers)
    },
    [answers, askIndex, form, prepare],
  )

  const submit = useCallback(async () => {
    if (paths === null || title === null || form === null) return
    setStep('filing')
    const result = await fileIssue({ slug, title, bodyFile: paths.body })
    if (cancelledRef.current) return
    if (result.state === 'filed') {
      if (draftRecordRef.current !== null) {
        draftRecordRef.current = { ...draftRecordRef.current, issue_url: result.url }
        writeDraftFile(paths.json, draftJson(draftRecordRef.current))
      }
      closingMessageRef.current = `${form.name} filed at ${result.url} — the local draft is at ${paths.json}`
      setIssueUrl(result.url)
      setStep('done')
      return
    }
    setFailure({ note: result.note, remedy: result.remedy })
    closingMessageRef.current = `${form.name} not filed — ${result.note}; the draft is at ${paths.json}`
    setStep('failed')
  }, [form, paths, slug, title])

  const previewWidth = Math.max(30, columns - 10)
  const lines = bodyLines(body, previewWidth)
  const viewRows = Math.max(5, Math.min(18, rows - 16))
  const maxScroll = Math.max(0, lines.length - viewRows)
  const bytes = bodyByteCount(body)

  useInput(
    (input, key) => {
      if (step === 'review') {
        if (key.return) {
          void submit()
          return
        }
        if (key.upArrow || input === 'k') {
          setScroll(s => Math.max(0, s - 1))
          return
        }
        if (key.downArrow || input === 'j') {
          setScroll(s => Math.min(maxScroll, s + 1))
          return
        }
        if (key.pageUp) {
          setScroll(s => Math.max(0, s - Math.max(1, viewRows - 1)))
          return
        }
        if (key.pageDown) {
          setScroll(s => Math.min(maxScroll, s + Math.max(1, viewRows - 1)))
        }
        return
      }
      if (step === 'done' || step === 'failed') {
        finishOnce(closingMessageRef.current)
        return
      }
      if (step === 'unavailable') {
        if (key.return && formUrl !== null) {
          if (openingBrowserRef.current) return
          openingBrowserRef.current = true
          let browserError: string | undefined
          void openBrowser(formUrl, err => {
            browserError = err
          }).then(opened => {
            finishOnce(
              opened
                ? closingMessageRef.current
                : `${closingMessageRef.current}\n${formUrl} could not be opened (${browserError || 'could not open browser'}) — open it yourself`,
            )
          })
          return
        }
        finishOnce(closingMessageRef.current)
      }
    },
    { isActive: step === 'review' || step === 'done' || step === 'unavailable' || step === 'failed' },
  )

  return feedbackView({
    tokens,
    surfaceRef,
    columns,
    form,
    setForm,
    step,
    setStep,
    setAskIndex,
    draft,
    setDraft,
    cursorOffset,
    setCursorOffset,
    title,
    scroll,
    paths,
    access,
    failure,
    issueUrl,
    formUrl,
    cancel,
    field,
    advance,
    lines,
    viewRows,
    bytes,
    slug,
    surfaceTitle,
  })
}

export default Feedback
