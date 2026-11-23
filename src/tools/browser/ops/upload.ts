import { basename } from 'node:path'
import type { ElementHandle, Frame, Protocol } from 'puppeteer-core'
import { type ToolEffectOutcome, getEmptyToolPermissionContext } from '../../kit/tool.js'
import { MAIN_TAB, originOf, pageKitOf, sessionOfFrame } from '../../../integrations/browser/browserSession.js'
import {
  type UploadSource,
  dropStagedUpload,
  resolveUploadSources,
  stageUploads,
  uploadSourcesChanged,
} from '../../../integrations/browser/browserUploads.js'
import type { OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import { checkReadPermissionForTool, checkUncPathPermission } from '../../../permissions/rules/filesystem.js'
import type { PermissionDecision, PermissionDecisionReason, ToolPermissionContext } from '../../../permissions/rules/permissions.js'
import type { Input } from './schema.js'
import { type LiveSession, bounded, bytesWords, pageWhere } from './page.js'
import { actConsequences, markAct, settleAfterAct } from './settle.js'
import { actDeadline, clickGate, resolveActTarget, resolveReadTarget, settleBoundingBox } from './targets.js'
import { humanClickPoint, pickTargetPoint } from './human.js'
import { pollUntil, withDeadline } from '../../../platform/async/deadline.js'
import { passedOverAs } from '../../../platform/errors/passedOver.js'

const CHOOSER_WAIT_MS = 2000

interface HeldFile {
  name: string
  size: number
  type: string
}

function heldWords(files: readonly HeldFile[]): string {
  const shown = files.slice(0, 5).map(file => `${file.name} (${bytesWords(file.size)}, ${file.type === '' ? 'type unknown' : file.type})`)
  return `${fileCount(files.length)} — ${shown.join(', ')}${files.length > shown.length ? ` and ${files.length - shown.length} more` : ''}`
}

const HELD_FILES = `function () { return Array.from(this.files || []).map(function (file) { return { name: file.webkitRelativePath || file.name, size: file.size, type: file.type } }) }`

export async function sendUpload(
  s: LiveSession,
  input: Input,
  checked: UploadSource[] | null,
  rules: ToolPermissionContext | undefined,
  judgedOrigin: string | null,
  stagingRoot: () => string,
  signal: AbortSignal,
): Promise<{ words: string; outcome: ToolEffectOutcome }> {
  const refused = (why: string): { words: string; outcome: ToolEffectOutcome } => ({ words: `upload refused: ${why} — nothing sent`, outcome: 'failed' })
  const selector = input.selector!
  const given = input.files ?? []
  const resolved = resolveUploadSources(given)
  if ('refusal' in resolved) return refused(resolved.refusal)
  for (const source of resolved.sources) {
    for (const member of source.members) {
      const decision = checkReadPermissionForTool({ name: 'Read', getPath: () => member.path }, input, rules ?? getEmptyToolPermissionContext())
      if (decision.behavior === 'deny') return refused(decision.message)
    }
  }
  const changed = checked === null ? null : uploadSourcesChanged(checked, resolved.sources.filter(source => checked.some(seen => seen.given === source.given)))
  if (changed !== null) return refused(`${changed}; re-issue to have what is there now judged`)
  s.nav.seen = s.nav.seq
  const marks = markAct(s)
  const deadline = actDeadline(input)
  const after = async (words: string): Promise<{ words: string; outcome: ToolEffectOutcome }> => {
    await settleAfterAct(s, deadline, marks)
    const moved = s.page.url() === marks.url ? '' : `\n  note: the page then navigated to ${pageWhere(s)} (from ${marks.url})`
    return { words: `${words}${moved}${actConsequences(s, marks)}`, outcome: 'succeeded' }
  }
  const target = await resolveReadTarget(s, selector, deadline, signal, input.frame)
  const facts = await target.evaluate(el => {
    const field = el instanceof HTMLInputElement && el.type === 'file' ? el : null
    return {
      file: field !== null,
      multiple: field?.multiple === true,
      folder: field?.webkitdirectory === true,
      disabled: field !== null && (field.disabled || field.closest('fieldset:disabled') !== null),
      held: field?.files?.length ?? 0,
    }
  })
  const folder = resolved.sources.find(source => source.folder)
  if (facts.file) {
    if (facts.disabled) return refused(`${selector} is disabled`)
    if (given.length === 0) {
      await (target as ElementHandle<HTMLInputElement>).uploadFile()
      return after(`upload: ${selector} cleared at ${pageWhere(s)} (it held ${facts.held === 0 ? 'no file' : fileCount(facts.held)})`)
    }
    if (folder !== undefined && !facts.folder) return refused(`${folder.given} is a folder and ${selector} is not a folder input (webkitdirectory); name its files`)
    if (!facts.multiple && resolved.sources.length > 1) return refused(`${selector} takes one ${facts.folder ? 'folder' : 'file'} (it has no multiple attribute) and ${resolved.sources.length} were given`)
    const staged = await stageUploads(resolved.sources, stagingRoot(), signal)
    try {
      await (target as ElementHandle<HTMLInputElement>).uploadFile(...staged.paths)
    } catch (err) {
      await dropStagedUpload(staged.dir)
      throw err
    }
    const read = (): Promise<HeldFile[]> =>
      target.evaluate(el => Array.from((el as HTMLInputElement).files ?? []).map(file => ({ name: file.webkitRelativePath || file.name, size: file.size, type: file.type })))
    let held: HeldFile[] = []
    held = await pollUntil(
      async () => {
        held = await read()
        return held.length >= staged.files ? held : undefined
      },
      25,
      Math.min(deadline, 5000),
      () => held,
      { signal, onAbort: () => held, unref: true },
    )
    return after(`upload: ${selector} holds ${heldWords(held)} at ${pageWhere(s)} (set on the page; nothing reaches the site until the page sends it)`)
  }
  if (given.length === 0) return refused(`an empty list clears a file input, and ${selector} is not one`)
  const cdp = pageKitOf(s.page)?.cdp ?? null
  if (cdp === null) return refused('this page has no protocol session of its own to carry a drop or a file chooser')
  const handle = await resolveActTarget(s, selector, deadline, signal, input.frame)
  await handle.scrollIntoView()
  await settleBoundingBox(handle, deadline)
  const staged = await stageUploads(resolved.sources, stagingRoot(), signal)
  let delivered = false
  try {
    const point = await pickTargetPoint(s, handle)
    const realm = (handle.frame as Frame & { isolatedRealm(): Pick<Frame, 'evaluateHandle'> }).isolatedRealm()
    const probe = await realm.evaluateHandle(() => {
      const state: { over: Event | null; dropped: Event | null; taken: boolean | null; stop: () => void } = { over: null, dropped: null, taken: null, stop: () => {} }
      const over = (event: Event): void => {
        state.over = event
      }
      const dropped = (event: Event): void => {
        state.dropped = event
      }
      const last = (event: Event): void => {
        state.taken = event.defaultPrevented
        if (!event.defaultPrevented) event.preventDefault()
      }
      window.addEventListener('dragover', over, true)
      window.addEventListener('drop', dropped, true)
      window.addEventListener('drop', last, false)
      state.stop = () => {
        window.removeEventListener('dragover', over, true)
        window.removeEventListener('drop', dropped, true)
        window.removeEventListener('drop', last, false)
      }
      return state
    })
    const drag = (type: 'dragEnter' | 'dragOver' | 'drop' | 'dragCancel'): Promise<void> =>
      cdp.send('Input.dispatchDragEvent', { type, x: point.x, y: point.y, data: { items: [], files: staged.paths, dragOperationsMask: 1 } })
    let accepted: boolean | null = null
    let taken: boolean | null = null
    try {
      await drag('dragEnter')
      for (let round = 0; round < 3 && accepted === null; round++) {
        await drag('dragOver')
        accepted = await probe.evaluate(state => (state.over === null ? null : state.over.defaultPrevented))
        if (accepted === null) await bounded(40)
      }
      if (accepted === true) {
        await drag('drop')
        taken = await probe.evaluate(state => state.taken ?? (state.dropped === null ? null : state.dropped.defaultPrevented))
      } else {
        await drag('dragCancel')
      }
    } finally {
      await probe.evaluate(state => state.stop()).catch(passedOverAs(undefined))
      await probe.dispose().catch(passedOverAs(undefined))
    }
    if (accepted === true) {
      if (taken !== true) {
        return { words: `upload: ${selector} accepted the drag and did not take the drop — the page received nothing`, outcome: 'failed' }
      }
      delivered = true
      const names = resolved.sources.map(source => `${basename(source.path)}${source.folder ? ` (a folder of ${fileCount(source.members.length)})` : ` (${bytesWords(source.members[0]!.size)})`}`)
      return after(`upload: ${fileCount(staged.files)} dropped on ${selector} at ${pageWhere(s)} and taken by the page — ${names.join(', ')} (whether the site accepted them is the page’s to show)`)
    }
    const covered = await clickGate(s, handle)
    if (covered !== null) return refused(`${selector} took no dropped file, and a click to open its file chooser is refused: ${covered}`)
    let opened: Protocol.Page.FileChooserOpenedEvent | null = null
    let wake = (): void => {}
    const onOpen = (event: Protocol.Page.FileChooserOpenedEvent): void => {
      opened = event
      wake()
    }
    const own = sessionOfFrame(s.page, handle.frame) ?? cdp
    own.on('Page.fileChooserOpened', onOpen)
    await own.send('Page.enable')
    await own.send('Page.setInterceptFileChooserDialog', { enabled: true })
    try {
      const at = await pickTargetPoint(s, handle)
      await humanClickPoint(s, at.x, at.y)
      if (opened === null) {
        await withDeadline(
          new Promise<void>(resolve => {
            wake = resolve
          }),
          Math.min(deadline, CHOOSER_WAIT_MS),
          () => {},
          { signal, onAbort: () => {}, unref: true },
        )
      }
      const chooser = opened as Protocol.Page.FileChooserOpenedEvent | null
      if (chooser === null) {
        return { words: `upload: ${selector} is not a file input, took no dropped file and opened no file chooser when clicked — the click went through and nothing was sent`, outcome: 'failed' }
      }
      if (chooser.backendNodeId === undefined) {
        return { words: `upload: ${selector} asks for a file through the page’s own file picker (showOpenFilePicker), which cannot be filled — nothing sent; a file input or a drop zone takes files`, outcome: 'failed' }
      }
      const node = await own.send('DOM.resolveNode', { backendNodeId: chooser.backendNodeId })
      const objectId = node.object.objectId!
      const call = async <T>(body: string): Promise<T> => (await own.send('Runtime.callFunctionOn', { objectId, functionDeclaration: body, returnByValue: true })).result.value as T
      const cancel = (): Promise<unknown> => call('function () { this.dispatchEvent(new Event("cancel", { bubbles: true })) }').catch(passedOverAs(undefined))
      const owning = s.page.frames().find(frame => (frame as { _id?: string })._id === chooser.frameId)
      const chooserOrigin = owning === undefined ? null : originOf(owning.url())
      if (judgedOrigin !== null && chooserOrigin !== judgedOrigin) {
        await cancel()
        return refused(`the file chooser that ${selector} opened belongs to a frame of ${chooserOrigin ?? 'another page'}, which this permission check did not judge`)
      }
      const field = await call<{ multiple: boolean; folder: boolean; desc: string }>(
        'function () { return { multiple: this.multiple === true, folder: this.webkitdirectory === true, desc: this.tagName.toLowerCase() + (this.id ? "#" + this.id : "") } }',
      )
      if (folder !== undefined && !field.folder) {
        await cancel()
        return refused(`${folder.given} is a folder and ${field.desc}, which ${selector} opens a chooser for, is not a folder input (webkitdirectory); name its files`)
      }
      if (!field.multiple && resolved.sources.length > 1) {
        await cancel()
        return refused(`${field.desc}, which ${selector} opens a chooser for, takes one ${field.folder ? 'folder' : 'file'} (it has no multiple attribute) and ${resolved.sources.length} were given`)
      }
      await own.send('DOM.setFileInputFiles', { files: staged.paths, backendNodeId: chooser.backendNodeId })
      delivered = true
      let held: HeldFile[] = []
      held = await pollUntil(
        async () => {
          held = await call<HeldFile[]>(HELD_FILES)
          return held.length >= staged.files ? held : undefined
        },
        25,
        Math.min(deadline, 5000),
        () => held,
        { signal, onAbort: () => held, unref: true },
      )
      return after(`upload: ${field.desc} holds ${heldWords(held)}, chosen through the file chooser that ${selector} opened at ${pageWhere(s)} (set on the page; nothing reaches the site until the page sends it)`)
    } finally {
      own.off('Page.fileChooserOpened', onOpen)
      await own.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(passedOverAs(undefined))
    }
  } finally {
    if (!delivered) await dropStagedUpload(staged.dir)
  }
}

export function fileCount(n: number): string {
  return n === 1 ? '1 file' : `${n} files`
}

const checkedUploads = new Map<OwnerKey, { call: string; sources: UploadSource[] }>()

function uploadCall(input: Input): string {
  return JSON.stringify([input.tab ?? MAIN_TAB, input.frame ?? null, input.selector ?? '', input.files ?? []])
}

export function takeCheckedUpload(owner: OwnerKey, input: Input): UploadSource[] | null {
  const noted = checkedUploads.get(owner)
  checkedUploads.delete(owner)
  return noted !== undefined && noted.call === uploadCall(input) ? noted.sources : null
}

interface SourceAsk {
  message: string
  decisionReason: PermissionDecisionReason
}

export function judgeUploadSources(owner: OwnerKey, input: Input, context: ToolPermissionContext | undefined): { deny: PermissionDecision } | { ask: SourceAsk } | null {
  checkedUploads.delete(owner)
  const rules = context ?? getEmptyToolPermissionContext()
  const given = input.files ?? []
  const shares = given.map(file => checkUncPathPermission(file, rules))
  const refusedShare = shares.find(decision => decision?.behavior === 'deny')
  if (refusedShare) return { deny: refusedShare }
  const asks = shares.flatMap(decision => (decision?.behavior === 'ask' ? [decision] : []))
  const shareAsks = asks.length
  const resolved = resolveUploadSources(given.filter((_, index) => shares[index]?.behavior !== 'ask'))
  if (!('refusal' in resolved)) {
    const judged = resolved.sources.flatMap(source => source.members.map(member => checkReadPermissionForTool({ name: 'Read', getPath: () => member.path }, input, rules)))
    const denied = judged.find(decision => decision.behavior === 'deny')
    if (denied !== undefined) return { deny: denied }
    checkedUploads.set(owner, { call: uploadCall(input), sources: resolved.sources })
    asks.push(...judged.flatMap(decision => (decision.behavior === 'ask' ? [decision] : [])))
  }
  const first = asks[0]
  if (first === undefined) return null
  const message = [...new Set(asks.map(decision => decision.message))].join('\n')
  const reason = first.decisionReason
  return {
    ask: {
      message,
      decisionReason:
        shareAsks > 0 && asks.length > shareAsks && reason?.type === 'safetyCheck'
          ? { ...reason, reason: message }
          : reason !== undefined && (reason.type === 'rule' || reason.type === 'safetyCheck') ? reason : { type: 'safetyCheck', reason: message, operatorOnly: false },
    },
  }
}
