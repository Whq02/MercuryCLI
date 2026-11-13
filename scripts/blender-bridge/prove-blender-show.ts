#!/usr/bin/env bun

process.env.MERCURY_DESKTOP_DRIVER = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { createFakeBlenderFixture } from './fake-blender.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

for (const k of [
  'MERCURY_BLENDER',
  'MERCURY_BLENDER_BIN',
  'MERCURY_BLENDER_BRIDGE_PORT',
  'MERCURY_BLENDER_BRIDGE_TOKEN',
  'MERCURY_BLENDER_BRIDGE_ADDON_DIR',
  'BLENDER_USER_SCRIPTS',
  'BLENDER_USER_RESOURCES',
  'FAKE_BLENDER_C_STDOUT',
  'FAKE_BLENDER_C_STDERR',
]) {
  delete process.env[k]
}

async function freshDeadPort(): Promise<number> {
  return new Promise<number>(resolve => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'blender-show-proof-')))
const work = path.join(scratch, 'studio')
mkdirSync(path.join(work, 'tools', 'kit'), { recursive: true })
mkdirSync(path.join(work, 'look'), { recursive: true })
const addonHome = path.join(scratch, 'addons')
mkdirSync(addonHome, { recursive: true })
const fixture = createFakeBlenderFixture(path.join(scratch, 'bin'), { version: '5.3.0' })
process.env.HOME = path.join(scratch, 'home')
mkdirSync(process.env.HOME, { recursive: true })
process.env.MERCURY_BLENDER = '1'
process.env.MERCURY_BLENDER_BIN = fixture.bin
process.env.MERCURY_BLENDER_BRIDGE_PORT = String(await freshDeadPort())
process.env.MERCURY_BLENDER_BRIDGE_ADDON_DIR = addonHome

const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
const { BlenderTool } = await import('../../src/tools/BlenderTool/BlenderTool.js')
const { getBlenderToolDescription } = await import('../../src/tools/BlenderTool/prompt.js')
const { resetBlenderBridgeClientForTest } = await import('../../src/services/blender/bridgeClient.js')
const { _resetBlenderBridgeContextCacheForTesting } = await import('../../src/utils/blender/bridgeGates.js')
const installer = await import('../../src/services/blender/bridgeInstaller.js')
const { readBlenderBridgeToken } = await import('../../src/services/blender/bridgeToken.js')
const { startFakeBlenderBridge } = await import('./fake-bridge.js')
const { decodePng } = await import('../../src/tools/FileReadTool/imageProcessorJs.js')
resetBlenderBridgeClientForTest()
_resetBlenderBridgeContextCacheForTesting()

writeFileSync(
  path.join(work, 'tools', 'kit', 'look.py'),
  [
    'import os, struct, sys, zlib',
    'argv = sys.argv[sys.argv.index("--") + 1:]',
    'def value(name, default):',
    '    return argv[argv.index(name) + 1] if name in argv else default',
    'def write_png(target, width, height, cell):',
    '    rows = []',
    '    for y in range(height):',
    '        row = bytearray([0])',
    '        for x in range(width):',
    '            row += bytes((176, 46, 43) if ((x // cell) + (y // cell)) % 2 else (78, 110, 62))',
    '        rows.append(bytes(row))',
    '    def chunk(tag, data):',
    '        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)',
    '    os.makedirs(os.path.dirname(target) or ".", exist_ok=True)',
    '    with open(target, "wb") as handle:',
    '        handle.write(b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))',
    'print("STAND@62: 909 px, box [11, 0, 56, 64], 0.058 s")',
    'if "--fail" in argv:',
    '    raise ValueError("could not broadcast input array from shape (355,198,3) into shape (357,198,3)")',
    'width = int(value("--width", "16"))',
    'for target in value("--sheet", "look/e1.png").split(","):',
    '    write_png(target, width, int(value("--height", "16")), int(value("--cell", "4")))',
    '    print("sheet " + target)',
    '',
  ].join('\n'),
)

