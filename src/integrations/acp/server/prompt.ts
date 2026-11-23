import type { ContentBlock } from '@agentclientprotocol/sdk'
import {
  createComposerDocument,
  addShelfItem,
  type ComposerDocument,
} from '../../../screen/composer/input-core/composer-document.js'

interface AcpPromptMaterial {
  doc: ComposerDocument
  bodies: Map<string, string>
  images: Map<string, { mimeType: string; data: string }>
  layout: Array<{ kind: 'text'; text: string } | { kind: 'item'; id: string }>
}

export function acpPromptToComposerDocument(
  content: ReadonlyArray<ContentBlock | Record<string, unknown>>,
): AcpPromptMaterial {
  let doc = createComposerDocument('acp-prompt')
  const bodies = new Map<string, string>()
  const images = new Map<string, { mimeType: string; data: string }>()
  const layout: AcpPromptMaterial['layout'] = []
  const texts: string[] = []
  for (const item of content) {
    if (item.type === 'text' && typeof item.text === 'string') {
      texts.push(item.text)
      layout.push({ kind: 'text', text: item.text })
    } else if (item.type === 'resource_link' && typeof item.uri === 'string') {
      const path = String(item.uri).replace(/^file:\/\//, '')
      doc = addShelfItem(doc, { kind: 'file', ref: String(item.uri), label: path })
      const fileChip = doc.items.find(i => i.kind === 'file' && i.ref === String(item.uri))!
      layout.push({ kind: 'item', id: fileChip.id })
    } else if (item.type === 'resource') {
      const resource = item.resource as { uri?: string; text?: string } | undefined
      if (resource?.text !== undefined) {
        const uri = resource.uri ?? ''
        doc = addShelfItem(doc, {
          kind: 'selection',
          ref: uri,
          label: /[^/\\]+$/.exec(uri)?.[0] ?? (uri || 'selection'),
          bytes: resource.text.length,
        })
        bodies.set(doc.items[doc.items.length - 1]!.id, resource.text)
        layout.push({ kind: 'item', id: doc.items[doc.items.length - 1]!.id })
      }
    } else if (
      item.type === 'image' &&
      typeof item.data === 'string' &&
      typeof item.mimeType === 'string'
    ) {
      doc = addShelfItem(doc, {
        kind: 'image',
        ref: `acp-image:${item.mimeType}`,
        label: `Image · ${item.mimeType} · ${(item.data.length / 1024).toFixed(1)} KB`,
        bytes: item.data.length,
      })
      images.set(doc.items[doc.items.length - 1]!.id, {
        mimeType: item.mimeType,
        data: item.data,
      })
      layout.push({ kind: 'item', id: doc.items[doc.items.length - 1]!.id })
    }
  }
  doc = { ...doc, body: texts.join('\n') }
  return { doc, bodies, images, layout }
}

export function composerDocumentBlocks(m: AcpPromptMaterial): Array<Record<string, unknown>> {
  const itemsById = new Map(m.doc.items.map(i => [i.id, i]))
  const blocks: Array<Record<string, unknown>> = []
  for (const entry of m.layout) {
    if (entry.kind === 'text') {
      blocks.push({ type: 'text', text: entry.text })
      continue
    }
    const item = itemsById.get(entry.id)
    if (!item) continue
    if (item.kind === 'selection') {
      const text = m.bodies.get(item.id)
      if (text !== undefined) {
        blocks.push({
          type: 'text',
          text: `<attached-resource uri="${item.ref}">\n${text}\n</attached-resource>`,
        })
      }
    } else if (item.kind === 'file') {
      blocks.push({ type: 'text', text: `@${item.ref.replace(/^file:\/\//, '')}` })
    } else if (item.kind === 'image') {
      const image = m.images.get(item.id)
      if (image) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: image.mimeType, data: image.data },
        })
      }
    }
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
}
