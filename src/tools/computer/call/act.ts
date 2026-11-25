import { basename } from 'node:path'
import { pollUntil } from '../../../platform/async/deadline.js'
import { sleep } from '../../../platform/async/sleep.js'
import type {
  DesktopAnswer,
  DesktopApplication,
  DesktopDriver,
  DesktopError,
  DesktopModifier,
  DesktopPoint,
} from '../../../integrations/desktop/driver.js'
import { isKeyChordRefusal, parseKeyChord } from '../keyChord.js'
import { targetWords, withOrdinal } from '../fastRoad.js'
import { dialogCounts } from '../waitCondition.js'
import {
  FIELD_VALUE_CHARS,
  FILE_CLOSE_MS,
  FILE_DIALOG_MS,
  FILE_KEY_GAP_MS,
  type Input,
  type ModelModifier,
  TREE_DEPTH_CAP,
  TREE_LIMIT_CAP,
  WAIT_CAP_MS,
  clamp,
} from './schema.js'
import type { ActPlan } from './plan.js'

function startWords(input: Input): string {
  return input.ref !== undefined ? `ref:${input.ref}` : input.target ? targetWords(input.target) : `(${input.x}, ${input.y})`
}

function endWords(input: Input): string {
  return input.toTarget ? targetWords(input.toTarget) : `(${input.toX}, ${input.toY})`
}

export function pixelWordsOf(input: Input, point: DesktopPoint, plan: ActPlan): string {
  if (plan.target !== null && point === plan.target) return `${endWords(input)}`
  return `${startWords(input)}`
}

function modifierWords(modifiers: readonly ModelModifier[] | undefined): string {
  return modifiers && modifiers.length > 0 ? ` +${modifiers.join('+')}` : ''
}

export function actDetail(input: Input): string {
  switch (input.action) {
    case 'click':
    case 'doubleClick':
    case 'rightClick':
    case 'move':
      return ` ${startWords(input)}${modifierWords(input.modifiers)}`
    case 'drag':
      return ` ${startWords(input)} → ${endWords(input)}${modifierWords(input.modifiers)}`
    case 'scroll':
      return ` by ${input.dx ?? 0}, ${input.dy ?? 0} at ${startWords(input)}${modifierWords(input.modifiers)}`
    case 'focusApp':
      return ` ${input.focusApp?.name ?? ''}`
    case 'type':
      return ` ${(input.text ?? '').length} chars`
    case 'fill':
      return ` ${startWords(input)} ${(input.text ?? '').length} chars`
    case 'file':
      return ` ${startWords(input)} ← ${basename(input.path ?? '')}`
    case 'key':
    case 'hold':
      return ` ${input.key ?? ''}`
    default:
      return ''
  }
}

export function faultNote(note: string): string {
  if (!note.includes('\n') && !note.includes('Command failed:')) return note
  const lines = note.split('\n').map(line => line.trim())
  const head = lines[0]!.replace(/:?\s*Command failed:.*$/, '').trim()
  const reason = lines.find(line => /^[A-Za-z]*Error:\s/.test(line))?.replace(/^[A-Za-z]*Error:\s*/, '').replace(/\/[^\s'"`)]+/g, '<path>')
  const code = /\bcode:\s*'([^']+)'/.exec(note)?.[1]
  return `${head || 'the native reader failed'}${reason ? ` — ${reason}` : ''}${code ? ` (${code})` : ''}`.slice(0, 300)
}

export function faultText(action: string, error: DesktopError): string {
  return `${action} failed: ${faultNote(error.note)}${error.remedy ? ` — ${error.remedy}` : ''}`
}

export type ActWords = { ok: true; words: string } | { ok: false; aborted: boolean; text: string }

class ActRun {
  fault: ActWords | null = null
  constructor(
    readonly driver: DesktopDriver,
    readonly action: string,
    readonly signal: AbortSignal,
  ) {}

  async step<T>(answer: Promise<DesktopAnswer<T>>): Promise<T | null> {
    const settled = await answer
    if (settled.ok) return settled.value
    this.fault =
      settled.error.kind === 'aborted'
        ? { ok: false, aborted: true, text: '' }
        : { ok: false, aborted: false, text: faultText(this.action, settled.error) }
    return null
  }

  async down(modifiers: readonly DesktopModifier[]): Promise<boolean> {
    for (const modifier of modifiers) {
      if ((await this.step(this.driver.keyDown(modifier, this.signal))) === null) return false
    }
    return true
  }

  async up(modifiers: readonly DesktopModifier[]): Promise<boolean> {
    for (const modifier of [...modifiers].reverse()) {
      if ((await this.step(this.driver.keyUp(modifier, this.signal))) === null) return false
    }
    return true
  }

  failed(): ActWords {
    return this.fault ?? { ok: false, aborted: false, text: `${this.action} failed: the desktop driver answered nothing` }
  }
}

function scrolledWords(plan: ActPlan): string {
  return `${plan.scrolled ? ` · scrolled into view first (${plan.scrolled})` : ''}${plan.aimed ? ` · ${plan.aimed}` : ''}${plan.returned ? ` · ${plan.returned}` : ''}`
}

