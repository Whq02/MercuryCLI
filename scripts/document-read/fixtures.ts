import { deflateSync } from 'node:zlib'

export function pdfFixture(pages: string[], image?: { width: number; height: number; rgb: Buffer }): Buffer {
  const objects: Buffer[] = []
  const add = (body: string | Buffer): number => { objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body)); return objects.length }
  add('<< /Type /Catalog /Pages 2 0 R >>')
  add('')
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let imageId = 0
  if (image) {
    const data = deflateSync(image.rgb)
    imageId = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]))
  }
  const ids: number[] = []
  for (const content of pages) {
    const bytes = Buffer.from(content)
    const stream = add(Buffer.concat([Buffer.from(`<< /Length ${bytes.length} >>\nstream\n`), bytes, Buffer.from('\nendstream')]))
    ids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> ${imageId ? `/XObject << /Im1 ${imageId} 0 R >>` : ''} >> /Contents ${stream} 0 R >>`))
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Count ${ids.length} /Kids [${ids.map(id => `${id} 0 R`).join(' ')}] >>`)
  const parts = [Buffer.from('%PDF-1.7\n')]
  const offsets = [0]
  let size = parts[0]!.length
  for (let i = 0; i < objects.length; i++) {
    offsets.push(size)
    const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), objects[i]!, Buffer.from('\nendobj\n')])
    parts.push(part)
    size += part.length
  }
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`))
  return Buffer.concat(parts)
}

export function textPage(text: string): string {
  return `BT /F1 12 Tf 40 740 Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET`
}