type Part = { type: 'text'; text: string } | { type: 'image'; source: { type: string; media_type: string; data: string } }
type Block = { content: string | Part[] }
type Ran = { text: string; block: Block; parts: Part[]; images: Array<{ width: number; height: number; colours: number }> }
const elapsedOut = (text: string): string => text.replace(/"elapsedMs": \d+/g, '"elapsedMs": N')
async function run(args: Record<string, unknown>, op = 'python_run'): Promise<Ran> {
  const answered = (await runWithCwdOverride(work, () => BlenderTool.call({ op, args } as never, {} as never))) as { data: { op: string; result: string } }
  const block = BlenderTool.mapToolResultToToolResultBlockParam(answered.data as never, 'toolu_show') as Block
  const parts = Array.isArray(block.content) ? block.content : []
  const images = parts
    .filter((part): part is Extract<Part, { type: 'image' }> => part.type === 'image')
    .map(part => {
      const image = decodePng(Buffer.from(part.source.data, 'base64'))
      const seen = new Set<string>()
      for (let i = 0; i < image.data.length; i += 4) seen.add(`${image.data[i]},${image.data[i + 1]},${image.data[i + 2]}`)
      return { width: image.width, height: image.height, colours: seen.size }
    })
  return { text: answered.data.result, block, parts, images }
}
const textsOf = (ran: Ran): string[] => ran.parts.filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text').map(part => part.text)
const kit = path.join('tools', 'kit', 'look.py')
const sheet = path.join('look', 'e1.png')
const sheetAbs = path.join(work, sheet)

section('§1 · a call that asks for no picture answers as it did: one string, nothing added')
{
  const plain = await run({ script: kit, argv: ['--sheet', sheet] })
  const expected = [
    `road: headless (${fixture.bin} -b)`,
    'exit status: 0',
    'state: process ended, no state kept (name blend on the next call)',
    '{',
    '  "value": null,',
    `  "stdout": "STAND@62: 909 px, box [11, 0, 56, 64], 0.058 s\\nsheet ${sheet}\\n",`,
    '  "stderr": "",',
    '  "truncated": {',
    '    "stdout": 0,',
    '    "stderr": 0',
    '  },',
    '  "elapsedMs": N',
    '}',
  ].join('\n')
  check('the tool result is one string', typeof plain.block.content === 'string', JSON.stringify(plain.block.content).slice(0, 200))
  check('and it is the answer line for line, with nothing after it', elapsedOut(String(plain.block.content)) === expected, elapsedOut(String(plain.block.content)))
  const inline = await run({ source: 'result = 2' })
  check('an inline source with no show is one string too', typeof inline.block.content === 'string' && String(inline.block.content).includes('"value": "2"'))
}

section('§2 · show: the picture the script wrote rides the answer of the call that wrote it')
{
  rmSync(sheetAbs, { force: true })
  const without = await run({ script: kit, argv: ['--sheet', sheet] })
  rmSync(sheetAbs, { force: true })
  fixture.clearInvocations()
  const look = await run({ script: kit, argv: ['--sheet', sheet], show: [sheet] })
  check('one call, one Blender', fixture.invocations().length === 1, `starts=${fixture.invocations().length}`)
  check('the tool result is the answer, then the picture\'s caption, then the picture', look.parts.length === 3 && look.parts[0]?.type === 'text' && look.parts[1]?.type === 'text' && look.parts[2]?.type === 'image', look.parts.map(part => part.type).join(','))
  check('the answer is the one the same call gives without show, byte for byte', elapsedOut(look.text) === elapsedOut(without.text) && look.parts[0]?.type === 'text' && elapsedOut(look.parts[0].text) === elapsedOut(without.text), elapsedOut(look.text))
  check('the picture is the 16x16 sheet of two colours the script wrote', look.images.length === 1 && look.images[0]?.width === 16 && look.images[0]?.height === 16 && look.images[0]?.colours === 2, JSON.stringify(look.images))
  check('its caption is the line a Read of the file carries, and nothing more', textsOf(look)[1] === `[Image: source: ${sheetAbs}]`, textsOf(look)[1] ?? '')
}

