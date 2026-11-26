import { join } from 'node:path'
import type { ToolEffectOutcome, ToolUseContext } from '../../kit/tool.js'
import type { UploadSource } from '../../../integrations/browser/browserUploads.js'
import { ensureScratchpadDir } from '../../../platform/files/scratchpad.js'
import type { ToolPermissionContext } from '../../../permissions/rules/permissions.js'
import { type LiveSession, coveringLayerNote, pageWhere, targetOrigin } from './page.js'
import { actConsequences, markAct, settleAfterAct } from './settle.js'
import { actDeadline, actOriginGate, clickGate, clickGateWhenClear, heldFrameRefusal, rememberClick, resolveActTarget, settleBoundingBox } from './targets.js'
import { humanClickPoint, humanMoveTo, pickTargetPoint } from './human.js'
import { sendUpload } from './upload.js'
import type { OpDone, OpRun } from './ops.js'

export async function clickOp(s: LiveSession, { input, owner, signalFor }: OpRun): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  const originGate = await actOriginGate(owner, s, input)
  if (originGate !== null) {
    result = originGate
    outcome = 'failed'
    return { result, outcome }
  }
  s.nav.seen = s.nav.seq
  const marks = markAct(s)
  const deadline = actDeadline(input)
  let target: string
  let waited = ''
  if (input.selector) {
    const handle = await resolveActTarget(s, input.selector, deadline, signalFor(s), input.frame)
    const strayed = await heldFrameRefusal(owner, s, input.op, handle)
    if (strayed !== null) {
      result = strayed
      outcome = 'failed'
      return { result, outcome }
    }
    await handle.scrollIntoView()
    await settleBoundingBox(handle, deadline)
    const gate = input.force === true ? null : await clickGateWhenClear(s, handle, marks.at + deadline)
    const refusal = gate === null ? await clickGate(handle) : gate.clear ? null : gate.refusal
    if (refusal !== null && !(input.force === true && refusal.includes('covered by'))) {
      result = `click ${input.selector} refused: ${refusal} — nothing clicked${gate === null || gate.clear ? '' : gate.stood}${refusal.includes('covered by') ? await coveringLayerNote(s) : ''}`
      outcome = 'failed'
      return { result, outcome }
    }
    if (input.force === true && refusal !== null) await handle.evaluate(el => (el as HTMLElement).click())
    else {
      const pt = await pickTargetPoint(s, handle)
      await humanClickPoint(s, pt.x, pt.y)
    }
    rememberClick(s, handle)
    waited = gate === null || !gate.clear ? '' : gate.waited
    target = `${input.selector}${input.force === true && refusal !== null ? ' (forced DOM click)' : ''}`
  } else {
    const vp = s.page.viewport()
    if (vp && (input.x! < 0 || input.y! < 0 || input.x! >= vp.width || input.y! >= vp.height)) {
      result = `click (${input.x}, ${input.y}) refused: the point is outside the ${vp.width}x${vp.height} viewport — nothing clicked (op:"scroll" brings a target into view; op:"viewport" resizes)`
      outcome = 'failed'
      return { result, outcome }
    }
    await humanClickPoint(s, input.x!, input.y!)
    target = `(${input.x}, ${input.y})`
  }
  await settleAfterAct(s, deadline, marks)
  const after = s.page.url()
  result =
    after === marks.url
      ? `click ${target} at ${pageWhere(s)}`
      : `click ${target} — navigated to ${pageWhere(s)} (from ${marks.url}; waitFor settles late loads)`
  result += waited
  result += actConsequences(s, marks)
  outcome = 'succeeded'
  return { result, outcome }
}

export async function uploadOp(s: LiveSession, { input, owner, context, signalFor }: OpRun, checked: UploadSource[] | null): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  const judgedOrigin = await targetOrigin(s, input.frame)
  const originGate = await actOriginGate(owner, s, input)
  if (originGate !== null) {
    result = originGate
    outcome = 'failed'
    return { result, outcome }
  }
  const agentId = (context as { agentId?: string } | undefined)?.agentId
  const rules = (context as Partial<ToolUseContext> | undefined)?.getAppState?.()?.toolPermissionContext as ToolPermissionContext | undefined
  const sent = await sendUpload(s, input, checked, rules, judgedOrigin, () => join(ensureScratchpadDir(agentId), 'browser-uploads'), signalFor(s))
  result = sent.words
  outcome = sent.outcome
  return { result, outcome }
}

