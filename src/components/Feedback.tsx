import React, { useCallback, useRef, useState } from 'react'
import type { CommandResultDisplay } from '../commands.js'
import type { Message } from '../types/message.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useRegisterOverlay } from '../context/overlayContext.js'
import { useInput } from '../ink.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useElevatedSurface } from './mercury-ui/useElevatedSurface.js'
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
import { toPosixSeparators } from '../utils/platform/paths.js'
import { platformDisplayName } from '../utils/platform/words.js'
import { durableAtomicPublishSync } from '../substrate/durablePublish.js'
import { utilityCallFor } from '../services/model/utilityModel.js'
import { routedCallModelSettled } from '../services/providers/callModelRouter.js'
import { createUserMessage, normalizeMessagesForAPI } from '../services/messages.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import type { ToolPermissionContext } from '../Tool.js'
import {
  MAX_TRANSCRIPT_READ_BYTES,
  getTranscriptPathForSession,
  loadAllSubagentTranscriptsFromDisk,
} from '../utils/sessionStorage.js'
import { historyHead, historyRange } from '../utils/sessionStorage/historyParts.js'
import { getSessionId } from '../bootstrap/state.js'
import { openBrowser } from '../utils/browser.js'
import { logForDebugging } from '../utils/debug.js'
import { ISSUE_FORMS, composeIssueBody, healthPointer, fullIssueTitle, issueFormUrl, promptedFields, type IssueForm, type IssueKind } from '../commands/feedback/issueForms.js'
import { gatherHealthSection } from '../commands/feedback/healthSection.js'
import { checkIssueAccess, fileIssue, issueRepoSlug, type IssueAccess } from '../services/repoHost/ghIssue.js'
import { provenanceLine, resolveInstallProvenance } from '../services/privateChannel/installProvenance.js'
import { getEngineModel } from '../services/model/model.js'
import { focusedSessionModelFacts } from '../services/engine-connector/focusedConnector.js'
import { providerFamilyOfSetting } from '../services/model/modelTransition.js'
import { providerDisplayName } from '../services/providers/routeLaw.js'
import { CREDENTIAL_VALUE_PASSES } from '../constants/credentialEnvSpellings.js'
import { feedbackView, type Step } from './feedback/feedbackView.js'
import { getErrnoCode } from '../utils/errors.js'
import { passedOver } from '../utils/passedOver.js'
import { withDeadline } from '../utils/deadline.js'
import { notBuilt } from '../pi/holes.js'


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
  return notBuilt('src/components/Feedback.tsx:235')
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

export function Feedback(arg0: {
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
  return notBuilt('src/components/Feedback.tsx:386')
}

export default Feedback
