import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { hostDirectory } from './store.js'
import { hostRunner, inspectBoxMachine, type HostRunner, type SshTarget } from './ssh.js'

export const boxNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,27}$/)
const engineKind = z.enum(['ollama', 'llamacpp', 'lmstudio', 'vllm', 'sglang'])
export const boxSchema = z.object({
  name: boxNameSchema,
  kind: z.enum(['this-computer', 'ssh']),
  target: z.object({ host: z.string(), user: z.string().optional(), key: z.string().optional(), port: z.number().int().min(1).max(65535).optional() }).optional(),
  os: z.enum(['darwin', 'linux', 'windows']),
  arch: z.string(), home: z.string().min(1), uid: z.number().int().nonnegative().optional(),
  memoryGb: z.number().positive(), unifiedMemory: z.boolean(),
  gpus: z.array(z.object({ name: z.string(), memory: z.number().nonnegative() })),
  engines: z.array(z.object({ kind: engineKind, path: z.string(), version: z.string(), port: z.number().int().min(1).max(65535) })),
  bankPaths: z.array(z.string()), discoveredAt: z.string(),
}).refine(box => box.kind === 'this-computer' ? !box.target : Boolean(box.target), 'SSH boxes require a target; this computer has none')
export type HostBox = z.infer<typeof boxSchema>
export type BoxInput = { name: string; kind: HostBox['kind']; target?: SshTarget; os?: HostBox['os'] }

function boxPath(name: string): string {
  boxNameSchema.parse(name)
  const dir = join(hostDirectory(), 'boxes')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return join(dir, name + '.json')
}
export function readBox(name: string): HostBox | undefined {
  try { return boxSchema.parse(JSON.parse(readFileSync(boxPath(name), 'utf8'))) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
}
export function writeBox(box: HostBox): void { durableAtomicPublishSync(boxPath(box.name), JSON.stringify(boxSchema.parse(box)) + '\n', { mode: 0o600 }) }
export function listBoxes(): HostBox[] {
  const dir = join(hostDirectory(), 'boxes')
  try { return readdirSync(dir).filter(file => file.endsWith('.json')).sort().map(file => readBox(file.slice(0, -5))!) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}
export function boxFacts(input: BoxInput, text: string): HostBox {
  const lines = text.split(/\r?\n/)
  const value = (key: string): string => lines.find(line => line.startsWith(key + ' '))?.slice(key.length + 1).trim() ?? ''
  const os = value('OS').toLowerCase()
  const arch = value('ARCH').toLowerCase()
  const memoryGb = Number(value('MEMORY')) / 1024 ** 3
  const unifiedMemory = os === 'darwin' && ['arm64', 'aarch64'].includes(arch)
  const gpus = lines.filter(line => line.startsWith('GPU ')).flatMap(line => {
    const match = /^GPU (.+),\s*([\d.]+)$/.exec(line)
    return match ? [{ name: match[1]!, memory: Number(match[2]) / 1024 }] : []
  })
  if (value('DISPLAYS')) {
    const displays = JSON.parse(value('DISPLAYS')) as { SPDisplaysDataType?: { sppci_model?: string }[] }
    for (const gpu of displays.SPDisplaysDataType ?? []) if (gpu.sppci_model) gpus.push({ name: gpu.sppci_model, memory: unifiedMemory ? memoryGb : 0 })
  }
  const engines = lines.filter(line => line.startsWith('ENGINE ')).map(line => {
    const [kind, path, version, port] = line.slice(7).split('|')
    return { kind, path, version, port: Number(port) }
  })
  return boxSchema.parse({ ...input, os, arch, home: value('HOME'), ...(value('UID') ? { uid: Number(value('UID')) } : {}), memoryGb, unifiedMemory, gpus, engines, bankPaths: lines.filter(line => line.startsWith('BANK ')).map(line => line.slice(5)), discoveredAt: new Date().toISOString() })
}
export async function discoverBox(input: BoxInput, runner: HostRunner = hostRunner, signal: AbortSignal = new AbortController().signal): Promise<HostBox> {
  boxNameSchema.parse(input.name)
  if (input.kind === 'ssh' && !input.target || input.kind === 'this-computer' && input.target) throw new Error('Choose this computer or an SSH target, not both.')
  const previous = readBox(input.name)
  if (previous && (previous.kind !== input.kind || JSON.stringify(previous.target) !== JSON.stringify(input.target))) throw new Error('That name belongs to another computer. Choose a different name.')
  const box = boxFacts(input, await inspectBoxMachine(input.target, input.os, runner, signal))
  writeBox(box)
  return box
}
export const boxHardwareWords = (box: HostBox): string => `${box.os} · ${Math.round(box.memoryGb)} GB ${box.unifiedMemory ? 'unified memory' : 'RAM'} · ${box.engines.map(engine => engine.kind + ' ' + engine.version).join(' · ') || 'no engine found'}`
