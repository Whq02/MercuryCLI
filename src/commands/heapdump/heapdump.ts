import type { LocalCommandResult } from '../../types/command.js'
import { performHeapDump } from '../../utils/heapDumpService.js'

export async function call(): Promise<LocalCommandResult> {
  const result = await performHeapDump('manual')
  if (!result.success) {
    return { type: 'text', value: `Failed to create heap dump: ${result.error ?? 'unknown error'}` }
  }
  return {
    type: 'text',
    value: `Heap snapshot: ${result.heapPath}\nDiagnostics: ${result.diagPath}`,
  }
}