section('§3 · each picture is a path, or a path with the crop and the scale a Read takes')
{
  const scaled = await run({ script: kit, argv: ['--sheet', sheet], show: [{ path: sheet, scale: 3 }] })
  check('scale with no crop enlarges the whole picture pixel for pixel: 48x48, two colours', scaled.images[0]?.width === 48 && scaled.images[0]?.height === 48 && scaled.images[0]?.colours === 2, JSON.stringify(scaled.images))
  check('and the caption says the box and the scale as a Read does', /the crop \[0, 0, 16, 16\] of .* and scaled by 3/.test(textsOf(scaled)[1] ?? ''), textsOf(scaled)[1] ?? '')
  const boxed = await run({ script: kit, argv: ['--sheet', sheet], show: [{ path: sheet, crop: [8, 8, 20, 20], scale: 2 }] })
  check('a box that passes the edge is cut to the picture and enlarged: 8x8 becomes 16x16', boxed.images[0]?.width === 16 && boxed.images[0]?.height === 16 && (textsOf(boxed)[1] ?? '').includes("passed the image's edge and was cut to it"), `${JSON.stringify(boxed.images)} ${textsOf(boxed)[1] ?? ''}`)
  const two = await run({ script: kit, argv: ['--sheet', `${sheet},look/e2.png`], show: [sheet, 'look/e2.png'] })
  check('two pictures come back in the order named, each under its own caption', two.images.length === 2 && two.parts.map(part => part.type).join(',') === 'text,text,image,text,image' && (textsOf(two)[2] ?? '').includes('e2.png'), two.parts.map(part => part.type).join(','))
}

section('§4 · missing, left over from an earlier run, too many, not a picture, too large')
{
  const failed = await run({ script: kit, argv: ['--sheet', 'look/never.png', '--fail'], show: ['look/never.png'] })
  check(
    'a run that failed before writing: the answer keeps its exit status and traceback, and one line says the picture was not written',
    /exit status:\s*[1-9]/.test(failed.text) && failed.text.includes('[PYTHON_EXCEPTION] ValueError') && failed.images.length === 0 && textsOf(failed).includes('show: look/never.png was not written'),
    JSON.stringify(textsOf(failed)).slice(0, 400),
  )
  await run({ script: kit, argv: ['--sheet', sheet] })
  const before = new Date(Date.now() - 60_000)
  utimesSync(sheetAbs, before, before)
  const stale = await run({ script: kit, argv: ['--sheet', sheet, '--fail'], show: [sheet] })
  check('a picture left by an earlier run is shown and marked as not written by this call', stale.images.length === 1 && (textsOf(stale)[1] ?? '').endsWith('(not written by this call)'), textsOf(stale)[1] ?? '')
  const fresh = await run({ script: kit, argv: ['--sheet', sheet], show: [sheet] })
  check('the same picture written again by the call carries no such mark', fresh.images.length === 1 && !(textsOf(fresh)[1] ?? '').includes('not written by this call'), textsOf(fresh)[1] ?? '')
  const names = ['a', 'b', 'c', 'd', 'e'].map(name => `look/${name}.png`)
  const five = await run({ script: kit, argv: ['--sheet', names.join(',')], show: names })
  check('five named: four ride the answer and the fifth is listed by its path', five.images.length === 4 && textsOf(five).at(-1) === 'show: 4 pictures at most ride one answer; not shown: look/e.png', textsOf(five).at(-1) ?? '')
  writeFileSync(path.join(work, 'look', 'notes.txt'), 'not a picture\n')
  const text = await run({ script: kit, argv: ['--sheet', sheet], show: ['look/notes.txt', sheet] })
  check('a file that is not a picture gets one line, and the picture named beside it still rides', text.images.length === 1 && textsOf(text).includes('show: look/notes.txt is not a picture (png, jpeg, gif or webp)'), JSON.stringify(textsOf(text)).slice(0, 300))
  const wide = await run({ script: kit, argv: ['--sheet', 'look/wide.png', '--width', '9000', '--height', '40', '--cell', '100'], show: ['look/wide.png'] })
  check('a picture wider than a request may carry is shrunk by the reader a Read uses, and its caption gives both sizes', wide.images.length === 1 && (wide.images[0]?.width ?? 9000) < 9000 && /original dimensions: 9000x40/.test(textsOf(wide)[1] ?? ''), `${JSON.stringify(wide.images)} ${textsOf(wide)[1] ?? ''}`)
}

