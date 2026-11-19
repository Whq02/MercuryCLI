import type { ToolEffectOutcome } from '../../../Tool.js'
import {
  activeSession,
  approveSecretPairing,
  approveWebOrigin,
  consumeCheckedActOrigin,
  driverVersion,
  noteEmulatedPage,
} from '../../../services/browser/browserSession.js'
import {
  type EmulationOutcome,
  applyEmulation,
  deviceNames,
  emulationActive,
  heldDevice,
  notePlainSize,
  parseEmulation,
} from '../../../services/browser/browserEmulation.js'
import { resolveBrowserSecret } from '../../../services/browser/browserSecrets.js'
import { noSessionWords } from './failures.js'
import { pageWhere, sendOrigin, viewportWords } from './page.js'
import { replacedSinceCheck } from './targets.js'
import { sentByEmulation } from './permissions.js'
import type { OpDone, OpRun } from './ops.js'

export async function viewportOp({ input, owner, tab, signalFor, holdSecret }: OpRun): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  const s = activeSession(owner, tab)
  if (!s) {
    result = noSessionWords(owner, tab)
    outcome = 'failed'
    return { result, outcome }
  }
  if (input.emulation !== undefined) signalFor(s).throwIfAborted()
  const held = heldDevice(s.page)
  if (input.emulation === undefined && held === null) {
    const width = Math.min(Math.max(Math.floor(input.width!), 320), 3840)
    const height = Math.min(Math.max(Math.floor(input.height!), 240), 2160)
    const dsf =
      input.deviceScaleFactor !== undefined ? Math.min(Math.max(input.deviceScaleFactor, 1), 3) : undefined
    await s.page.setViewport({ width, height, ...(dsf !== undefined ? { deviceScaleFactor: dsf } : {}) })
    notePlainSize(s.page, width, height, dsf)
    const vp = s.page.viewport()
    result = `viewport: ${vp?.width}x${vp?.height}${vp?.deviceScaleFactor ? ` @${vp.deviceScaleFactor}x` : ''} at ${pageWhere(s)}`
    outcome = 'succeeded'
    return { result, outcome }
  }
  let applied: EmulationOutcome
  if (input.emulation === undefined) {
    applied = await applyEmulation(s.page, {}, {
      width: Math.min(Math.max(Math.floor(input.width!), 320), 3840),
      height: Math.min(Math.max(Math.floor(input.height!), 240), 2160),
      ...(input.deviceScaleFactor !== undefined ? { scale: Math.min(Math.max(input.deviceScaleFactor, 1), 3) } : {}),
    })
  } else {
    const parsed = parseEmulation(input.emulation)
    if ('refusal' in parsed) {
      result = `viewport refused: ${parsed.refusal}`
      outcome = 'failed'
      return { result, outcome }
    }
    let answers = ''
    if (sentByEmulation(input) !== null) {
      const checked = consumeCheckedActOrigin(owner, input.op)
      const replaced = replacedSinceCheck(input.op, s, checked?.bound ?? null, s.page)
      if (replaced !== null) {
        result = replaced
        outcome = 'failed'
        return { result, outcome }
      }
      const judged = checked !== null && (checked.bound === null || checked.bound.tab === s.tab) ? checked.origin : null
      answers = sendOrigin(s)
      if (judged !== null && judged !== answers) {
        result = `viewport refused: the page moved from ${judged} to ${answers} between the permission check and the act — nothing done; re-issue to ask for the new origin`
        outcome = 'failed'
        return { result, outcome }
      }
      approveWebOrigin(owner, answers)
      const credentials = parsed.request.credentials
      if (credentials !== undefined && credentials !== null) {
        if (!answers.startsWith('http')) {
          result = `viewport refused: credentials answer a web origin, and this page is ${answers} content — op:"open" the site first (it fails while the site asks for credentials), set them, then op:"reload"`
          outcome = 'failed'
          return { result, outcome }
        }
        if (credentials.secret !== undefined) {
          const resolved = resolveBrowserSecret(credentials.secret, { origin: answers })
          if (resolved.state !== 'ok') {
            result = `viewport refused: ${resolved.note}`
            outcome = 'failed'
            return { result, outcome }
          }
          holdSecret({ value: resolved.value, ref: credentials.secret })
        }
      }
    }
    applied = await applyEmulation(
      s.page,
      parsed.request,
      {
        ...(input.width !== undefined ? { width: input.width } : {}),
        ...(input.height !== undefined ? { height: input.height } : {}),
        ...(input.deviceScaleFactor !== undefined ? { scale: input.deviceScaleFactor } : {}),
      },
      answers,
    )
    const paired = parsed.request.credentials?.secret
    if (paired !== undefined && applied.refusal === undefined && !applied.failures.some(line => line.startsWith('credentials'))) {
      approveSecretPairing(owner, paired, answers)
    }
  }
  if (applied.refusal !== undefined) {
    result = `viewport refused: ${applied.refusal} — nothing changed`
    outcome = 'failed'
    return { result, outcome }
  }
  if (applied.reloaded) s.nav.seen = s.nav.seq
  noteEmulatedPage(owner, emulationActive(s.page) ? s.page : null, tab)
  const kept =
    input.emulation === undefined && held !== null
      ? [
          held.device === null
            ? 'kept: the emulated mobile, touch and orientation'
            : `kept: device ${held.device} with its mobile, touch${input.deviceScaleFactor === undefined ? ', scale' : ''} and user agent`,
        ]
      : []
  const state =
    input.emulation?.reset === true && applied.lines.length === 0 && applied.failures.length === 0
      ? ['emulation: none, the launch baseline is restored']
      : []
  const stale = applied.stale ? ['note: this document was fetched before the user agent changed; op:"reload" asks the server again'] : []
  result = [
    `${viewportWords(s)} at ${pageWhere(s)}${applied.reloaded ? ' (the page was reloaded: mobile or touch changed)' : ''}`,
    ...[...kept, ...state, ...(input.emulation === undefined ? [] : applied.lines), ...applied.failures, ...stale, ...applied.notes.map(note => `note: ${note}`)].map(line => `  ${line}`),
  ].join('\n')
  outcome = applied.failures.length > 0 ? 'failed' : 'succeeded'
  return { result, outcome }
}

export async function devicesOp(): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  const names = await deviceNames()
  result = `devices: ${names.length} profiles in puppeteer-core ${driverVersion()} — pass one as emulation.device with op:"viewport"\n${names.join(', ')}`
  return { result, outcome }
}
