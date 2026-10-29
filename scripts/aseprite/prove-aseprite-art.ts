#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { AsepriteTool } = await import('../../src/tools/AsepriteTool/AsepriteTool.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
const scratch = mkdtempSync(path.join(tmpdir(), 'ase-art-'))
const saved = process.env.MERCURY_ASEPRITE_BIN
const log = path.join(scratch, 'runs.jsonl')
const shim = path.join(scratch, 'aseprite')
const ctx = {} as Parameters<typeof AsepriteTool.call>[1]
const strokes = [
  { kind: 'pixel', x: 0, y: 0 },
  { kind: 'line', x: 0, y: 0, x2: 7, y2: 7 },
  { kind: 'rect', x: 0, y: 0, x2: 7, y2: 7, fill: false },
  { kind: 'rect', x: 1, y: 1, x2: 6, y2: 6, fill: true },
  { kind: 'ellipse', x: 0, y: 0, x2: 7, y2: 7, fill: false },
  { kind: 'ellipse', x: 1, y: 1, x2: 6, y2: 6, fill: true },
  { kind: 'circle', x: 3, y: 3, radius: 2, fill: false },
  { kind: 'circle', x: 3, y: 3, radius: 1, fill: true },
  { kind: 'flood-fill', x: 3, y: 3 },
].map((op, i) => ({ ...op, layer: 'Body', frame: 0, colour: i % 2 ? { index: 1 } : { r: 255, g: 0, b: 0, a: 255 } }))
writeFileSync(shim, `#!${process.execPath}\nimport fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('Aseprite 9.8.7-fake'); process.exit(0); }
const request = args.find(a => a.startsWith('request='))?.slice(8);
const data = request ? JSON.parse(fs.readFileSync(request, 'utf8')) : {};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, data, script: fs.readFileSync(args.at(-1), 'utf8'), userFolder: process.env.ASEPRITE_USER_FOLDER }) + '\\n');
if (data.save) fs.writeFileSync(data.save, 'DRAWN');
if (data.render) fs.writeFileSync(data.render, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
if (data.report) fs.writeFileSync(data.report, JSON.stringify({ op: data.op, applied: data.ops?.length, ...(data.render ? {render:{width:1,height:1,frames:[0]}} : {}) }));
`)
chmodSync(shim, 0o755)
process.env.MERCURY_ASEPRITE_BIN = shim
function runs(): Array<{ args: string[]; data: Record<string, any>; script: string; userFolder: string }> {
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
}
try {
  await runWithCwdOverride(scratch, async () => {
    const parsed = AsepriteTool.inputSchema.safeParse({ op: 'draw', file: 'hero.aseprite', ops: strokes })
    assert.ok(parsed.success, 'draw accepts every primitive, both fills and both colour forms')
    const input = parsed.data!
    assert.equal(AsepriteTool.isReadOnly(input), false)
    assert.equal(AsepriteTool.isConcurrencySafe(input), false)
    const ask = await AsepriteTool.checkPermissions(input, ctx)
    assert.equal(ask.behavior, 'ask')
    assert.ok('message' in ask && ask.message?.includes('hero.aseprite'))
    for (const op of strokes) assert.ok('message' in ask && ask.message?.includes(op.kind))
    writeFileSync(path.join(scratch, 'hero.aseprite'), 'ORIGINAL')
    const { data } = await AsepriteTool.call(input, ctx)
    assert.match(data.result, /"applied":9/)
    const recorded = runs()
    assert.equal(recorded.length, 1, 'the ordered batch is one spawn')
    assert.equal(recorded[0]!.args[0], '-b')
    assert.deepEqual(recorded[0]!.data.ops, strokes)
    assert.ok(recorded[0]!.script.includes('app.useTool'))
    assert.ok(recorded[0]!.userFolder, 'art runs cannot inherit user drawing preferences')
    assert.equal(readFileSync(path.join(scratch, 'hero.aseprite'), 'utf8'), 'DRAWN')
    assert.equal(existsSync(recorded[0]!.args.at(-1)!), false, 'bundled script removed')
    const refused = await AsepriteTool.call({ ...input, file: '../outside.aseprite' }, ctx)
    assert.match(refused.data.result, /must stay inside the working tree/)
    assert.equal(runs().length, 1)
    const render = AsepriteTool.inputSchema.safeParse({ op: 'render', file: 'hero.aseprite', frame: 0, scale: 3 })
    assert.ok(render.success, 'render accepts frame and nearest-neighbour scale')
    assert.ok(data.preview)
    const block = AsepriteTool.mapToolResultToToolResultBlockParam(data, 'draw-1')
    assert.ok(Array.isArray(block.content))
    assert.equal(block.content[1]?.type, 'image')
    const image = block.content[1] as { source: { type: string; media_type: string; data: string } }
    assert.equal(image.source.type, 'base64')
    assert.equal(image.source.media_type, 'image/png')
    assert.deepEqual(Buffer.from(image.source.data, 'base64'), readFileSync(data.preview.path))
    rmSync(data.preview.path)
    const read = render.data!
    assert.equal((await AsepriteTool.checkPermissions(read, ctx)).behavior, 'allow')
    assert.equal(AsepriteTool.isReadOnly(read), true)
    const viewed = await AsepriteTool.call(read, ctx)
    assert.ok(viewed.data.preview)
    assert.equal(runs().length, 2)
    assert.equal(runs()[1]!.data.save, undefined)
    assert.equal(runs()[1]!.data.frame, 0)
    assert.equal(runs()[1]!.data.scale, 3)
    rmSync(viewed.data.preview.path)
    assert.equal(AsepriteTool.inputSchema.safeParse({ ...input, ops: [] }).success, false)
    assert.equal(AsepriteTool.inputSchema.safeParse({ ...input, ops: [{ ...strokes[0], x: 0.5 }] }).success, false)
  })
  console.log('PASS Aseprite art primitives: grammar, order, one spawn, permission, fence, cleanup')
} finally {
  if (saved === undefined) delete process.env.MERCURY_ASEPRITE_BIN
  else process.env.MERCURY_ASEPRITE_BIN = saved
  rmSync(scratch, { recursive: true, force: true })
}
