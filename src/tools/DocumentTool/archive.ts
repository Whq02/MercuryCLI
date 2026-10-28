import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { posix } from 'node:path'
import { unzipSync, strFromU8, strToU8, zipSync } from 'fflate'

export const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
export const DRAW_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
export function parseXml(xml: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Document XML must not contain a document type or entity declaration')
  const errors: string[] = []
  const doc = new DOMParser({ errorHandler: { warning: message => errors.push(message), error: message => errors.push(message), fatalError: message => errors.push(message) } }).parseFromString(xml, 'application/xml')
  if (errors.length) throw new Error(`Invalid document XML: ${errors.join('; ')}`)
  return doc
}
export const serialiseXml = (doc: Node): string => new XMLSerializer().serializeToString(doc)
export function elements(node: Document | Element, namespace: string, name: string): Element[] {
  return Array.from(node.getElementsByTagNameNS(namespace, name))
}
export function documentArchive(bytes: Uint8Array): Record<string, Uint8Array> {
  const entries = unzipSync(bytes)
  for (const name of Object.keys(entries)) if (name.startsWith('/') || name.split(/[\\/]/).includes('..')) throw new Error(`Invalid document archive entry: ${name}`)
  return entries
}
export function xmlPart(entries: Record<string, Uint8Array>, name: string): Document {
  const bytes = entries[name]
  if (!bytes) throw new Error(`Document archive lacks ${name}`)
  return parseXml(strFromU8(bytes))
}
export function setXmlPart(entries: Record<string, Uint8Array>, name: string, doc: Node): void { entries[name] = strToU8(serialiseXml(doc)) }
export const packDocument = (entries: Record<string, Uint8Array>): Uint8Array => zipSync(entries)
export function safeForOffice(bytes: Uint8Array): boolean {
  const entries = documentArchive(bytes)
  return Object.entries(entries).every(([name, content]) => {
    if (/\.(bin|vba)$/i.test(name)) return false
    if (!/\.(xml|rels)$/i.test(name)) return true
    const doc = parseXml(strFromU8(content))
    const nodes = Array.from(doc.getElementsByTagName('*'))
    if (nodes.some(node => node.getAttribute('TargetMode')?.toLowerCase() === 'external')) return false
    const instructions = (doc.documentElement.textContent ?? '') + nodes.flatMap(node => Array.from(node.attributes).map(attr => attr.value)).join(' ')
    return !/\b(?:DDEAUTO|DDE|INCLUDETEXT|INCLUDEPICTURE)\b/i.test(instructions)
  })
}
export const SLIDE_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
export function presentationSlides(entries: Record<string, Uint8Array>): string[] {
  const presentation = xmlPart(entries, 'ppt/presentation.xml')
  const relationships = xmlPart(entries, 'ppt/_rels/presentation.xml.rels')
  const map = new Map(Array.from(relationships.documentElement.childNodes).filter(n => n.nodeType === 1).map(n => { const e = n as Element; return [e.getAttribute('Id'), e] }))
  return elements(presentation, SLIDE_NS, 'sldId').map(slide => {
    const relation = map.get(slide.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'))
    if (!relation || relation.getAttribute('TargetMode') === 'External') throw new Error('Invalid presentation slide relationship')
    const path = posix.normalize(posix.join('ppt', relation.getAttribute('Target') ?? ''))
    if (!entries[path] || !path.startsWith('ppt/')) throw new Error('Presentation slide is absent or outside its package')
    return path
  })
}
