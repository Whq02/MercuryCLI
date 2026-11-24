import type { ToolEffectOutcome, ToolUseContext } from '../../kit/tool.js'
import {
  activeSession,
  approveWebOrigin,
  browserTransfers,
  consumeCheckedActOrigin,
  isBrowserErrorPage,
  originApproved,
  originOf,
  screenshotPath,
  sessionAttached,
} from '../../../integrations/browser/browserSession.js'
import { emulationLines, heldDevice, parseEmulation } from '../../../integrations/browser/browserEmulation.js'
import { resolveBrowserSecret } from '../../../integrations/browser/browserSecrets.js'
import type { Transfer } from '../../../integrations/browser/browserTransfers.js'
import type { OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import { type Input, PRESS_KEYS, WAIT_CAP_MS, WAIT_DEFAULT_MS } from './schema.js'
import { ATTACH_OP } from '../../../integrations/browser/browserWords.js'
import { CRASH_OPEN_OPS, crashedWords, isDriverTimeout, noSessionWords } from './failures.js'
import { type LiveSession, errorPageWords, pageWhere, preview, sendOrigin, targetSurface } from './page.js'
import { transferWords } from './downloads.js'
import { replacedSinceCheck } from './targets.js'
import { takeCheckedUpload } from './upload.js'
import { sentByEmulation } from './permissions.js'
import { backOp, openOp, reloadOp, waitForOp } from './navigateOps.js'
import { clickOp, hoverOp, pressOp, scrollOp, selectOp, uploadOp } from './pointerOps.js'
import { typeOp } from './typeOp.js'
import { devicesOp, viewportEmulationOp, viewportHeldOp, viewportSizeOp } from './viewportOps.js'
import { consoleOp, extractOp, infoOp, screenshotOp, statusOp } from './readOps.js'
import { attachOp, closeOp, downloadOp, provisionOp } from './sessionOps.js'

export interface OpRun {
  input: Input
  owner: OwnerKey
  tab: string
  context: ToolUseContext
  sessionAtEntry: LiveSession | null
  crashedAtEntry: boolean
  signalFor: (s: LiveSession) => AbortSignal
  acting: (s: LiveSession) => void
  holdSecret: (secret: { value: string; ref: string }) => void
  holdImage: (path: string) => void
  holdInline: (path: string) => void
  holdInlineType: (type: string) => void
}

export interface OpDone {
  result: string
  outcome: ToolEffectOutcome
}

export function runOp(run: OpRun): OpDone | Promise<OpDone> {
  const { input, owner, tab, context, sessionAtEntry, crashedAtEntry, signalFor, holdSecret } = run
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  switch (crashedAtEntry && !CRASH_OPEN_OPS.has(input.op) ? 'crashed' : input.op) {
    case 'crashed': {
      result = crashedWords(sessionAtEntry!, input.tab !== undefined)
      outcome = 'failed'
      break
    }
    case 'status': {
      return statusOp(run)
    }
    case 'open': {
      return openOp(run)
    }
    case ATTACH_OP: {
      return attachOp(run)
    }
    case 'click': {
      const s = activeSession(owner, tab)
      if (!s) {
        result = noSessionWords(owner, tab)
        outcome = 'failed'
        break
      }
      return clickOp(s, run)
    }
    case 'upload': {
      const s = activeSession(owner, tab)
      if (!s) {
        result = noSessionWords(owner, tab)
        outcome = 'failed'
        break
      }
      const checked = takeCheckedUpload(owner, input)
      return uploadOp(s, run, checked)
    }
    case 'type': {
      const s = activeSession(owner, tab)
      if (!s) {
        result = noSessionWords(owner, tab)
        outcome = 'failed'
        break
      }
      return typeOp(s, run)
    }
    case 'scroll': {
      const s = activeSession(owner, tab)
      if (!s) {
        result = noSessionWords(owner, tab)
        outcome = 'failed'
        break
      }
      return scrollOp(s, run)
    }
    case 'waitFor': {
      const s = activeSession(owner, tab)
      if (!s) {
        result = noSessionWords(owner, tab)
        outcome = 'failed'
        break
      }
      const deadline = Math.min(Math.max(input.timeoutMs ?? WAIT_DEFAULT_MS, 250), WAIT_CAP_MS)
      const t0 = Date.now()
      const waited = input.selector
        ? `selector ${input.selector}`
        : input.text !== undefined
          ? `text "${preview(input.text)}"`
          : 'navigation'
      if (input.selector || input.text !== undefined) {
        try {
          targetSurface(s, input.frame)
        } catch (err) {
          if (!isDriverTimeout(err)) throw err
        }
      }
      return waitForOp(s, run, deadline, t0, waited)
    }
    case 'back': {
      const s = activeSession(owner, tab)
      if (!s) {
        result = noSessionWords(owner, tab)
        outcome = 'failed'
        break
      }
      return backOp(s, run)
    }
    case 'reload': {
      const s = activeSession(owner, tab)
      if (!s) {
        result = noSessionWords(owner, tab)
        outcome = 'failed'
        break
      }
      return reloadOp(s, run)
    }
    case 'select': {
      const s = activeSession(owner, tab)
      if (!s) {
        result = noSessionWords(owner, tab)
        outcome = 'failed'
        break
      }
      return selectOp(s, run)
    }
    case 'press': {
      const s = activeSession(owner, tab)
      if (!s) {
        result = noSessionWords(owner, tab)
        outcome = 'failed'
        break
      }
      if (!PRESS_KEYS.has(input.key ?? '')) {
        result = `press refused: "${input.key}" is not in the key allowlist [${[...PRESS_KEYS].join(', ')}] — printable characters go through op:"type" (where credential fields refuse)`
        outcome = 'failed'
        break
      }
      return pressOp(s, run)
    }
    case 'hover': {
      const s = activeSession(owner, tab)
      if (!s) {
        result = noSessionWords(owner, tab)
        outcome = 'failed'
        break
      }
      return hoverOp(s, run)
    }
    case 'provision': {
      return provisionOp(run)
    }
    case 'viewport': {
      const s = activeSession(owner, tab)
      if (!s) {
        result = noSessionWords(owner, tab)
        outcome = 'failed'
        break
      }
      if (input.emulation !== undefined) signalFor(s).throwIfAborted()
      const held = heldDevice(s.page)
      if (input.emulation === undefined && held === null) {
        const width = Math.min(Math.max(Math.floor(input.width!), 320), 3840)
        const height = Math.min(Math.max(Math.floor(input.height!), 240), 2160)
        const dsf =
          input.deviceScaleFactor !== undefined ? Math.min(Math.max(input.deviceScaleFactor, 1), 3) : undefined
        return viewportSizeOp(s, width, height, dsf)
      }
      if (input.emulation === undefined) {
        return viewportHeldOp(s, run, held)
      } else {
        const parsed = parseEmulation(input.emulation)
        if ('refusal' in parsed) {
          result = `viewport refused: ${parsed.refusal}`
          outcome = 'failed'
          break
        }
        let answers = ''
        if (sentByEmulation(input) !== null) {
          const checked = consumeCheckedActOrigin(owner, input.op)
          const replaced = replacedSinceCheck(input.op, s, checked?.bound ?? null, s.page)
          if (replaced !== null) {
            result = replaced
            outcome = 'failed'
            break
          }
          const judged = checked !== null && (checked.bound === null || checked.bound.tab === s.tab) ? checked.origin : null
          answers = sendOrigin(s)
          if (judged !== null && judged !== answers) {
            result = `viewport refused: the page moved from ${judged} to ${answers} between the permission check and the act — nothing done; re-issue to ask for the new origin`
            outcome = 'failed'
            break
          }
          approveWebOrigin(owner, answers)
          const credentials = parsed.request.credentials
          if (credentials !== undefined && credentials !== null) {
            if (!answers.startsWith('http')) {
              result = `viewport refused: credentials answer a web origin, and this page is ${answers} content — op:"open" the site first (it fails while the site asks for credentials), set them, then op:"reload"`
              outcome = 'failed'
              break
            }
            if (credentials.secret !== undefined) {
              const resolved = resolveBrowserSecret(credentials.secret, { origin: answers })
              if (resolved.state !== 'ok') {
                result = `viewport refused: ${resolved.note}`
                outcome = 'failed'
                break
              }
              holdSecret({ value: resolved.value, ref: credentials.secret })
            }
          }
        }
        return viewportEmulationOp(s, run, held, parsed, answers)
      }
    }
    case 'devices': {
      return devicesOp()
    }
    case 'extract': {
      const s = activeSession(owner, tab)
      if (!s) {
        result = noSessionWords(owner, tab)
        outcome = 'failed'
        break
      }
      const scope = input.selector ?? 'body'
      const where = input.frame === undefined ? pageWhere(s) : targetSurface(s, input.frame).url()
      return extractOp(s, run, scope, where)
    }
    case 'console': {
      const s = activeSession(owner, tab)
      if (!s) {
        result = noSessionWords(owner, tab)
        outcome = 'failed'
        break
      }
      return consoleOp(s, run)
    }
    case 'info': {
      const s = activeSession(owner, tab)
      if (!s) {
        result = noSessionWords(owner, tab)
        outcome = 'failed'
        break
      }
      const origin = originOf(s.page.url())
      const approval = origin.startsWith('http')
        ? originApproved(owner, origin)
          ? ' (approved this session)'
          : sessionAttached(s)
            ? ' (NOT approved — reads and acts will ask)'
            : ' (NOT approved — acts will ask)'
        : isBrowserErrorPage(s.page.url())
          ? ` (${errorPageWords(s)})`
          : ''
      const active = emulationLines(s.page)
      return infoOp(s, origin, approval, active)
    }
    case 'screenshot': {
      const s = activeSession(owner, tab)
      if (!s) {
        result = noSessionWords(owner, tab)
        outcome = 'failed'
        break
      }
      const file = screenshotPath(input.label ?? new URL(s.page.url()).hostname)
      return screenshotOp(s, run, file)
    }
    case 'download': {
      const all = browserTransfers(owner)
      if (input.downloadId !== undefined && input.downloadId !== '') {
        const wanted = all.find(transfer => transfer.id === input.downloadId)
        if (wanted === undefined) {
          result = `no download ${input.downloadId} — op:"download" without downloadId lists the ${all.length} of this session`
          outcome = 'failed'
          break
        }
        if (wanted.state === 'pending') {
          const outer = context.abortController?.signal
          const deadline = Math.min(Math.max(input.timeoutMs ?? WAIT_DEFAULT_MS, 250), WAIT_CAP_MS)
          return downloadOp(wanted, outer, deadline)
        }
        result = `download: ${transferWords(wanted)}`
        outcome = wanted.state === 'failed' ? 'failed' : wanted.state === 'complete' ? 'succeeded' : 'no-change'
        break
      }
      const first = Math.min(Math.max(Math.floor(input.offset ?? 0), 0), all.length)
      const shown = all.slice(first, first + Math.max(Math.floor(input.limit ?? 50), 1))
      const count = (state: Transfer['state']): number => all.filter(transfer => transfer.state === state).length
      result =
        all.length === 0
          ? 'downloads: none — a download that an act starts is saved in the session scratchpad and named in that act’s answer'
          : [
              `downloads: ${all.length} (${count('complete')} complete, ${count('pending')} arriving, ${count('failed')} failed)${first > 0 ? `, from ${first}` : ''}`,
              ...shown.map(transfer => `  tab ${transfer.tab}: ${transferWords(transfer)}`),
              ...(first + shown.length < all.length ? [`  … ${all.length - first - shown.length} more — continue with offset: ${first + shown.length}`] : []),
            ].join('\n')
      break
    }
    case 'close': {
      return closeOp(run)
    }
  }
  return { result, outcome }
}
