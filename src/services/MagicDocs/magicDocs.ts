import { registerFileReadListener } from '../../tools/FileReadTool/FileReadTool.js'
import { registerPostSamplingHook } from '../../utils/hooks/postSamplingHooks.js'
import { buildMagicDocsUpdatePrompt } from './prompts.js'


void registerFileReadListener
void registerPostSamplingHook
void buildMagicDocsUpdatePrompt

const trackedDocs = new Map<string, { path: string }>()

export function detectMagicDocHeader(content: string): { title: string; instructions?: string } | null {
  const lines = content.split(/\r?\n/)
  const marker = /^#\s*magic\s+doc:\s*(.*)$/i
  for (let index = 0; index < lines.length; index++) {
    const match = marker.exec(lines[index] as string)
    if (match === null) continue
    const title = (match[1] as string).trim()
    let next = index + 1
    if (next < lines.length && (lines[next] as string).trim() === '') next++
    const candidate = next < lines.length ? (lines[next] as string).trim() : ''
    const italic = /^[_*](.*)[_*]$/.exec(candidate)
    if (italic !== null && candidate.length >= 2) {
      const inner = (italic[1] as string).trim()
      return { title, instructions: inner }
    }
    return { title }
  }
  return null
}

export function registerMagicDoc(filePath: string): void {
  if (!trackedDocs.has(filePath)) trackedDocs.set(filePath, { path: filePath })
}

export function clearTrackedMagicDocs(): void {
  trackedDocs.clear()
}

export async function initMagicDocs(): Promise<void> {}
