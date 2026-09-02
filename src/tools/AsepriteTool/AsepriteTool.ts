// ============================================================================
//  Aseprite tool — the agent-facing surface of the Aseprite batch door
//  (services/aseprite/asepriteApp.ts owns location + the one spawn shape;
//  the BrowserTool is the schema grammar this mirrors — flat typed fields —
//  and the BlenderTool the permission grammar). Catalog-gated by
//  asepriteToolCatalogEnabled() in tools.ts (the one Aseprite switch
//  MERCURY_ASEPRITE + a sprite context or a located app). No live bridge:
//  every op is one bounded `aseprite -b` run — the GUI is never launched.
//  Permission classes: status/info ⇒ allow (reads), export/create ⇒ ask
//  naming source and destination(s), run-script ⇒ ask ALWAYS (the
//  python_run class — byte count + first line in the ask). PATH FENCE:
//  info/export/create paths resolve against the working directory and must
//  stay inside it — run-script (behind its own ask) is the out-of-tree
//  road. Proofs: scripts/aseprite/.
// ============================================================================

import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import {
  ASEPRITE_INSTALL_REMEDY,
  discoverSpriteFiles,
  probeAsepriteVersion,
  resolveAseprite,
  runAseprite,
  type AsepriteResolution,
} from '../../services/aseprite/asepriteApp.js'
import { ASEPRITE_TOOL_NAME, getAsepriteToolDescription } from './prompt.js'
import { SPRITE_CREATE_LUA, SPRITE_PROBE_LUA } from './luaScripts.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

const OPS = ['status', 'info', 'export', 'create', 'run-script'] as const

const SHEET_TYPES = ['horizontal', 'vertical', 'rows', 'columns', 'packed'] as const

const inputSchema = lazySchema(() =>
  z.strictObject({
    op: z.enum(OPS).describe('status · info · export · create · run-script'),
    file: z
      .string()
      .optional()
      .describe('info/export: the sprite file (.aseprite/.ase; context-relative, fenced inside the working tree). run-script: optional sprite to open first (not fenced — the ask names it)'),
    output: z
      .string()
      .optional()
      .describe('export/create: destination file (context-relative, fenced; export split modes may use {layer}/{tag}/{frame} templates)'),
    scale: z.number().optional().describe('export: resize factor applied before saving (2 = double size)'),
    layer: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe('export: include ONLY these layers'),
    ignoreLayer: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe('export: exclude these layers'),
    allLayers: z.boolean().optional().describe('export: include hidden layers too'),
    tag: z.string().optional().describe('export: only the frames of this animation tag'),
    frameRange: z
      .string()
      .optional()
      .describe('export: "from,to" frame window, 0-based (the CLI counts frames from 0)'),
    splitLayers: z.boolean().optional().describe('export: one file per layer ({layer} template in output)'),
    splitTags: z.boolean().optional().describe('export: one file per tag ({tag} template in output)'),
    sheetType: z
      .enum(SHEET_TYPES)
      .optional()
      .describe('export: sprite-sheet layout — its presence (or dataOutput) selects the sheet road; absent = plain save-as'),
    sheetColumns: z.number().optional().describe('export sheet: fixed column count (sheetType rows)'),
    sheetRows: z.number().optional().describe('export sheet: fixed row count (sheetType columns)'),
    dataOutput: z.string().optional().describe('export sheet: JSON metadata destination (fenced)'),
    dataFormat: z.enum(['json-hash', 'json-array']).optional().describe('export sheet: metadata shape (default json-hash)'),
    trim: z.boolean().optional().describe('export: trim the sprite (save-as) or each frame (sheet)'),
    ignoreEmpty: z.boolean().optional().describe('export: drop empty frames'),
    mergeDuplicates: z.boolean().optional().describe('export sheet: merge duplicate frames'),
    borderPadding: z.number().optional().describe('export sheet: padding at the texture border (px)'),
    shapePadding: z.number().optional().describe('export sheet: padding between frames (px)'),
    innerPadding: z.number().optional().describe('export sheet: padding inside each frame (px)'),
    width: z.number().optional().describe('create: canvas width in pixels'),
    height: z.number().optional().describe('create: canvas height in pixels'),
    colorMode: z.enum(['rgb', 'indexed', 'gray']).optional().describe('create: color mode (default rgb)'),
    source: z
      .string()
      .optional()
      .describe('run-script: the Lua source to execute (app.params carries params); asks permission every time'),
    params: z
      .record(z.string(), z.string())
      .optional()
      .describe('run-script: key=value pairs handed to the script as app.params'),
    timeoutMs: z.number().optional().describe('run-script: deadline override in ms (default 60000, cap 120000)'),
  }),
)

