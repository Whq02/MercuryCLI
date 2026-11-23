#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const ESC = String.fromCharCode(27)
const NO_DECODER = 'Could not load the "sharp" module using the fixture runtime'

if (process.argv[2] === '--no-decoder') {
  const { mock } = await import('bun:test')
  mock.module('sharp', () => {
    throw new Error(NO_DECODER)
  })
  const says = await (await import('../../src/platform/health/sections/crew.ts')).crewChecks().find(row => row.id === 'image-decode')?.run()
  const tier = (await import('../../src/screen/image-display/imageDisplay.ts')).detectImageProtocol()
  console.log(JSON.stringify({ says, tier }))
  process.exit(0)
}

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

process.env.FORCE_COLOR = '3'
const chalk = (await import('chalk')).default
const { rgbToXterm256 } = await import('../../src/screen/renderer/cell-grid.ts')
const {
  _resetImageProtocolForTesting,
  detectImageProtocol,
  encodeItermImage,
  encodeKittyImage,
  encodeSixel,
  imageToCells,
} = await import('../../src/screen/image-display/imageDisplay.ts')

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const prev = new Map<string, string | undefined>()
  for (const [k, v] of Object.entries(env)) {
    prev.set(k, process.env[k])
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  _resetImageProtocolForTesting()
  try {
    return fn()
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    _resetImageProtocolForTesting()
  }
}

const BLANK = {
  MERCURY_IMAGE_PROTOCOL: undefined,
  TERM_PROGRAM: undefined,
  TERM: undefined,
  KITTY_WINDOW_ID: undefined,
  KONSOLE_VERSION: undefined,
  NO_COLOR: undefined,
}

function withTtyStdout<T>(fn: () => T): T {
  const desc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  try {
    return fn()
  } finally {
    if (desc) Object.defineProperty(process.stdout, 'isTTY', desc)
    else Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true, writable: true })
  }
}

{
  check('bare env → cells (never an unadvertised raster tier)', withEnv(BLANK, () => withTtyStdout(detectImageProtocol)) === 'cells', 'detectImageProtocol in src/screen/image-display/imageDisplay.ts must return cells when no terminal advertises a raster protocol')
  check('iTerm advertises → iterm', withEnv({ ...BLANK, TERM_PROGRAM: 'iTerm.app' }, () => withTtyStdout(detectImageProtocol)) === 'iterm', 'detectImageProtocol in src/screen/image-display/imageDisplay.ts must return iterm for TERM_PROGRAM=iTerm.app')
  check('kitty advertises → kitty', withEnv({ ...BLANK, TERM: 'xterm-kitty' }, () => withTtyStdout(detectImageProtocol)) === 'kitty', 'detectImageProtocol in src/screen/image-display/imageDisplay.ts must return kitty for TERM=xterm-kitty')
  check('sixel-advertising TERM → sixel', withEnv({ ...BLANK, TERM: 'foot' }, () => withTtyStdout(detectImageProtocol)) === 'sixel', 'detectImageProtocol in src/screen/image-display/imageDisplay.ts must return sixel for a sixel-advertising TERM such as foot')
  check('the pin wins outright', withEnv({ ...BLANK, TERM_PROGRAM: 'iTerm.app', MERCURY_IMAGE_PROTOCOL: 'cells' }, () => withTtyStdout(detectImageProtocol)) === 'cells', 'detectImageProtocol in src/screen/image-display/imageDisplay.ts must let MERCURY_IMAGE_PROTOCOL win over what the terminal advertises')
  check('non-TTY stdout → link BEFORE detection (FC-043)', process.stdout.isTTY !== true && withEnv({ ...BLANK, TERM_PROGRAM: 'iTerm.app' }, () => detectImageProtocol()) === 'link', 'detectImageProtocol in src/screen/image-display/imageDisplay.ts must return link when stdout is not a TTY, before any terminal detection')
  check('NO_COLOR on a TTY → link (FC-043)', withEnv({ ...BLANK, TERM_PROGRAM: 'iTerm.app', NO_COLOR: '1' }, () => withTtyStdout(detectImageProtocol)) === 'link', 'detectImageProtocol in src/screen/image-display/imageDisplay.ts must return link when NO_COLOR is set')
  check('…and the explicit pin outranks even the FC-043 fold', withEnv({ ...BLANK, MERCURY_IMAGE_PROTOCOL: 'iterm', NO_COLOR: '1' }, () => detectImageProtocol()) === 'iterm', 'detectImageProtocol in src/screen/image-display/imageDisplay.ts must let an explicit MERCURY_IMAGE_PROTOCOL pin outrank the non-TTY and NO_COLOR fold to link')
}

