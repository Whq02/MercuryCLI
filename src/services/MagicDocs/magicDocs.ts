import { registerFileReadListener } from '../../tools/FileReadTool/FileReadTool.js'
import { registerPostSamplingHook } from '../../utils/hooks/postSamplingHooks.js'
import { buildMagicDocsUpdatePrompt } from './prompts.js'


void registerFileReadListener
void registerPostSamplingHook
void buildMagicDocsUpdatePrompt

const trackedDocs = new Map<string, { path: string }>()


export function clearTrackedMagicDocs(): void {
  trackedDocs.clear()
}

export async function initMagicDocs(): Promise<void> {}