type SchemaType = ReturnType<typeof inputSchema>
export type Input = z.infer<SchemaType>
export type Output = {
  op: string
  result: string
}

const TIMEOUTS = { status: 15_000, info: 15_000, create: 30_000, export: 60_000 } as const
const RUN_SCRIPT_DEFAULT_MS = 60_000
const RUN_SCRIPT_CAP_MS = 120_000

/** realpath the target's nearest EXISTING ancestor (the target itself may
 *  not exist yet — an export destination), keeping the not-yet-existing
 *  tail lexical: symlinks can never smuggle a path outside the fence
 *  (realpath BOTH sides — the house law; the BlenderTool shape). */
function realpathNearest(target: string): string {
  let existing = target
  const tail: string[] = []
  for (;;) {
    try {
      return tail.length === 0
        ? realpathSync(existing)
        : path.join(realpathSync(existing), ...tail)
    } catch {
      const parent = path.dirname(existing)
      if (parent === existing) return target // no existing ancestor at all
      tail.unshift(path.basename(existing))
      existing = parent
    }
  }
}

/** Resolve `p` against the working tree and fence it inside — a template
 *  segment ({layer} etc.) is fenced by its directory. Returns the resolved
 *  path, or a refusal sentence. */
function fencePath(label: string, p: string): { resolved?: string; refusal?: string } {
  const cwd = realpathNearest(path.resolve(getCwd()))
  const resolved = realpathNearest(path.resolve(path.resolve(getCwd()), p))
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    return {
      refusal:
        `${label} must stay inside the working tree (${cwd}) — got ${resolved}. ` +
        `Nothing ran; move the target inside the tree (run-script can act elsewhere, behind its own ask).`,
    }
  }
  return { resolved }
}

function asList(v: string | string[] | undefined): string[] {
  if (v === undefined) return []
  return Array.isArray(v) ? v : [v]
}

/** The export argv, composed in the CLI's documented order: selection and
 *  per-frame flags BEFORE the sprite (they apply to the next given sprite),
 *  --scale after it (it resizes previously opened sprites), the sheet block
 *  or --save-as last. Exported pure so the proofs pin the order. */
export function composeExportArgs(input: Input, fenced: { file: string; output: string; dataOutput?: string }): string[] {
  const args: string[] = []
  if (input.allLayers) args.push('--all-layers')
  for (const l of asList(input.layer)) args.push('--layer', l)
  for (const l of asList(input.ignoreLayer)) args.push('--ignore-layer', l)
  if (input.tag !== undefined) args.push('--tag', input.tag)
  if (input.frameRange !== undefined) args.push('--frame-range', input.frameRange)
  if (input.splitLayers) args.push('--split-layers')
  if (input.splitTags) args.push('--split-tags')
  if (input.trim) args.push('--trim')
  if (input.ignoreEmpty) args.push('--ignore-empty')
  if (input.mergeDuplicates) args.push('--merge-duplicates')
  args.push(fenced.file)
  if (input.scale !== undefined) args.push('--scale', String(input.scale))
  const sheetRoad = input.sheetType !== undefined || input.dataOutput !== undefined
  if (sheetRoad) {
    if (input.sheetType !== undefined) args.push('--sheet-type', input.sheetType)
    if (input.sheetColumns !== undefined) args.push('--sheet-columns', String(input.sheetColumns))
    if (input.sheetRows !== undefined) args.push('--sheet-rows', String(input.sheetRows))
    if (input.borderPadding !== undefined) args.push('--border-padding', String(input.borderPadding))
    if (input.shapePadding !== undefined) args.push('--shape-padding', String(input.shapePadding))
    if (input.innerPadding !== undefined) args.push('--inner-padding', String(input.innerPadding))
    if (fenced.dataOutput !== undefined) {
      args.push('--data', fenced.dataOutput)
      args.push('--format', input.dataFormat ?? 'json-hash')
    }
    args.push('--sheet', fenced.output)
  } else {
    args.push('--save-as', fenced.output)
  }
  return args
}

/** What actually landed at (or around) an output path: the literal file, or
 *  — for {template}/multi-frame names — the matching directory entries.
 *  Never throws; absence is a sentence. */