{
  const png = Buffer.from('fake-png-bytes-for-shape-test')
  const out = encodeItermImage(png, 'shot.png')
  check('iterm: OSC 1337 File= shape', out.startsWith(`${ESC}]1337;File=`) && out.endsWith(String.fromCharCode(7)), 'encodeItermImage in src/screen/image-display/imageDisplay.ts must wrap the payload as ESC ] 1337 ; File= ... BEL')
  check('iterm: size is honest', out.includes(`size=${png.byteLength}`), 'encodeItermImage in src/screen/image-display/imageDisplay.ts must write the real byte length as size=')
  const b64 = out.slice(out.indexOf(':') + 1, -1)
  check('iterm: payload round-trips', Buffer.from(b64, 'base64').equals(png), 'encodeItermImage in src/screen/image-display/imageDisplay.ts must carry the PNG bytes as base64 after the colon')
}

{
  const png = Buffer.alloc(9000, 7)
  const out = encodeKittyImage(png)
  const chunks = out.split(`${ESC}\\`).filter(Boolean)
  check('kitty: multiple APC chunks, all wrapped', chunks.length >= 2 && chunks.every(c => c.startsWith(`${ESC}_G`)), `${chunks.length} chunks · encodeKittyImage in src/screen/image-display/imageDisplay.ts must split a large PNG into APC chunks each opening with ESC _G and closing with ESC backslash`)
  check('kitty: first chunk transmits+displays PNG', chunks[0]!.includes('a=T') && chunks[0]!.includes('f=100'), 'encodeKittyImage in src/screen/image-display/imageDisplay.ts must open with a=T and f=100 in its first chunk')
  check('kitty: continuation marked, final closes', chunks[0]!.includes('m=1') && chunks[chunks.length - 1]!.includes('m=0'), 'encodeKittyImage in src/screen/image-display/imageDisplay.ts must mark every chunk but the last m=1 and the last m=0')
  const joined = chunks.map(c => c.slice(c.indexOf(';') + 1)).join('')
  check('kitty: payload round-trips', Buffer.from(joined, 'base64').equals(png), 'encodeKittyImage in src/screen/image-display/imageDisplay.ts must carry the PNG bytes as base64 across its chunks')
}

