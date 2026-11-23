import { readFileSync, writeFileSync } from 'node:fs'
import type { Frame, Page } from 'puppeteer-core'
import type { ToolEffectOutcome } from '../../kit/tool.js'
import { readImageWithTokenBudget } from '../../read/ReadTool.js'
import { imageDimensionsOfBase64 } from '../../../platform/images/imageResizer.js'
import { modelReceivesImageBlocks } from '../../../models/facts/capabilities.js'
import { getEngineModel } from '../../../models/catalogue/engineModel.js'
import { CONSOLE_RING_CAP, pageKitOf } from '../../../integrations/browser/browserSession.js'
import {
  type LiveSession,
  capExtract,
  deepTextOf,
  frameListing,
  localClock,
  pageWhere,
  serializeAxTree,
  statusReport,
  targetSurface,
  viewportWords,
} from './page.js'
import { firstRequestWords } from './settle.js'
import { actDeadline, resolveActTarget, resolveReadTarget } from './targets.js'
import type { OpDone, OpRun } from './ops.js'
import { passedOver, passedOverAs } from '../../../platform/errors/passedOver.js'

export async function statusOp({ input, owner }: OpRun): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  result = await statusReport(owner, input)
  return { result, outcome }
}

export async function extractOp(s: LiveSession, { input, signalFor }: OpRun, scope: string, where: string): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
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

export function consoleOp(s: LiveSession, { input }: OpRun): OpDone {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
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

export async function infoOp(s: LiveSession, origin: string, approval: string, active: string[]): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
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

export async function screenshotOp(s: LiveSession, { input, signalFor, holdImage, holdInline, holdInlineType }: OpRun, file: string): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  let inlinePath: string | undefined
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
        holdInline(inlinePath)
        writeFileSync(inlinePath, Buffer.from(img.file.base64, 'base64'))
        holdInlineType(img.file.type)
        sizeNote = ` (inlined copy downscaled to the image budget: ${(img.file.originalSize / 1024).toFixed(0)}KB on disk, ~${(inlineBytes / 1024).toFixed(0)}KB inlined)`
        shown = imageDimensionsOfBase64(img.file.base64) ?? shown
      }
    } catch (error) {
      passedOver(error)
    }
  }
  const vp = s.page.viewport()
  const ratio = vp?.deviceScaleFactor || (
    !input.selector && !input.fullPage && saved !== null && vp?.width
      ? saved.width / vp.width
      : await s.page.evaluate(() => window.devicePixelRatio).catch(passedOverAs(null))
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
  return { result, outcome }
}
