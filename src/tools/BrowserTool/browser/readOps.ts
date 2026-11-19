import { readFileSync, writeFileSync } from 'node:fs'
import type { Frame, Page } from 'puppeteer-core'
import type { ToolEffectOutcome } from '../../../Tool.js'
import { readImageWithTokenBudget } from '../../FileReadTool/FileReadTool.js'
import { imageDimensionsOfBase64 } from '../../../utils/imageResizer.js'
import { modelReceivesImageBlocks } from '../../../utils/model/capabilities.js'
import { getEngineModel } from '../../../utils/model/model.js'
import {
  CONSOLE_RING_CAP,
  activeSession,
  isBrowserErrorPage,
  originApproved,
  originOf,
  pageKitOf,
  screenshotPath,
} from '../../../services/browser/browserSession.js'
import { emulationLines } from '../../../services/browser/browserEmulation.js'
import { noSessionWords } from './failures.js'
import {
  capExtract,
  deepTextOf,
  errorPageWords,
  frameListing,
  localClock,
  pageWhere,
  serializeAxTree,
  targetSurface,
  viewportWords,
} from './page.js'
import { firstRequestWords } from './settle.js'
import { actDeadline, resolveActTarget, resolveReadTarget } from './targets.js'
import type { OpDone, OpRun } from './ops.js'

export async function extractOp({ input, owner, tab, signalFor }: OpRun): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  const s = activeSession(owner, tab)
  if (!s) {
    result = noSessionWords(owner, tab)
    outcome = 'failed'
    return { result, outcome }
  }
  const scope = input.selector ?? 'body'
  const where = input.frame === undefined ? pageWhere(s) : targetSurface(s, input.frame).url()
  const root = input.selector ? await resolveReadTarget(s, input.selector, actDeadline(input), signalFor(s), input.frame) : null
  if ((input.mode ?? 'text') === 'text') {
    const text = root
      ? await root.evaluate(deepTextOf)
      : await targetSurface(s, input.frame).$eval('body', deepTextOf)
    result = capExtract(`extract text (${scope}) at ${where}`, `${frameListing(s)}\n${text}`, input.offset ?? 0)
  } else {
    const surface = targetSurface(s, input.frame) as Page | (Frame & Pick<Page, 'accessibility'>)
    const snapshot = await surface.accessibility.snapshot({ includeIframes: true, ...(root ? { root } : {}) })
    result = capExtract(`extract tree (${scope}) at ${where}`, `${frameListing(s)}\n${serializeAxTree(snapshot)}`, input.offset ?? 0)
  }
  return { result, outcome }
}

export async function consoleOp({ input, owner, tab }: OpRun): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  const s = activeSession(owner, tab)
  if (!s) {
    result = noSessionWords(owner, tab)
    outcome = 'failed'
    return { result, outcome }
  }
  const ring = s.consoleRing
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), CONSOLE_RING_CAP)
  const slice = ring.slice(-limit)
  result =
    slice.length === 0
      ? `console: empty (the ring keeps the last ${CONSOLE_RING_CAP} console/net/dialog entries)`
      : [
          `console: last ${slice.length} of ${ring.length} entries (console+net+dialog ring, cap ${CONSOLE_RING_CAP})`,
          ...slice.map(e => `${localClock(e.at)} ${e.kind}: ${e.text}`),
        ].join('\n')
  return { result, outcome }
}

export async function infoOp({ owner, tab }: OpRun): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  const s = activeSession(owner, tab)
  if (!s) {
    result = noSessionWords(owner, tab)
    outcome = 'failed'
    return { result, outcome }
  }
  const origin = originOf(s.page.url())
  const approval = origin.startsWith('http')
    ? originApproved(owner, origin)
      ? ' (approved this session)'
      : ' (NOT approved — acts will ask)'
    : isBrowserErrorPage(s.page.url())
      ? ` (${errorPageWords(s)})`
      : ''
  const active = emulationLines(s.page)
  result = [
    `url: ${s.page.url()}`,
    `title: ${await s.page.title()}`,
    `origin: ${origin}${approval}`,
    viewportWords(s),
    ...(active.length > 0 ? ['emulation:', ...active.map(line => `  ${line}`)] : []),
    ...(pageKitOf(s.page)?.firstRequestUnarmed ? [`note: ${firstRequestWords(s)}`] : []),
  ].join('\n')
  return { result, outcome }
}

export async function screenshotOp({ input, owner, tab, signalFor, holdImage }: OpRun): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  let inlinePath: string | undefined
  let inlineMediaType: string | undefined
  const s = activeSession(owner, tab)
  if (!s) {
    result = noSessionWords(owner, tab)
    outcome = 'failed'
    return { result, outcome, inlinePath, inlineMediaType }
  }
  const file = screenshotPath(input.label ?? new URL(s.page.url()).hostname)
  if (input.selector) {
    const handle = await resolveActTarget(s, input.selector, actDeadline(input), signalFor(s), input.frame)
    await handle.screenshot({ path: file as `${string}.png` })
  } else {
    await s.page.screenshot({ path: file as `${string}.png`, fullPage: input.fullPage === true })
  }
  holdImage(file)
  let sizeNote = ''
  const saved = imageDimensionsOfBase64(readFileSync(file).subarray(0, 48).toString('base64'))
  let shown = saved
  if (modelReceivesImageBlocks(getEngineModel())) {
    try {
      const img = await readImageWithTokenBudget(file)
      const inlineBytes = Math.floor((img.file.base64.length * 3) / 4)
      if (img.file.originalSize > inlineBytes * 1.2) {
        inlinePath = `${file}.inline`
        writeFileSync(inlinePath, Buffer.from(img.file.base64, 'base64'))
        inlineMediaType = img.file.type
        sizeNote = ` (inlined copy downscaled to the image budget: ${(img.file.originalSize / 1024).toFixed(0)}KB on disk, ~${(inlineBytes / 1024).toFixed(0)}KB inlined)`
        shown = imageDimensionsOfBase64(img.file.base64) ?? shown
      }
    } catch {
    }
  }
  const vp = s.page.viewport()
  const ratio = vp?.deviceScaleFactor || (
    !input.selector && !input.fullPage && saved !== null && vp?.width
      ? saved.width / vp.width
      : await s.page.evaluate(() => window.devicePixelRatio).catch(() => null)
  )
  let scaleNote = ''
  if (saved !== null && shown !== null && ratio !== null && ratio > 0) {
    const horizontal = Number((saved.width / ratio / shown.width).toPrecision(6))
    const vertical = Number((saved.height / ratio / shown.height).toPrecision(6))
    if (horizontal !== 1 || vertical !== 1) {
      const factor = horizontal === vertical ? `${horizontal} CSS px` : `${horizontal} CSS px horizontally, ${vertical} vertically`
      scaleNote = ` — the image is ${shown.width}x${shown.height} px for ${Math.round(saved.width / ratio)}x${Math.round(saved.height / ratio)} CSS px: 1 image px = ${factor}`
    }
  }
  result = `screenshot: ${file}${input.selector ? ` (element ${input.selector})` : ''} (${pageWhere(s)}, viewport ${vp?.width}x${vp?.height})${sizeNote}${scaleNote}`
  outcome = 'succeeded'
  return { result, outcome, inlinePath, inlineMediaType }
}