{
  const rgba = Buffer.from([255, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255, 0, 0, 255, 255])
  const a = encodeSixel(rgba, 2, 2)
  const b = encodeSixel(rgba, 2, 2)
  check('sixel: DCS … ST framing', a.startsWith(`${ESC}P`) && a.endsWith(`${ESC}\\`) && a.includes('q'), 'encodeSixel in src/screen/image-display/imageDisplay.ts must frame its output as ESC P ... q ... ESC backslash')
  check('sixel: palette definitions present', a.includes('#0;2;') || /#\d+;2;\d+;\d+;\d+/.test(a), 'encodeSixel in src/screen/image-display/imageDisplay.ts must define its palette colours before the pixel rows')
  check('sixel: deterministic', a === b, 'encodeSixel in src/screen/image-display/imageDisplay.ts gave different output for the same pixels')
}

{
  const sharp = (await import('sharp')).default
  const png = await sharp({ create: { width: 40, height: 20, channels: 4, background: { r: 220, g: 68, b: 68, alpha: 1 } } })
    .png()
    .toBuffer()
  const cells = await imageToCells(png, 20, 8)
  check('cells: half-blocks + truecolor SGR', /[▀▄]/.test(cells) && cells.includes('[38;2;'), 'imageToCells in src/screen/image-display/imageDisplay.ts must paint half-block cells with 24-bit foreground colour at chalk level 3')
  chalk.level = 2
  const reduced = await imageToCells(png, 20, 8)
  chalk.level = 3
  check('cells at 256 colours: no 24-bit SGR leaves the painter', !reduced.includes('[38;2;') && !reduced.includes('[48;2;'), 'imageToCells in src/screen/image-display/imageDisplay.ts must use 256-colour SGR when chalk.level is 2')
  check(
    'cells at 256 colours: the nearest index of the pixel',
    reduced.includes(`[38;5;${rgbToXterm256(220, 68, 68)}m`) && reduced.includes(`[48;5;${rgbToXterm256(220, 68, 68)}m`),
    'imageToCells in src/screen/image-display/imageDisplay.ts must use rgbToXterm256 from src/screen/renderer/cell-grid.ts for the 256-colour index',
  )
  check('cells: reset-terminated lines', cells.split('\n').every(l => l.endsWith(`${ESC}[0m`)), 'imageToCells in src/screen/image-display/imageDisplay.ts must end every line with a reset SGR')
  check(
    'cells: Ink-safe — NO OSC/APC/DCS residue',
    !cells.includes(`${ESC}]`) && !cells.includes(`${ESC}_`) && !cells.includes(`${ESC}P`),
    'imageToCells in src/screen/image-display/imageDisplay.ts must emit SGR colour codes only, no OSC, APC or DCS sequences',
  )
  const maxWidth = Math.max(...cells.split('\n').map(l => l.replace(/\u001b\[[0-9;]*m/g, '').length))
  check('cells: bounded width', maxWidth <= 20, `${maxWidth} · imageToCells in src/screen/image-display/imageDisplay.ts must keep each line within the columns it was given`)

  const dist = join(ROOT, 'dist', 'mercury.mjs')
  const fixture = join(mkdtempSync(join(tmpdir(), 'vista-show-')), 'fixture.png')
  writeFileSync(fixture, png)
  const cellsRun = spawnSync('node', [dist, 'image', fixture, '--protocol', 'cells', '--cols', '20'], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  check('image (bundle): cells tier renders half-blocks on stdout', cellsRun.status === 0 && /[▀▄]/.test(cellsRun.stdout), `${cellsRun.stderr.slice(0, 120)} · the mercury image command with --protocol cells exited ${cellsRun.status}: rebuild dist with bun run build.ts`)
  check('image (bundle): names the tier on stderr', cellsRun.stderr.includes('[cells]'), 'the mercury image command must name the chosen tier on stderr as [cells]')
  const itermRun = spawnSync('node', [dist, 'image', fixture, '--protocol', 'iterm'], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  check('image (bundle): iterm tier emits OSC 1337 on stdout', itermRun.status === 0 && itermRun.stdout.startsWith(`${ESC}]1337;File=`), `exit ${itermRun.status} · the mercury image command with --protocol iterm must print the OSC 1337 sequence on stdout: ${itermRun.stderr.slice(0, 120)}`)
}

console.log('\nWI-6 — link fallback when native decode is unavailable:')
{
  const {
    renderImageForTerminal,
    imageLinkLine,
    _setSharpUnavailableForTesting,
    _resetSharpForTesting,
  } = await import('../../src/screen/image-display/imageDisplay.ts')
  async function withEnvAsync<T>(
    env: Record<string, string | undefined>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = new Map<string, string | undefined>()
    for (const [k, v] of Object.entries(env)) {
      prev.set(k, process.env[k])
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    _resetImageProtocolForTesting()
    try {
      return await fn()
    } finally {
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      _resetImageProtocolForTesting()
    }
  }
  const pngB64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const dir = mkdtempSync(join(tmpdir(), 'image-link-'))
  const fixture = join(dir, 'pixel.png')
  writeFileSync(fixture, Buffer.from(pngB64, 'base64'))

  _setSharpUnavailableForTesting('Could not load the "sharp" module using the darwin-arm64 runtime')
  try {
    for (const tier of ['cells', 'sixel'] as const) {
      const r = await withEnvAsync({ MERCURY_IMAGE_PROTOCOL: tier }, () =>
        renderImageForTerminal(fixture),
      )
      check(`${tier} tier degrades to the typed link outcome (never throws)`, r.protocol === 'link', `protocol ${r.protocol} · renderImageForTerminal in src/screen/image-display/imageDisplay.ts must return the link outcome for the cells and sixel tiers when decode is unavailable`)
      check(`${tier} link line carries the absolute path`, r.payload.includes(fixture), 'imageLinkLine in src/screen/image-display/imageDisplay.ts must put the absolute path in the link line')
      check(
        `${tier} degrade copy names Windows Terminal sixel explicitly`,
        r.payload.includes('Windows Terminal sixel'),
        'the degrade copy built in src/screen/image-display/imageDisplay.ts must name Windows Terminal sixel',
      )
      check(`${tier} link payload is plain text (no escapes)`, !r.payload.includes(ESC), 'the link payload built in src/screen/image-display/imageDisplay.ts must be plain text without escape characters')
    }
    const iterm = await withEnvAsync({ MERCURY_IMAGE_PROTOCOL: 'iterm' }, () =>
      renderImageForTerminal(fixture),
    )
    check('iterm tier stays NATIVE without sharp (whole-file base64)', iterm.protocol === 'iterm' && iterm.payload.startsWith(`${ESC}]1337;File=`), `protocol ${iterm.protocol} · renderImageForTerminal in src/screen/image-display/imageDisplay.ts must keep the iterm tier native when sharp is unavailable`)
    const kitty = await withEnvAsync({ MERCURY_IMAGE_PROTOCOL: 'kitty' }, () =>
      renderImageForTerminal(fixture),
    )
    check('kitty tier stays NATIVE for real PNG bytes without sharp', kitty.protocol === 'kitty' && kitty.payload.includes(`${ESC}_G`), `protocol ${kitty.protocol} · renderImageForTerminal in src/screen/image-display/imageDisplay.ts must keep the kitty tier native when sharp is unavailable`)
  } finally {
    _resetSharpForTesting()
  }
  const healthy = await withEnvAsync({ MERCURY_IMAGE_PROTOCOL: 'cells' }, () =>
    renderImageForTerminal(fixture),
  )
  check('healthy sharp: cells tier decodes again after reset', healthy.protocol === 'cells' && /[▀▄]/.test(healthy.payload), `protocol ${healthy.protocol} · _resetSharpForTesting in src/screen/image-display/imageDisplay.ts must clear the unavailable marker so cells decode again`)
  check('imageLinkLine is pure + truthful for arbitrary paths', imageLinkLine('/x/y.png', 'why').includes('/x/y.png') && imageLinkLine('/x/y.png', 'why').includes('why'), 'imageLinkLine in src/screen/image-display/imageDisplay.ts must carry both the path and the reason it is given')
  check(
    '/health names the consequence (images render as file links)',
    await (async () => {
      const says = await (await import('../../src/platform/health/sections/crew.ts')).crewChecks().find(row => row.id === 'image-decode')?.run()
      const tier = (await import('../../src/screen/image-display/imageDisplay.ts')).detectImageProtocol()
      return says !== undefined && (says.status === 'ok' ? says.evidence === `native decode available · detected tier: ${tier}` : says.status === 'warn' && says.evidence.startsWith('images render as file links on this install') && says.evidence.endsWith(`detected tier: ${tier}`))
    })(),
    'the image-decode row in crewChecks of src/platform/health/sections/crew.ts must read ok with native decode available, or warn with images render as file links and the detected tier',
  )
  const child = spawnSync(process.execPath, [import.meta.path, '--no-decoder'], { encoding: 'utf8', timeout: 60_000 })
  let undecoded: { says?: { status: string; evidence: string; fix?: string }; tier?: string } = {}
  try {
    undecoded = JSON.parse(child.stdout.trim().split('\n').pop() ?? '{}')
  } catch {
    undecoded = {}
  }
  check(
    "/health on an install whose decoder does not load (a fresh process in which the module refuses): the row warns, says images render as file links, gives the loader's own words and the tier, and its fix is the update",
    undecoded.says?.status === 'warn' && undecoded.says.evidence === `images render as file links on this install — native decode unavailable (${NO_DECODER}); detected tier: ${undecoded.tier}` && undecoded.says.fix?.startsWith('Reinstall via `mercury update` to restore the bundled image binding') === true,
    `${undecoded.says?.status}: ${undecoded.says?.evidence}${child.status === 0 ? '' : ` · the child exited ${child.status}: ${child.stderr.slice(-240)}`}`,
  )
}

if (failures > 0) {
  console.error(`\nimage display: ${failures} FAILURES`)
  process.exit(1)
}
console.log('\nimage display: green')
