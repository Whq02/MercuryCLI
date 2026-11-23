import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString } from 'pdf-lib'

export async function pdfStructure(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes)
  const outline: { level: number; title: string; page: number | null }[] = []
  const visited = new Set<PDFDict>()
  const walk = (node: PDFDict, level: number): void => {
    let current: PDFDict | undefined = node
    while (current && !visited.has(current)) {
      visited.add(current)
      const title = current.lookup(PDFName.of('Title'))
      let destination = current.lookup(PDFName.of('Dest'))
      const action = current.lookup(PDFName.of('A'))
      if (!destination && action instanceof PDFDict) destination = action.lookup(PDFName.of('D'))
      const pageRef = destination instanceof PDFArray ? destination.get(0) : undefined
      const index = pageRef ? pdf.getPages().findIndex(page => page.ref.toString() === pageRef.toString()) : -1
      if (title instanceof PDFString || title instanceof PDFHexString) outline.push({ level, title: title.decodeText(), page: index >= 0 ? index + 1 : null })
      const child = current.lookup(PDFName.of('First'))
      if (child instanceof PDFDict) walk(child, level + 1)
      const next: unknown = current.lookup(PDFName.of('Next'))
      current = next instanceof PDFDict ? next : undefined
    }
  }
  const root = pdf.catalog.lookup(PDFName.of('Outlines'))
  const first = root instanceof PDFDict ? root.lookup(PDFName.of('First')) : undefined
  if (first instanceof PDFDict) walk(first, 1)
  const images = new Set<PDFRawStream>()
  const forms = new Set<PDFDict>()
  const resources = (dict: PDFDict | undefined): void => {
    if (!dict || forms.has(dict)) return
    forms.add(dict)
    const objects = dict.lookup(PDFName.of('XObject'))
    if (!(objects instanceof PDFDict)) return
    for (const [, ref] of objects.entries()) {
      const value = pdf.context.lookup(ref)
      if (!(value instanceof PDFRawStream)) continue
      if (value.dict.lookup(PDFName.of('Subtype'))?.toString() === '/Image') images.add(value)
      const nested = value.dict.lookup(PDFName.of('Resources'))
      if (nested instanceof PDFDict) resources(nested)
    }
  }
  pdf.getPages().forEach(page => resources(page.node.Resources()))
  return { outline, images: images.size }
}