export async function scrollOp(s: LiveSession, { input, owner, signalFor }: OpRun): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  const originGate = await actOriginGate(owner, s, input)
  if (originGate !== null) {
    result = originGate
    outcome = 'failed'
    return { result, outcome }
  }
  s.nav.seen = s.nav.seq
  if (input.selector) {
    const handle = await resolveActTarget(s, input.selector, actDeadline(input), signalFor(s), input.frame)
    await handle.evaluate(el => (el as HTMLElement).scrollIntoView({ block: 'center' }))
    const yNow = await s.page.evaluate(() => window.scrollY)
    result = `scroll: ${input.selector} into view (scrollY ${Math.round(yNow)}) at ${pageWhere(s)}`
  } else {
    const yNow = await s.page.evaluate(delta => {
      window.scrollBy(0, delta)
      return window.scrollY
    }, input.dy!)
    result = `scroll: by ${input.dy} (scrollY now ${Math.round(yNow)}) at ${pageWhere(s)}`
  }
  outcome = 'succeeded'
  return { result, outcome }
}

export async function selectOp(s: LiveSession, { input, owner, signalFor }: OpRun): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  const originGate = await actOriginGate(owner, s, input)
  if (originGate !== null) {
    result = originGate
    outcome = 'failed'
    return { result, outcome }
  }
  s.nav.seen = s.nav.seq
  const handle = await resolveActTarget(s, input.selector!, actDeadline(input), signalFor(s), input.frame)
  const isSelect = await handle.evaluate(el => el.tagName === 'SELECT')
  if (!isSelect) {
    result = `select refused: ${input.selector} is not a <select> element — op:"type" fills text fields, op:"click" toggles checkboxes`
    outcome = 'failed'
    return { result, outcome }
  }
  let matched = await handle.select(...input.values!)
  let via = 'value'
  if (matched.length === 0) {
    const byLabel = await handle.evaluate((el, wanted: string[]) => {
      const out: string[] = []
      for (const w of wanted) {
        for (const o of Array.from((el as HTMLSelectElement).options)) {
          if ((o.label ?? '').trim() === w || (o.textContent ?? '').trim() === w) out.push(o.value)
        }
      }
      return out
    }, input.values!)
    if (byLabel.length > 0) {
      matched = await handle.select(...byLabel)
      via = 'visible label'
    }
  }
  if (matched.length === 0) {
    const options = await handle.evaluate(el =>
      Array.from((el as HTMLSelectElement).options)
        .map(o => `${o.value}="${(o.label ?? '').trim()}"`)
        .join(', '),
    )
    result = `select: no option matched [${input.values!.join(', ')}] on ${input.selector} — options: ${options}`
    outcome = 'failed'
    return { result, outcome }
  }
  const chosen = await handle.evaluate(el =>
    Array.from((el as HTMLSelectElement).selectedOptions)
      .map(o => `${o.value} "${(o.label ?? '').trim()}"`)
      .join(', '),
  )
  result = `select ${input.selector} (by ${via}): now ${chosen} at ${pageWhere(s)}`
  outcome = 'succeeded'
  return { result, outcome }
}

export async function pressOp(s: LiveSession, { input, owner }: OpRun): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  const originGate = await actOriginGate(owner, s, input)
  if (originGate !== null) {
    result = originGate
    outcome = 'failed'
    return { result, outcome }
  }
  s.nav.seen = s.nav.seq
  const mods = input.modifiers ?? []
  const pressMarks = markAct(s)
  for (const m of mods) await s.page.keyboard.down(m)
  try {
    await s.page.keyboard.press(input.key! as Parameters<typeof s.page.keyboard.press>[0])
  } finally {
    for (const m of [...mods].reverse()) await s.page.keyboard.up(m)
  }
  await settleAfterAct(s, actDeadline(input), pressMarks)
  result =
    s.page.url() === pressMarks.url
      ? `press ${[...mods, input.key].join('+')} at ${pageWhere(s)}`
      : `press ${[...mods, input.key].join('+')} — navigated to ${pageWhere(s)} (from ${pressMarks.url})`
  result += actConsequences(s, pressMarks)
  outcome = 'succeeded'
  return { result, outcome }
}

export async function hoverOp(s: LiveSession, { input, owner, signalFor }: OpRun): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  const originGate = await actOriginGate(owner, s, input)
  if (originGate !== null) {
    result = originGate
    outcome = 'failed'
    return { result, outcome }
  }
  s.nav.seen = s.nav.seq
  const handle = await resolveActTarget(s, input.selector!, actDeadline(input), signalFor(s), input.frame)
  await handle.scrollIntoView()
  const hoverPt = await pickTargetPoint(s, handle)
  await humanMoveTo(s, hoverPt)
  result = `hover ${input.selector} at ${pageWhere(s)}`
  outcome = 'succeeded'
  return { result, outcome }
}
