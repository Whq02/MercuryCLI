const u32 = (value: number): Buffer => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes }
const u64 = (value: number): Buffer => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes }
const text = (value: string): Buffer => { const bytes = Buffer.from(value); return Buffer.concat([u64(bytes.length), bytes]) }
export function ggufHeaderBytes(options: { architecture: string; kv?: Record<string, number>; tensors: string[] }): Buffer {
  const entries = [['general.architecture', options.architecture], ...Object.entries(options.kv ?? {})] as [string, string | number][]
  const parts = [Buffer.from('GGUF'), u32(3), u64(options.tensors.length), u64(entries.length)]
  for (const [key, value] of entries) parts.push(text(key), ...(typeof value === 'number' ? [u32(4), u32(value)] : [u32(8), text(value)]))
  for (const name of options.tensors) parts.push(text(name), u32(2), u64(4096), u64(4096), u32(0), u64(0))
  return Buffer.concat(parts)
}