export function pointWords(point: DesktopPoint): string {
  return `(${point.x}, ${point.y}) pt`
}

function fileDialogKeys(path: string): Array<{ key: string } | { text: string }> {
  if (process.platform === 'win32') return [{ text: path }, { key: 'Enter' }]
  return [{ key: process.platform === 'darwin' ? 'cmd+shift+g' : 'ctrl+l' }, { text: path }, { key: 'Enter' }]
}

async function readDialogs(driver: DesktopDriver, signal: AbortSignal): Promise<Map<string, number> | null> {
  const front = await driver.frontmostApplication()
  if (!front.ok) return null
  const tree = await driver.accessibilityTree(front.value, { depth: TREE_DEPTH_CAP, count: TREE_LIMIT_CAP, scope: 'window' }, signal)
  if (!tree.ok) return null
  return dialogCounts(tree.value)
}

function hasNewDialog(current: ReadonlyMap<string, number>, baseline: ReadonlyMap<string, number>): boolean {
  for (const [key, count] of current) {
    if (count > (baseline.get(key) ?? 0)) return true
  }
  return false
}

async function dialogOpen(driver: DesktopDriver, signal: AbortSignal, baseline: ReadonlyMap<string, number>): Promise<boolean | null> {
  const current = await readDialogs(driver, signal)
  return current === null ? null : hasNewDialog(current, baseline)
}

async function awaitDialog(driver: DesktopDriver, signal: AbortSignal, open: boolean, deadline: number, baseline: ReadonlyMap<string, number>): Promise<'met' | 'unmet' | 'unread'> {
  let read = false
  return pollUntil<'met' | 'unmet' | 'unread', 'unmet' | 'unread', 'unmet' | 'unread'>(
    async () => {
      const state = await dialogOpen(driver, signal, baseline)
      read ||= state !== null
      if (state === open) return 'met'
      if (signal.aborted) return read ? 'unmet' : 'unread'
      return undefined
    },
    left => Math.min(100, left),
    Math.max(0, deadline - Date.now()),
    () => (read ? 'unmet' : 'unread'),
    { signal, onAbort: () => (read ? 'unmet' : 'unread') },
  )
}

async function performFile(driver: DesktopDriver, input: Input, plan: ActPlan, signal: AbortSignal): Promise<ActWords> {
  const run = new ActRun(driver, 'file', signal)
  const path = input.path!
  const before = (await readDialogs(driver, signal)) ?? (plan.beforeTree ? dialogCounts(plan.beforeTree) : new Map<string, number>())
  if (signal.aborted) return { ok: false, aborted: true, text: '' }
  if ((await run.step(driver.click(plan.point!, 'left', 1, signal))) === null) return run.failed()
  const pause = clamp(input.durationMs ?? FILE_DIALOG_MS, 0, WAIT_CAP_MS)
  const opened = await awaitDialog(driver, signal, true, Date.now() + pause, before)
  if (opened === 'unread') return { ok: false, aborted: signal.aborted, text: `file failed: the window's tree could not be read, so whether ${startWords(input)} opened a file dialog is unknown — nothing typed; take a screenshot and drive the dialog with key and type` }
  if (opened === 'unmet') return { ok: false, aborted: signal.aborted, text: `file failed: ${startWords(input)} opened no file dialog within ${pause}ms — nothing typed; take a screenshot and re-issue` }
  for (const step of fileDialogKeys(path)) {
    await sleep(FILE_KEY_GAP_MS, signal)
    if ('key' in step) {
      const chord = parseKeyChord(step.key)
      if (isKeyChordRefusal(chord)) return { ok: false, aborted: false, text: `file failed: ${chord.reason}` }
      if ((await run.step(driver.keyTap(chord.key, chord.modifiers, signal))) === null) return run.failed()
    } else if ((await run.step(driver.typeText(step.text, {}, signal))) === null) return run.failed()
  }
  const closed = Date.now() + FILE_CLOSE_MS
  if ((await awaitDialog(driver, signal, false, Date.now() + FILE_KEY_GAP_MS * 2, before)) !== 'met') {
    const enter = parseKeyChord('Enter')
    if (!isKeyChordRefusal(enter) && (await run.step(driver.keyTap(enter.key, enter.modifiers, signal))) === null) return run.failed()
  }
  const gone = await awaitDialog(driver, signal, false, closed, before)
  if (gone === 'unread') return { ok: false, aborted: signal.aborted, text: `file failed: the window's tree could not be read after ${path}, so whether the dialog closed is unknown — take a screenshot` }
  if (gone === 'unmet') return { ok: false, aborted: signal.aborted, text: `file failed: the file dialog is still open after ${path} — it may not accept that path; take a screenshot` }
  return { ok: true, words: `file ${startWords(input)} ← ${basename(path)} → ${pointWords(plan.point!)}${scrolledWords(plan)} · the dialog opened and closed` }
}

function valueWords(value: string | null): string {
  return value === null ? 'value not read back' : `value ${JSON.stringify(value.length > FIELD_VALUE_CHARS ? `${value.slice(0, FIELD_VALUE_CHARS)}…` : value)}`
}

