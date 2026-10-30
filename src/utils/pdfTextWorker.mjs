import { parentPort, workerData } from 'node:worker_threads'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function pageLines(items) {
  const rows = []
  for (const item of items.filter(item => item.str.trim())) {
    const y = item.transform[5] ?? 0
    const height = Math.max(1, item.height)
    let row = rows.find(r => Math.abs(r.y - y) <= Math.min(r.height, height) * 0.3)
    if (!row) { row = { y, height, items: [] }; rows.push(row) }
    row.items.push(item)
  }
  rows.sort((a, b) => b.y - a.y)
  return rows.map(row => {
    const letters = item => (item.str.match(/\p{L}/gu) ?? []).length
    const rtl = row.items.reduce((sum, item) => sum + (item.dir === 'rtl' ? letters(item) : -letters(item)), 0) > 0
    row.items.sort((a, b) => (a.transform[4] - b.transform[4]) * (rtl ? -1 : 1))
    let line = ''
    let previous
    for (const item of row.items) {
      if (previous) {
        const gap = rtl ? previous.transform[4] - item.transform[4] - item.width : item.transform[4] - previous.transform[4] - previous.width
        if (gap > row.height * 1.5) line += '\t'
        else if (gap > row.height * 0.15 && !line.endsWith(' ') && !item.str.startsWith(' ')) line += ' '
      }
      line += item.str
      previous = item
    }
    return line.trim()
  }).join('\n')
}

const diagnostics = []
console.log = console.warn = (...args) => diagnostics.push(args.map(String).join(' '))
try {
  const { root, bytes } = workerData
  const api = await import(pathToFileURL(join(root, 'legacy/build/pdf.mjs')).href)
  api.GlobalWorkerOptions.workerSrc = pathToFileURL(join(root, 'legacy/build/pdf.worker.mjs')).href
  const task = api.getDocument({ data: bytes, verbosity: 1, stopAtErrors: true, isEvalSupported: false, useWorkerFetch: false, useSystemFonts: false, cMapUrl: `${root}/cmaps/`, cMapPacked: true, standardFontDataUrl: `${root}/standard_fonts/`, disableFontFace: true, isOffscreenCanvasSupported: false, isImageDecoderSupported: false })
  try {
    const doc = await task.promise
    if (diagnostics.some(line => /Indexing all PDF objects/.test(line))) throw new Error('The PDF cross-reference table is damaged.')
    const metadata = {}
    const meta = await doc.getMetadata()
    for (const [key, value] of Object.entries(meta.info ?? {})) if (typeof value === 'string') metadata[key] = value
    const pages = []
    const imageOps = new Set(Object.entries(api.OPS).filter(([key]) => /paint.*Image/.test(key)).map(([, value]) => value))
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      try {
        const content = await page.getTextContent({ disableNormalization: true })
        const text = pageLines(content.items.filter(item => typeof item.str === 'string'))
        const operators = await page.getOperatorList()
        const rawText = content.items.filter(item => typeof item.str === 'string').map(item => item.str).join('\n')
        pages.push({ pageNumber: i, text, rawText, hasTextLayer: text.trim().length > 0, hasImages: operators.fnArray.some(op => imageOps.has(op)) })
      } finally { page.cleanup() }
    }
    parentPort.postMessage({ result: { pageCount: doc.numPages, pages, metadata }, diagnostics })
  } finally { await task.destroy() }
} catch (error) {
  parentPort.postMessage({ error: error?.name === 'InvalidPDFException' ? 'Invalid or damaged PDF structure.' : error instanceof Error ? error.message : 'PDF text extraction failed.' })
}