section('§5 · a show that is not a list of pictures is turned back before Blender starts; the ask lists the pictures')
{
  fixture.clearInvocations()
  const rule = 'python_run: show is a list of pictures the script writes, each a path or {path, crop, scale} with crop and scale as Read takes them. Nothing was sent to Blender.'
  const bare = await run({ script: kit, show: sheet })
  const odd = await run({ script: kit, show: [{ path: sheet, zoom: 2 }] })
  check('a bare path and an unknown word are both refused by the rule, and no Blender starts', bare.text === rule && odd.text === rule && fixture.invocations().length === 0, `${bare.text} | ${odd.text}`)
  const ask = (await BlenderTool.checkPermissions!({ op: 'python_run', args: { script: kit, argv: ['--sheet', sheet], show: [sheet, { path: 'look/e2.png', scale: 2 }] } } as never, {} as never)) as { behavior: string; message?: string }
  check('the ask names the pictures after its other words', ask.behavior === 'ask' && (ask.message ?? '').endsWith(`ends with it. Shows: ${sheet}, look/e2.png.`), ask.message ?? '')
  const plainAsk = (await BlenderTool.checkPermissions!({ op: 'python_run', args: { script: kit } } as never, {} as never)) as { message?: string }
  check('an ask with no show says nothing of pictures', !(plainAsk.message ?? '').includes('Shows:'), plainAsk.message ?? '')
  const text = getBlenderToolDescription()
  check(
    'the tool\'s text says in one sentence what show gives and that it saves the Read, and the catalog lists it',
    text.includes('show returns up to four pictures it wrote with the answer (path, or {path, crop, scale} as in Read), saving a Read.') && text.includes('python_run(source | script, argv?, show?) [exec]') && Buffer.byteLength(text, 'utf8') <= 2400,
    `${Buffer.byteLength(text, 'utf8')} bytes`,
  )
}

section('§6 · the bridge road: the same pictures ride a python_run a running Blender answered')
{
  installer.applyBlenderBridgeInstall()
  const bridge = await startFakeBlenderBridge({ token: readBlenderBridgeToken(addonHome)! })
  process.env.MERCURY_BLENDER_BRIDGE_PORT = String(bridge.port)
  resetBlenderBridgeClientForTest()
  fixture.clearInvocations()
  const over = await run({ source: 'result = 1', show: [sheet] })
  check('the answer comes over the bridge and no Blender is started', /^road: bridge/.test(over.text) && fixture.invocations().length === 0, over.text.slice(0, 80))
  check('the picture named rides it (this bridge writes nothing, so it is marked as left from before)', over.images.length === 1 && over.images[0]?.width === 16 && (textsOf(over)[1] ?? '').endsWith('(not written by this call)'), textsOf(over)[1] ?? '')
  const sentKeys = bridge.seenArgKeys[bridge.seenOps.lastIndexOf('python_run')] ?? []
  check('the add-on was sent the source and no argument it does not know', bridge.seenPython.at(-1) === 'result = 1' && sentKeys.join(',') === 'source', sentKeys.join(','))
  await bridge.close()
  resetBlenderBridgeClientForTest()
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + (failures === 0 ? '✅ blender show proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
