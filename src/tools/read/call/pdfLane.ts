import { stat } from 'node:fs/promises'
import type { ToolUseContext } from '../../kit/tool.js'
import { isRemotePath } from '../../../platform/remote-file-target/target.js'
import { PDF_TARGET_RAW_SIZE } from '../../../models/roads/mediaLimits.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../../platform/images/imageResizer.js'
import { createUserMessage } from '../../../engine/message-shapes/factories.js'
import { extractPDFPages, readPDF, removePDFPages } from '../../kit/pdf.js'
import { extractPdfText, renderPdfText } from '../../kit/pdfText.js'
import { recognisePdfPage, renderOcr } from '../../kit/ocr.js'
import { isPDFSupported, parsePDFPageRange } from '../../kit/pdfSupport.js'
import { resolveModelCapabilities } from '../../../models/facts/capabilities.js'
import { readRegularFile } from '../regularFile.js'
import { getFsImplementation } from '../../../platform/files/fsOperations.js'
import type { ContentBlockParam } from '../../../engine/message-shapes/wire.js'
import type { FileReadingLimits } from './fileReadLimits.js'
import { MAX_PDF_PAGES_PER_REQUEST } from '../../kit/names/fileRead.js'
import { selectedPages, type Input, type Output, type LaneResult } from './schema.js'
import { parseLineRangesList } from './target.js'
import { readRichFormatLane } from './richFormatLane.js'
import { recogniseImageCaption } from './image.js'
import { passedOverAs } from '../../../platform/errors/passedOver.js'

export async function readPdfLane(
  resolvedPath: string,
  keyPath: string,
  input: Input,
  context: ToolUseContext,
  declared: FileReadingLimits,
  ownRead: boolean,
  reserve: () => FileReadingLimits,
): Promise<LaneResult> {
  const pages = selectedPages(input.pages)
  const turnModel = context.options.engineModel
  const caps = resolveModelCapabilities(turnModel)
  const document = await extractPdfText(resolvedPath, { signal: context.abortController.signal })
  const selection = pages === undefined ? undefined : parsePDFPageRange(pages)
  if (selection && selection.firstPage > document.pageCount) throw new Error(`This PDF has ${document.pageCount} pages; page ${selection.firstPage} does not exist.`)
  if (pages === undefined || !caps.media.images) {
    const selected = document.pages.filter(page => page.pageNumber >= (selection?.firstPage ?? 1) && page.pageNumber <= (selection?.lastPage ?? document.pageCount)).map(page => ({ ...page }))
    let readable = selected.some(page => page.hasTextLayer)
    let ocrFailure: string | undefined
    if (selected.some(page => !page.hasTextLayer)) {
      const bytes = await readRegularFile(resolvedPath)
      for (const page of selected) {
        if (page.hasTextLayer) continue
        const ocr = await recognisePdfPage(resolvedPath, bytes, page.pageNumber, context.abortController.signal)
        if (ocr.ok) { page.text = renderOcr(ocr); readable = true }
        else { page.text = `[${ocr.message}]`; ocrFailure = ocr.message }
      }
    }
    if (readable) {
      const ranges = input.ranges ? parseLineRangesList(input.ranges) : null
      return readRichFormatLane(resolvedPath, { kind: 'document', containerPath: resolvedPath, ext: 'pdf' }, input, Array.isArray(ranges) ? ranges : null, context, declared, ownRead, reserve, { text: renderPdfText({ ...document, pages: selected }), ownBytes: false })
    }
    if (!caps.media.pdf && ocrFailure) throw new Error(`${resolvedPath}: ${selected.some(page => page.hasImages) ? 'image-only PDF' : 'PDF has no text layer'}. ${ocrFailure}`)
  }
  if (pages !== undefined && caps.media.images) {
    const range = parsePDFPageRange(pages)
    const extraction = await extractPDFPages(resolvedPath, {
      firstPage: range?.firstPage,
      lastPage: range?.lastPage,
    })
    if (!extraction.success) {
      throw new Error(extraction.error.message)
    }
    const outputDir = extraction.data.file.outputDir
    let entries: string[]
    const blocks: ContentBlockParam[] = []
    try {
      entries = getFsImplementation()
        .readdirSync(outputDir)
        .map(entry => (typeof entry === 'string' ? entry : (entry as { name: string }).name))
        .filter(name => name.endsWith('.jpg'))
        .sort()
      for (const name of entries) {
        const pageBuffer = (await import('node:fs')).readFileSync(`${outputDir}/${name}`)
        const resized = await maybeResizeAndDownsampleImageBuffer(pageBuffer, pageBuffer.length, 'jpeg')
        const ocr = await recogniseImageCaption(pageBuffer, context.abortController)
        if (ocr !== null) blocks.push({ type: 'text', text: `${resolvedPath}: ${name}\n${ocr}` })
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: `image/${resized.mediaType}`,
            data: resized.buffer.toString('base64'),
          },
        } as ContentBlockParam)
      }
    } finally {
      await removePDFPages(outputDir)
    }
    const data: Output = {
      type: 'parts',
      file: {
        filePath: resolvedPath,
        originalSize: extraction.data.file.originalSize,
        count: entries.length,
        outputDir,
      },
    }
    if (!isRemotePath(keyPath)) context.nestedMemoryAttachmentTriggers?.add(keyPath)
    if (blocks.length > 0) {
      return { data, newMessages: [createUserMessage({ content: blocks, isMeta: true })] }
    }
    return { data }
  }

  const pageCount = document.pageCount
  if (pageCount !== null && pageCount > MAX_PDF_PAGES_PER_REQUEST) {
    throw new Error(
      `This PDF has ${pageCount} pages. Use the \`pages\` parameter to read up to ${MAX_PDF_PAGES_PER_REQUEST} pages at a time (e.g. pages: "1-${MAX_PDF_PAGES_PER_REQUEST}").`,
    )
  }
  const stats = await stat(resolvedPath)
  const pdfSupported = isPDFSupported(turnModel)
  if (!pdfSupported || stats.size > PDF_TARGET_RAW_SIZE) {
    const extraction = await extractPDFPages(resolvedPath).catch(passedOverAs(undefined))
    if (extraction?.success) await removePDFPages(extraction.data.file.outputDir)
  }
  if (!pdfSupported) {
    const pagesFallback = resolveModelCapabilities(turnModel).media.images
      ? `, or use the \`pages\` parameter to read up to ${MAX_PDF_PAGES_PER_REQUEST} pages at a time as images`
      : ` (image-based page reading is also unavailable on this model — extract the text with a shell tool such as \`pdftotext\` instead)`
    throw new Error(
      `Reading a whole PDF inline is not supported for the current model — switch to a model that takes PDF input${pagesFallback}. Page extraction requires the poppler tools (macOS: \`brew install poppler\`; Debian/Ubuntu: \`sudo apt-get install poppler-utils\`).`,
    )
  }
  const result = await readPDF(resolvedPath)
  if (!result.success) {
    throw new Error(result.error.message)
  }
  if (!isRemotePath(keyPath)) context.nestedMemoryAttachmentTriggers?.add(keyPath)
  const documentBlock: ContentBlockParam = {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: result.data.file.base64,
    },
  }
  return {
    data: result.data,
    newMessages: [createUserMessage({ content: [documentBlock], isMeta: true })],
  }
}
