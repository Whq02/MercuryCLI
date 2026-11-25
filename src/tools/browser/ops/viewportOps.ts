import type { ToolEffectOutcome } from '../../kit/tool.js'
import { approveSecretPairing, driverVersion, noteEmulatedPage, originApproved, sessionAttached } from '../../../integrations/browser/browserSession.js'
import {
  type EmulationOutcome,
  applyEmulation,
  deviceNames,
  emulationActive,
  heldDevice,
  notePlainSize,
  parseEmulation,
} from '../../../integrations/browser/browserEmulation.js'
import { type LiveSession, pageWhere, viewportWords } from './page.js'
import type { OpDone, OpRun } from './ops.js'

export async function viewportSizeOp(s: LiveSession, width: number, height: number, dsf: number | undefined): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  await s.page.setViewport({ width, height, ...(dsf !== undefined ? { deviceScaleFactor: dsf } : {}) })
  notePlainSize(s.page, width, height, dsf)
  const vp = s.page.viewport()
  result = `viewport: ${vp?.width}x${vp?.height}${vp?.deviceScaleFactor ? ` @${vp.deviceScaleFactor}x` : ''} at ${pageWhere(s)}`
  outcome = 'succeeded'
  return { result, outcome }
}

function locationGrantable(s: LiveSession, owner: OpRun['owner']): ((origin: string) => boolean) | null {
  return sessionAttached(s) ? origin => originApproved(owner, origin) : null
}

export async function viewportHeldOp(s: LiveSession, run: OpRun, held: ReturnType<typeof heldDevice>): Promise<OpDone> {
  const { input, owner } = run
  let applied: EmulationOutcome
  applied = await applyEmulation(s.page, {}, {
    width: Math.min(Math.max(Math.floor(input.width!), 320), 3840),
    height: Math.min(Math.max(Math.floor(input.height!), 240), 2160),
    ...(input.deviceScaleFactor !== undefined ? { scale: Math.min(Math.max(input.deviceScaleFactor, 1), 3) } : {}),
  }, '', locationGrantable(s, owner))
  return viewportAnswer(s, run, held, applied)
}

export async function viewportEmulationOp(s: LiveSession, run: OpRun, held: ReturnType<typeof heldDevice>, parsed: Extract<ReturnType<typeof parseEmulation>, { request: unknown }>, answers: string): Promise<OpDone> {
  const { input, owner } = run
  let applied: EmulationOutcome
  applied = await applyEmulation(
    s.page,
    parsed.request,
    {
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
      ...(input.deviceScaleFactor !== undefined ? { scale: input.deviceScaleFactor } : {}),
    },
    answers,
    locationGrantable(s, owner),
  )
  const paired = parsed.request.credentials?.secret
  if (paired !== undefined && applied.refusal === undefined && !applied.failures.some(line => line.startsWith('credentials'))) {
    approveSecretPairing(owner, paired, answers)
  }
  return viewportAnswer(s, run, held, applied)
}

function viewportAnswer(s: LiveSession, { input, owner, tab }: OpRun, held: ReturnType<typeof heldDevice>, applied: EmulationOutcome): OpDone {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
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