function outputsCensus(outputPath: string): string {
  try {
    const st = statSync(outputPath)
    return `${outputPath} (${st.size} bytes)`
  } catch {
    /* not a literal file — try the template/frame-number shapes */
  }
  const dir = path.dirname(outputPath)
  const base = path.basename(outputPath)
  const ext = path.extname(base)
  const stem = base.slice(0, base.length - ext.length)
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, ch => (ch === '{' || ch === '}' ? ch : `\\${ch}`))
  const withTemplates = escaped.replace(/\{[a-z0-9 _-]+\}/gi, '.*')
  // A multi-frame save to a still format inserts the frame number before
  // the extension even without a {frame} template.
  const pattern = new RegExp(`^${withTemplates}\\d*${ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
  try {
    const hits = readdirSync(dir)
      .filter(name => pattern.test(name))
      .sort()
    if (hits.length === 0) return `${outputPath}: NOTHING LANDED (no file matches the name or its template expansion)`
    const shown = hits.slice(0, 20).map(name => {
      try {
        return `${name} (${statSync(path.join(dir, name)).size} bytes)`
      } catch {
        return name
      }
    })
    return `${hits.length} file(s) in ${dir}: ${shown.join(', ')}${hits.length > 20 ? ', …' : ''}`
  } catch {
    return `${outputPath}: NOTHING LANDED (directory unreadable)`
  }
}

function firstSourceLine(source: string | undefined): string {
  const line = (source ?? '').split('\n', 1)[0] ?? ''
  return line.length > 120 ? line.slice(0, 117) + '…' : line
}

function sourceBytes(source: string | undefined): number {
  return typeof source === 'string' ? Buffer.byteLength(source, 'utf8') : 0
}

function tailOf(s: string, lines = 6): string {
  const all = s.trim().split('\n')
  return all.slice(-lines).join('\n')
}

async function provenance(r: AsepriteResolution): Promise<string> {
  const probe = await probeAsepriteVersion(r.location.path)
  const version = probe.version ? `Aseprite ${probe.version}` : `version unknown (${probe.reason ?? 'unprobed'})`
  return `${version} · ${r.location.path} (${r.location.source} rung)`
}

/** Run a bundled/user Lua program: written to a private temp file, removed
 *  after; params ride --script-param BEFORE --script (the CLI reads argv in
 *  order). */
async function runLua(
  bin: string,
  lua: string,
  opts: { file?: string; params?: Record<string, string>; timeoutMs: number },
): Promise<{ code: number; stdout: string; stderr: string; error?: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'mercury-aseprite-'))
  const scriptPath = path.join(dir, 'program.lua')
  writeFileSync(scriptPath, lua)
  try {
    const args: string[] = []
    if (opts.file !== undefined) args.push(opts.file)
    for (const [k, v] of Object.entries(opts.params ?? {})) {
      args.push('--script-param', `${k}=${v}`)
    }
    args.push('--script', scriptPath)
    return await runAseprite(bin, args, { timeoutMs: opts.timeoutMs })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The last JSON object line a probe printed (the app logs around it). */
function lastJsonLine(stdout: string): string | null {
  const lines = stdout.trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line.startsWith('{') && line.endsWith('}')) return line
  }
  return null
}

function runFailure(op: string, r: { code: number; stdout: string; stderr: string; error?: string }): string {
  const parts = [`${op} failed: exit ${r.code}${r.error ? ` (${r.error})` : ''}`]
  const err = tailOf(r.stderr)
  const out = tailOf(r.stdout)
  if (err) parts.push(`stderr: ${err}`)
  if (out) parts.push(`stdout: ${out}`)
  return parts.join('\n')
}

async function runOp(input: Input): Promise<string> {
  const resolution = resolveAseprite()
  if (input.op === 'status') {
    const sprites = discoverSpriteFiles()
    const spriteLine =
      sprites.total === 0
        ? 'no sprite files in the working tree (bounded walk)'
        : `${sprites.total} sprite file(s) in the working tree${sprites.truncated > 0 ? ` (${sprites.truncated} beyond the listing cap)` : ''}: ${sprites.files.slice(0, 8).join(', ')}${sprites.files.length > 8 ? ', …' : ''}`
    if (resolution.state !== 'ok') {
      return [`aseprite: UNAVAILABLE`, resolution.note, `remedies: ${resolution.remedies.join(' · ')}`, spriteLine].join('\n')
    }
    return [`aseprite: ${await provenance(resolution)}`, spriteLine].join('\n')
  }
  if (resolution.state !== 'ok') {
    return `${input.op}: aseprite is unavailable — ${resolution.note}\n${ASEPRITE_INSTALL_REMEDY}`
  }
  const bin = resolution.location.path

  if (input.op === 'info') {
    if (!input.file) return 'info needs file: the sprite to census'
    const fenced = fencePath('info: file', input.file)
    if (fenced.refusal) return fenced.refusal
    const r = await runLua(bin, SPRITE_PROBE_LUA, { file: fenced.resolved, timeoutMs: TIMEOUTS.info })
    if (r.code !== 0) return runFailure('info', r)
    const json = lastJsonLine(r.stdout)
    if (json === null) {
      return `info: the probe printed no census — stdout tail:\n${tailOf(r.stdout) || '(empty)'}${r.stderr.trim() ? `\nstderr: ${tailOf(r.stderr)}` : ''}`
    }
    let pretty = json
    try {
      pretty = JSON.stringify(JSON.parse(json), null, 2)
    } catch {
      /* carried raw */
    }
    return `${pretty}\n— ${input.file} · ${await provenance(resolution)}`
  }

  if (input.op === 'export') {
    if (!input.file || !input.output) return 'export needs file (the sprite) and output (the destination)'
    const file = fencePath('export: file', input.file)
    if (file.refusal) return file.refusal
    const output = fencePath('export: output', input.output)
    if (output.refusal) return output.refusal
    let dataOutput: string | undefined
    if (input.dataOutput !== undefined) {
      const fenced = fencePath('export: dataOutput', input.dataOutput)
      if (fenced.refusal) return fenced.refusal
      dataOutput = fenced.resolved
    }
    if (input.dataFormat !== undefined && input.dataOutput === undefined) {
      return 'export: dataFormat rides dataOutput — name the JSON destination too'
    }
    const args = composeExportArgs(input, {
      file: file.resolved!,
      output: output.resolved!,
      ...(dataOutput !== undefined ? { dataOutput } : {}),
    })
    const r = await runAseprite(bin, args, { timeoutMs: TIMEOUTS.export })
    if (r.code !== 0) return runFailure('export', r)
    const lines = [`exported ${input.file} → ${outputsCensus(output.resolved!)}`]
    if (dataOutput !== undefined) lines.push(`metadata → ${outputsCensus(dataOutput)}`)
    if (r.stdout.trim()) lines.push(tailOf(r.stdout))
    lines.push(`— ${await provenance(resolution)}`)
    return lines.join('\n')
  }

  if (input.op === 'create') {
    if (!input.output || input.width === undefined || input.height === undefined) {
      return 'create needs output, width and height'
    }
    if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 1 || input.height < 1 || input.width > 65_535 || input.height > 65_535) {
      return 'create: width/height must be integers in 1..65535'
    }
    const output = fencePath('create: output', input.output)
    if (output.refusal) return output.refusal
    const r = await runLua(bin, SPRITE_CREATE_LUA, {
      params: {
        output: output.resolved!,
        width: String(input.width),
        height: String(input.height),
        mode: input.colorMode ?? 'rgb',
      },
      timeoutMs: TIMEOUTS.create,
    })
    if (r.code !== 0) return runFailure('create', r)
    const json = lastJsonLine(r.stdout)
    if (json !== null && json.includes('"error"')) return `create refused: ${json}`
    return [
      `created ${input.output} (${input.width}x${input.height} ${input.colorMode ?? 'rgb'}) → ${outputsCensus(output.resolved!)}`,
      `— ${await provenance(resolution)}`,
    ].join('\n')
  }

  // run-script — the exec verb (asks every time; may act out of tree).
  if (!input.source || input.source.trim().length === 0) {
    return 'run-script needs source: the Lua to execute'
  }
  const file = input.file !== undefined ? path.resolve(getCwd(), input.file) : undefined
  const timeoutMs = Math.min(input.timeoutMs ?? RUN_SCRIPT_DEFAULT_MS, RUN_SCRIPT_CAP_MS)
  const r = await runLua(bin, input.source, {
    ...(file !== undefined ? { file } : {}),
    params: input.params,
    timeoutMs,
  })
  if (r.code !== 0) return runFailure('run-script', r)
  const lines = [r.stdout.trim() || '(no output)']
  if (r.stderr.trim()) lines.push(`stderr: ${tailOf(r.stderr)}`)
  lines.push(`— ${await provenance(resolution)}`)
  return lines.join('\n')
}

function exportOptionsSummary(input: Input): string {
  const parts: string[] = []
  if (input.sheetType !== undefined || input.dataOutput !== undefined) parts.push(`sheet ${input.sheetType ?? 'default layout'}`)
  if (input.scale !== undefined) parts.push(`scale ${input.scale}`)
  if (input.tag !== undefined) parts.push(`tag ${input.tag}`)
  if (input.frameRange !== undefined) parts.push(`frames ${input.frameRange}`)
  if (input.splitLayers) parts.push('split-layers')
  if (input.splitTags) parts.push('split-tags')
  const layers = asList(input.layer)
  if (layers.length > 0) parts.push(`layers ${layers.join('+')}`)
  return parts.join(', ')
}

export const AsepriteTool = buildTool({
  name: ASEPRITE_TOOL_NAME,
  get searchHint() {
    return 'Aseprite pixel art batch control: sprite census (layers tags frames slices), export png gif webp, sprite sheet texture atlas with json metadata, tileset, scale resize, new sprite creation, lua scripting, animation frames, ase aseprite files'
  },
  capability: {
    intents: [
      'inspect an aseprite sprite: layers, tags, frames, size',
      'export a sprite or animation to png or gif',
      'build a sprite sheet with json metadata for a game engine',
      'create a new pixel art sprite file',
      'run a lua script against a sprite in aseprite',
      'check which aseprite mercury can drive and its version',
    ],
    units: ['pixel-art'],
    class: 'mutation',
    operations: [...OPS],
    evidence: ['artifact'],
    cancellation: 'kill',
    latency: 'interactive',
    gate: 'MERCURY_ASEPRITE',
    conditions: ['the aseprite binary located (pin > PATH > app bundle > Steam > win32 installer/itch)'],
    proof: 'scripts/aseprite/run-all.sh',
  },
  maxResultSizeChars: 100_000,
  async description() {
    return 'Drive the local Aseprite in batch mode: sprite census (layers/tags/frames), PNG/GIF/sprite-sheet exports with the real CLI options, new sprites, Lua scripts — never launches the GUI'
  },
  async prompt() {
    return getAsepriteToolDescription()
  },
  userFacingName,
  shouldDefer: true,
  get inputSchema(): SchemaType {
    return inputSchema()
  },
  isConcurrencySafe(input: Input) {
    return input.op === 'status' || input.op === 'info' // writers may collide on outputs
  },
  isReadOnly(input: Input) {
    return input.op === 'status' || input.op === 'info'
  },
  async checkPermissions(input: Input) {
    if (input.op === 'status' || input.op === 'info') {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    if (input.op === 'export') {
      const opts = exportOptionsSummary(input)
      return {
        behavior: 'ask' as const,
        message: `Aseprite export: ${input.file ?? '(file missing)'} → ${input.output ?? '(output missing)'}${input.dataOutput ? ` + ${input.dataOutput}` : ''}${opts ? ` (${opts})` : ''} — writes the named file(s) inside the working tree; the result verifies the bytes landed`,
      }
    }
    if (input.op === 'create') {
      return {
        behavior: 'ask' as const,
        message: `Aseprite create: ${input.output ?? '(output missing)'} (${input.width ?? '?'}x${input.height ?? '?'} ${input.colorMode ?? 'rgb'}) — writes a new sprite file at the named destination`,
      }
    }
    // run-script: the exec class — ask ALWAYS, code facts in the message.
    return {
      behavior: 'ask' as const,
      message:
        `Aseprite exec: run-script (${sourceBytes(input.source)} bytes${input.file ? ` against ${input.file}` : ''}) — runs Lua in Aseprite's batch mode with the app's full script authority ` +
        `(it can modify sprites and write files as you; no sandbox beyond the bounded deadline). ` +
        `first line: ${firstSourceLine(input.source) || '(empty)'}`,
    }
  },
  toAutoClassifierInput(input: Input) {
    if (input.op === 'status' || input.op === 'info') return ''
    if (input.op === 'run-script') {
      return `aseprite exec: run-script ${(input.source ?? '').slice(0, 300)}`
    }
    return `aseprite ${input.op}: ${input.file ?? ''} ${input.output ?? ''} ${exportOptionsSummary(input)}`.trim()
  },
  async validateInput(input: Input) {
    if (!input.op || String(input.op).trim().length === 0) {
      return { result: false as const, message: 'op is required', errorCode: 1 }
    }
    return { result: true as const }
  },
  async call(input: Input) {
    let result: string
    try {
      result = await runOp(input)
    } catch (err) {
      result = `${input.op} failed: ${(err as Error).message}\n${ASEPRITE_INSTALL_REMEDY}`
    }
    const output: Output = { op: input.op, result }
    return { data: output }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseId: string) {
    return {
      tool_use_id: toolUseId,
      type: 'tool_result' as const,
      content: output.result,
    }
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  // HZ7 projection: the renderer paints `result` — search indexes the same.
  extractSearchText({ result }) {
    return result ?? ''
  },
})