async function performFill(driver: DesktopDriver, input: Input, plan: ActPlan, front: DesktopApplication, signal: AbortSignal): Promise<ActWords> {
  const run = new ActRun(driver, 'fill', signal)
  const element = plan.beforeTree ? withOrdinal(plan.beforeTree, plan.element!) : plan.element!
  const text = input.text!
  if (driver.setValue) {
    const set = await run.step(driver.setValue(front, element, text, signal))
    if (set === null) return run.failed()
    if (set.set) return { ok: true, words: `fill ${startWords(input)} ← ${text.length} chars → ${valueWords(set.value)}${set.note ? ` · ${set.note}` : ''}${scrolledWords(plan)}` }
  }
  if ((await run.step(driver.click(plan.point!, 'left', 1, signal))) === null) return run.failed()
  const all = parseKeyChord(process.platform === 'darwin' ? 'cmd+a' : 'ctrl+a')
  if (isKeyChordRefusal(all)) return { ok: false, aborted: false, text: `fill failed: ${all.reason}` }
  if ((await run.step(driver.keyTap(all.key, all.modifiers, signal))) === null) return run.failed()
  if ((await run.step(driver.typeText(text, {}, signal))) === null) return run.failed()
  let value: string | null = null
  if (driver.readElement) {
    const read = await driver.readElement(front, element, signal)
    if (read.ok && read.value) value = read.value.text
  }
  return { ok: true, words: `fill ${startWords(input)} ← ${text.length} chars by keystrokes → ${valueWords(value)}${scrolledWords(plan)}` }
}

export async function performAct(driver: DesktopDriver, input: Input, plan: ActPlan, front: DesktopApplication, signal: AbortSignal): Promise<ActWords> {
  const run = new ActRun(driver, input.action, signal)
  if (signal.aborted) return { ok: false, aborted: true, text: '' }
  switch (input.action) {
    case 'file':
      return performFile(driver, input, plan, signal)
    case 'fill':
      return performFill(driver, input, plan, front, signal)
    case 'click':
    case 'doubleClick':
    case 'rightClick': {
      if (!(await run.down(plan.modifiers))) return run.failed()
      const button = input.action === 'rightClick' ? 'right' : 'left'
      const count = input.action === 'doubleClick' ? 2 : input.action === 'click' ? (input.count ?? 1) as 1 | 2 | 3 : 1
      if ((await run.step(driver.click(plan.point!, button, count, signal))) === null) return run.failed()
      if (!(await run.up(plan.modifiers))) return run.failed()
      return { ok: true, words: `${input.action} ${startWords(input)}${input.count && input.count > 1 ? ` ×${input.count}` : ''}${modifierWords(input.modifiers)} → ${pointWords(plan.point!)}${scrolledWords(plan)}` }
    }
    case 'move': {
      if ((await run.step(driver.mouseMove(plan.point!, signal))) === null) return run.failed()
      return { ok: true, words: `move ${startWords(input)} → ${pointWords(plan.point!)}${scrolledWords(plan)}` }
    }
    case 'drag': {
      if (!(await run.down(plan.modifiers))) return run.failed()
      if ((await run.step(driver.drag(plan.point!, plan.target!, 'left', signal))) === null) return run.failed()
      if (!(await run.up(plan.modifiers))) return run.failed()
      return {
        ok: true,
        words: `drag ${startWords(input)} → ${endWords(input)}${modifierWords(input.modifiers)} · ${pointWords(plan.point!)} → ${pointWords(plan.target!)}${scrolledWords(plan)}`,
      }
    }
    case 'scroll': {
      if (!(await run.down(plan.modifiers))) return run.failed()
      if ((await run.step(driver.scroll(plan.point!, input.dx ?? 0, input.dy ?? 0, signal))) === null) return run.failed()
      if (!(await run.up(plan.modifiers))) return run.failed()
      return {
        ok: true,
        words: `scroll ${startWords(input)} by ${input.dx ?? 0}, ${input.dy ?? 0}${modifierWords(input.modifiers)} → ${pointWords(plan.point!)}${scrolledWords(plan)}`,
      }
    }
    case 'type': {
      if ((await run.step(driver.typeText(input.text!, {}, signal))) === null) return run.failed()
      return { ok: true, words: `type ${input.text!.length} chars` }
    }
    case 'key': {
      if ((await run.step(driver.keyTap(plan.chord!.key, plan.chord!.modifiers, signal))) === null) return run.failed()
      return { ok: true, words: `key ${input.key}` }
    }
    case 'hold': {
      const chord = plan.chord!
      if (!(await run.down(chord.modifiers))) return run.failed()
      if ((await run.step(driver.keyDown(chord.key, signal))) === null) return run.failed()
      await sleep(input.durationMs!, signal)
      if (signal.aborted) return { ok: false, aborted: true, text: '' }
      if ((await run.step(driver.keyUp(chord.key, signal))) === null) return run.failed()
      if (!(await run.up(chord.modifiers))) return run.failed()
      return { ok: true, words: `hold ${input.key} ${input.durationMs}ms` }
    }
    default:
      return { ok: false, aborted: false, text: `${input.action} is not an act` }
  }
}
