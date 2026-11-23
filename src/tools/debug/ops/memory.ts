import type { DapSession } from '../../../integrations/debugger/dapClient.js'
import type { Input, InputWith, OpResult } from './schema.js'

export async function disassembleOp(r: { root: DapSession; target: DapSession }, input: Input, count: number): Promise<OpResult> {
  const body = await r.target.request('disassemble', {
    memoryReference: input.memoryReference,
    offset: input.offset ?? 0,
    instructionOffset: 0,
    instructionCount: count,
    resolveSymbols: true,
  })
  const instructions = Array.isArray(body.instructions)
    ? (body.instructions as Array<{
        address?: string
        instruction?: string
        instructionBytes?: string
        symbol?: string
        location?: { path?: string }
        line?: number
      }>)
    : []
  return {
    result: instructions.length
      ? instructions
          .map(
            i =>
              `${i.address ?? '?'}: ${i.instruction ?? '?'}` +
              (i.symbol ? ` <${i.symbol}>` : '') +
              (i.location?.path && i.line !== undefined ? `  ; ${i.location.path}:${i.line}` : ''),
          )
          .join('\n')
      : '(no instructions returned)',
    outcome: 'no-change',
  }
}

export async function readMemoryOp(r: { root: DapSession; target: DapSession }, input: Input, count: number): Promise<OpResult> {
  const body = await r.target.request('readMemory', {
    memoryReference: input.memoryReference,
    offset: input.offset ?? 0,
    count,
  })
  const data = typeof body.data === 'string' ? Buffer.from(body.data, 'base64') : Buffer.alloc(0)
  const address = String(body.address ?? input.memoryReference)
  const unreadable = typeof body.unreadableBytes === 'number' ? body.unreadableBytes : 0
  if (data.length === 0) {
    return {
      result: `readMemory at ${address}: 0 bytes readable${unreadable ? ` (${unreadable} unreadable)` : ''}`,
      outcome: 'no-change',
    }
  }
  const rows: string[] = []
  for (let i = 0; i < data.length; i += 16) {
    const slice = data.subarray(i, i + 16)
    const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = [...slice].map(b => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')
    rows.push(`+0x${i.toString(16).padStart(4, '0')}  ${hex.padEnd(47)}  ${ascii}`)
  }
  return {
    result:
      `memory at ${address} (${data.length} bytes${unreadable ? `, ${unreadable} unreadable` : ''}):\n` +
      rows.join('\n'),
    outcome: 'no-change',
  }
}

export async function writeMemoryOp(r: { root: DapSession; target: DapSession }, input: InputWith<'memoryReference'>, bytes: Buffer): Promise<OpResult> {
  const receipt = await r.target.writeMemory({
    memoryReference: input.memoryReference,
    data: bytes.toString('base64'),
    offset: input.offset,
    allowPartial: input.allowPartial,
  })
  const where = `${input.memoryReference}${input.offset ? ` (offset ${input.offset})` : ''}`
  const written = receipt.bytesWritten
  if (written === 0) {
    return { result: `writeMemory at ${where}: 0 of ${bytes.length} bytes written — nothing changed`, outcome: 'no-change' }
  }
  const count =
    written === undefined
      ? `${bytes.length} bytes sent (adapter reported no byte count)`
      : written < bytes.length
        ? `${written} of ${bytes.length} bytes written (partial)`
        : `${written} bytes written`
  return {
    result: `writeMemory at ${where}: ${count} [debuggee state mutated]`,
    outcome: 'succeeded',
    debuggee: r.target.lastStopped ? 'stopped' : 'running',
    details: { requestedBytes: bytes.length, ...(written !== undefined ? { bytesWritten: written } : {}) },
  }
}

export async function setVariableOp(r: { root: DapSession; target: DapSession }, input: Input): Promise<OpResult> {
  const body = await r.target.request('setVariable', {
    variablesReference: input.variablesReference,
    name: input.name,
    value: input.value,
  })
  return {
    result: `${input.name} = ${String(body.value ?? input.value)}${body.type ? ` (${String(body.type)})` : ''} [debuggee state mutated]`,
    outcome: 'succeeded',
    debuggee: r.target.lastStopped ? 'stopped' : 'running',
  }
}
