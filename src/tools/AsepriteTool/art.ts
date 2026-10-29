import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod/v4'
import { runAseprite } from '../../services/aseprite/asepriteApp.js'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { ensureScratchpadDir } from '../../utils/scratchpad.js'
import { SPRITE_ART_LUA } from './artLuaScripts.js'

export const ART_OPS = ['draw', 'render', 'parts', 'describe', 'palette-check'] as const
const integer = () => z.number().int()
const channel = () => integer().min(0).max(255)
const rgba = () => z.strictObject({ r: channel(), g: channel(), b: channel(), a: channel().optional() })
const colour = () => z.union([z.strictObject({ index: integer().min(0) }), rgba()])
const palette = () => z.union([z.string().min(1), z.array(z.union([z.string().regex(/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/), rgba()])).min(1)])
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
const part = () => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('create'), name: z.string().min(1).regex(/^[^/]+$/), parent: z.string().min(1).optional(), group: z.boolean().optional() }),
  z.strictObject({ kind: z.literal('show'), part: z.string().min(1) }),
  z.strictObject({ kind: z.literal('hide'), part: z.string().min(1) }),
  z.strictObject({ kind: z.literal('reorder'), part: z.string().min(1), index: integer().min(0) }),
  z.strictObject({ kind: z.literal('duplicate'), part: z.string().min(1), fromFrame: integer().min(0), toFrames: z.array(integer().min(0)).min(1) }),
])
const viewing = () => ({ frame: integer().min(0).optional(), tag: z.string().min(1).optional(), scale: integer().min(1).optional() })
export function artFields() {
  return {
    ops: z.array(z.union([stroke(), part()])).min(1).optional().describe('draw: ordered primitives with kind, layer path, 0-based frame, colour {index} or {r,g,b,a?}, x,y; line/rect/ellipse add inclusive x2,y2; circle adds radius; fill defaults false. parts: ordered create/show/hide/reorder/duplicate operations'),
    frame: integer().min(0).optional().describe('render/draw/parts: 0-based frame to view; absent = all frames side by side, or tag'),
    preview: z.boolean().optional().describe('draw/parts: return a PNG render after the batch (default true); scale is a positive integer for nearest-neighbour viewing'),
    palette: palette().optional().describe('palette-check: .gpl/.hex file inside the tree, or a list of RGB(A) hex strings / {r,g,b,a?}; absent = sprite palette at each frame'),
  }
}
const artSchema = () => z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('draw'), file: z.string().min(1), ops: z.array(stroke()).min(1), preview: z.boolean().optional(), ...viewing() }),
  z.strictObject({ op: z.literal('render'), file: z.string().min(1), ...viewing() }),
  z.strictObject({ op: z.literal('parts'), file: z.string().min(1), ops: z.array(part()).min(1), preview: z.boolean().optional(), ...viewing() }),
  z.strictObject({ op: z.literal('describe'), file: z.string().min(1) }),
  z.strictObject({ op: z.literal('palette-check'), file: z.string().min(1), palette: palette().optional() }),
]).refine(p => !('frame' in p) || p.frame === undefined || p.tag === undefined, 'choose frame or tag, not both')
export type ArtResult = { result: string; preview?: { path: string; base64: string; width: number; height: number; frames: number[] } }
export function isArtOp(op: string): boolean { return (ART_OPS as readonly string[]).includes(op) }
export function isArtRead(op: string): boolean { return op === 'render' || op === 'describe' || op === 'palette-check' }
export function artAsk(input: unknown): string {
  const p = artSchema().parse(input)
  if (p.op !== 'draw' && p.op !== 'parts') throw new Error('not a mutation')
  const summary = p.ops.map((op, i) => {
    const target = 'layer' in op ? `${op.layer} frame ${op.frame}`
      : op.kind === 'create' ? `${op.parent ? `${op.parent}/` : ''}${op.name} (${op.group ? 'group' : 'layer'})`
      : op.kind === 'duplicate' ? `${op.part} frame ${op.fromFrame} to ${op.toFrames.join(',')} (replaces target cels, extends timeline)`
      : op.kind === 'reorder' ? `${op.part} to index ${op.index}` : op.part
    return `${i + 1}. ${op.kind}${'fill' in op && op.fill ? ' fill' : ''} on ${target}`
  }).join('; ')
  return `Aseprite ${p.op}: ${p.file} - ${summary} - replaces the named sprite inside the working tree`
}
export async function runArt(input: unknown, bin: string, fence: (label: string, value: string) => { resolved?: string; refusal?: string }): Promise<ArtResult> {
  const p = artSchema().parse(input)
  const file = fence(`${p.op}: file`, p.file)
  if (file.refusal) return { result: file.refusal }
  if (!/\.(aseprite|ase)$/i.test(file.resolved!)) throw new Error(`${p.op} needs a native .aseprite/.ase sprite`)
  let paletteFile: string | undefined
  let colours: Array<{ r: number; g: number; b: number; a?: number }> | undefined
  if (p.op === 'palette-check' && p.palette !== undefined) {
    if (typeof p.palette === 'string') {
      const checked = fence('palette-check: palette', p.palette)
      if (checked.refusal) return { result: checked.refusal }
      if (!/\.(gpl|hex)$/i.test(checked.resolved!)) throw new Error('palette file must be .gpl or .hex')
      paletteFile = checked.resolved
    } else colours = p.palette.map(c => {
      if (typeof c !== 'string') return c
      const hex = c.replace(/^#/, '')
      return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: hex.length === 8 ? parseInt(hex.slice(6), 16) : 255 }
    })
  }
  const before = readFileSync(file.resolved!)
  const mode = statSync(file.resolved!).mode
  const dir = mkdtempSync(path.join(ensureScratchpadDir(), 'aseprite-'))
  let preview: ArtResult['preview']
  try {
    const script = path.join(dir, 'program.lua')
    const request = path.join(dir, 'request.json')
    const report = path.join(dir, 'report.json')
    const mutation = p.op === 'draw' || p.op === 'parts'
    const save = mutation ? path.join(dir, 'sprite.aseprite') : undefined
    const render = p.op === 'render' || (mutation && p.preview !== false) ? path.join(dir, 'render.png') : undefined
    writeFileSync(script, SPRITE_ART_LUA, { mode: 0o600 })
    writeFileSync(request, JSON.stringify({ ...p, save, render, report, paletteFile, colours }), { mode: 0o600 })
    const r = await runAseprite(bin, [file.resolved!, '--script-param', `request=${request}`, '--script', script], {
      timeoutMs: 60_000, env: { ASEPRITE_USER_FOLDER: dir },
    })
    if (r.code !== 0) throw new Error(`exit ${r.code}${r.error ? ` (${r.error})` : ''}\n${r.stderr}\n${r.stdout}`)
    const value = JSON.parse(readFileSync(report, 'utf8')) as { op?: string; applied?: number; render?: { width: number; height: number; frames: number[] } }
    if (value.op !== p.op || ((p.op === 'draw' || p.op === 'parts') && value.applied !== p.ops.length)) throw new Error('Aseprite returned an incomplete batch report; sprite unchanged')
    if (render) {
      const png = readFileSync(render)
      if (!value.render || png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.readUInt32BE(16) !== value.render.width || png.readUInt32BE(20) !== value.render.height) throw new Error('Aseprite returned no valid PNG render; sprite unchanged')
      const destination = path.join(ensureScratchpadDir(), `${path.basename(dir)}.png`)
      writeFileSync(destination, png, { flag: 'wx', mode: 0o600 })
      preview = { ...value.render, path: destination, base64: png.toString('base64') }
    }
    if (save) {
      const bytes = readFileSync(save)
      if (!bytes.length) throw new Error('Aseprite saved an empty sprite; original unchanged')
      if (fence(`${p.op}: file`, p.file).resolved !== file.resolved || !readFileSync(file.resolved!).equals(before)) throw new Error('sprite changed during the batch; original not overwritten')
      durableAtomicPublishSync(file.resolved!, bytes, { mode })
    }
    return { result: `${p.file}\n${JSON.stringify(value)}${preview ? `\n${preview.path}` : ''}`, ...(preview ? { preview } : {}) }
  } catch (error) {
    if (preview) rmSync(preview.path, { force: true })
    throw error
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
