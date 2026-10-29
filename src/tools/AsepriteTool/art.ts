import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod/v4'
import { runAseprite } from '../../services/aseprite/asepriteApp.js'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { ensureScratchpadDir } from '../../utils/scratchpad.js'
import { SPRITE_ART_LUA } from './artLuaScripts.js'

export const ART_OPS = ['draw'] as const
const integer = () => z.number().int()
const channel = () => integer().min(0).max(255)
const colour = () => z.union([
  z.strictObject({ index: integer().min(0) }),
  z.strictObject({ r: channel(), g: channel(), b: channel(), a: channel().optional() }),
])
const target = () => ({ layer: z.string().min(1), frame: integer().min(0), colour: colour(), x: integer(), y: integer() })
const corners = () => ({ x2: integer(), y2: integer() })
const stroke = () => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pixel'), ...target() }),
  z.strictObject({ kind: z.literal('line'), ...target(), ...corners() }),
  z.strictObject({ kind: z.literal('rect'), ...target(), ...corners(), fill: z.boolean().optional() }),
  z.strictObject({ kind: z.literal('ellipse'), ...target(), ...corners(), fill: z.boolean().optional() }),
  z.strictObject({ kind: z.literal('circle'), ...target(), radius: integer().min(0), fill: z.boolean().optional() }),
  z.strictObject({ kind: z.literal('flood-fill'), ...target() }),
])
export function artFields() {
  return { ops: z.array(stroke()).min(1).optional().describe('draw: ordered primitives, each with kind, layer path, 0-based frame and colour {index} or {r,g,b,a?}; rect/ellipse use inclusive x,y,x2,y2; circle uses centre x,y and radius; fill defaults false') }
}
const artSchema = () => z.strictObject({ op: z.literal('draw'), file: z.string().min(1), ops: z.array(stroke()).min(1) })
export function isArtOp(op: string): boolean { return (ART_OPS as readonly string[]).includes(op) }
export function artAsk(input: unknown): string {
  const p = artSchema().parse(input)
  return `Aseprite draw: ${p.file} - ${p.ops.map((op, i) => `${i + 1}. ${op.kind}${'fill' in op && op.fill ? ' fill' : ''} on ${op.layer} frame ${op.frame}`).join('; ')} - replaces the named sprite inside the working tree`
}
export async function runArt(input: unknown, bin: string, fence: (label: string, value: string) => { resolved?: string; refusal?: string }): Promise<{ result: string }> {
  const p = artSchema().parse(input)
  const file = fence(`${p.op}: file`, p.file)
  if (file.refusal) return { result: file.refusal }
  if (!/\.(aseprite|ase)$/i.test(file.resolved!)) throw new Error(`${p.op} needs a native .aseprite/.ase sprite`)
  const before = readFileSync(file.resolved!)
  const mode = statSync(file.resolved!).mode
  const dir = mkdtempSync(path.join(ensureScratchpadDir(), 'aseprite-'))
  try {
    const script = path.join(dir, 'program.lua')
    const request = path.join(dir, 'request.json')
    const report = path.join(dir, 'report.json')
    const save = path.join(dir, 'sprite.aseprite')
    writeFileSync(script, SPRITE_ART_LUA, { mode: 0o600 })
    writeFileSync(request, JSON.stringify({ ...p, save, report }), { mode: 0o600 })
    const r = await runAseprite(bin, [file.resolved!, '--script-param', `request=${request}`, '--script', script], {
      timeoutMs: 60_000, env: { ASEPRITE_USER_FOLDER: dir },
    })
    if (r.code !== 0) throw new Error(`exit ${r.code}${r.error ? ` (${r.error})` : ''}\n${r.stderr}\n${r.stdout}`)
    const value = JSON.parse(readFileSync(report, 'utf8')) as { op?: string; applied?: number }
    if (value.op !== p.op || value.applied !== p.ops.length) throw new Error('Aseprite returned an incomplete batch report; sprite unchanged')
    const bytes = readFileSync(save)
    if (!bytes.length) throw new Error('Aseprite saved an empty sprite; original unchanged')
    if (fence(`${p.op}: file`, p.file).resolved !== file.resolved || !readFileSync(file.resolved!).equals(before)) throw new Error('sprite changed during the batch; original not overwritten')
    durableAtomicPublishSync(file.resolved!, bytes, { mode })
    return { result: `${p.file}\n${JSON.stringify(value)}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
