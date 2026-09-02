#!/usr/bin/env bun
// ============================================================================
//  scripts/language-sidecars/prove-image-display.ts — the terminal-visuals
//  owner proved at the ENCODER level + the built `mercury show` path:
//
//    detection   — env matrix (advertised-only; pin wins; latch resets);
//    iterm       — OSC 1337 File= shape, size honest, base64 round-trip;
//    kitty       — chunked APC _G, first a=T,f=100, last m=0, all wrapped;
//    sixel       — deterministic DCS…ST, palette defs, band separators;
//    cells       — Ink-safe: SGR-only (NO OSC/APC/DCS residue), bounded
//                  width, reset-terminated;
//    show        — the BUILT bundle displays a PNG at a pinned tier on
//                  plain stdout (cells + iterm proved).
// ============================================================================

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const ESC = String.fromCharCode(27)

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const {
  _resetImageProtocolForTesting,
  detectImageProtocol,
  encodeItermImage,
  encodeKittyImage,
  encodeSixel,
  imageToCells,
} = await import('../../src/services/visual/imageDisplay.ts')

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

/** The advertise-detection matrix runs on a TTY stdout by construction:
 *  FC-043 folds every non-TTY (or NO_COLOR) surface to the `link` tier
 *  BEFORE detection, and prover stdout is a pipe — the matrix legs fake
 *  the TTY to reach the detection arm, and the FC-043 fold itself is
 *  pinned below on the pipe's own truth. */
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

// ── detection matrix ────────────────────────────────────────────────────────
{
  check('bare env → cells (never an unadvertised raster tier)', withEnv(BLANK, () => withTtyStdout(detectImageProtocol)) === 'cells')
  check('iTerm advertises → iterm', withEnv({ ...BLANK, TERM_PROGRAM: 'iTerm.app' }, () => withTtyStdout(detectImageProtocol)) === 'iterm')
  check('kitty advertises → kitty', withEnv({ ...BLANK, TERM: 'xterm-kitty' }, () => withTtyStdout(detectImageProtocol)) === 'kitty')
  check('sixel-advertising TERM → sixel', withEnv({ ...BLANK, TERM: 'foot' }, () => withTtyStdout(detectImageProtocol)) === 'sixel')
  check('the pin wins outright', withEnv({ ...BLANK, TERM_PROGRAM: 'iTerm.app', MERCURY_IMAGE_PROTOCOL: 'cells' }, () => withTtyStdout(detectImageProtocol)) === 'cells')
  // FC-043 — the fold that outranks detection (this prover's own stdout is
  // the non-TTY witness; NO_COLOR folds even a TTY):
  check('non-TTY stdout → link BEFORE detection (FC-043)', process.stdout.isTTY !== true && withEnv({ ...BLANK, TERM_PROGRAM: 'iTerm.app' }, () => detectImageProtocol()) === 'link')
  check('NO_COLOR on a TTY → link (FC-043)', withEnv({ ...BLANK, TERM_PROGRAM: 'iTerm.app', NO_COLOR: '1' }, () => withTtyStdout(detectImageProtocol)) === 'link')
  check('…and the explicit pin outranks even the FC-043 fold', withEnv({ ...BLANK, MERCURY_IMAGE_PROTOCOL: 'iterm', NO_COLOR: '1' }, () => detectImageProtocol()) === 'iterm')
}

// ── iterm encoder ───────────────────────────────────────────────────────────
{
  const png = Buffer.from('fake-png-bytes-for-shape-test')
  const out = encodeItermImage(png, 'shot.png')
  check('iterm: OSC 1337 File= shape', out.startsWith(`${ESC}]1337;File=`) && out.endsWith(String.fromCharCode(7)))
  check('iterm: size is honest', out.includes(`size=${png.byteLength}`))
  const b64 = out.slice(out.indexOf(':') + 1, -1)
  check('iterm: payload round-trips', Buffer.from(b64, 'base64').equals(png))
}

// ── kitty encoder ───────────────────────────────────────────────────────────
{
  const png = Buffer.alloc(9000, 7)
  const out = encodeKittyImage(png)
  const chunks = out.split(`${ESC}\\`).filter(Boolean)
  check('kitty: multiple APC chunks, all wrapped', chunks.length >= 2 && chunks.every(c => c.startsWith(`${ESC}_G`)))
  check('kitty: first chunk transmits+displays PNG', chunks[0]!.includes('a=T') && chunks[0]!.includes('f=100'))
  check('kitty: continuation marked, final closes', chunks[0]!.includes('m=1') && chunks[chunks.length - 1]!.includes('m=0'))
  const joined = chunks.map(c => c.slice(c.indexOf(';') + 1)).join('')
  check('kitty: payload round-trips', Buffer.from(joined, 'base64').equals(png))
}

// ── sixel encoder ───────────────────────────────────────────────────────────
{
  const rgba = Buffer.from([255, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255, 0, 0, 255, 255])
  const a = encodeSixel(rgba, 2, 2)
  const b = encodeSixel(rgba, 2, 2)
  check('sixel: DCS … ST framing', a.startsWith(`${ESC}P`) && a.endsWith(`${ESC}\\`) && a.includes('q'))
  check('sixel: palette definitions present', a.includes('#0;2;') || /#\d+;2;\d+;\d+;\d+/.test(a))
  check('sixel: deterministic', a === b)
}

// ── cells tier (sharp-decoded) ──────────────────────────────────────────────
{
  const sharp = (await import('sharp')).default
  const png = await sharp({ create: { width: 40, height: 20, channels: 4, background: { r: 220, g: 68, b: 68, alpha: 1 } } })
    .png()
    .toBuffer()
  const cells = await imageToCells(png, 20, 8)
  check('cells: half-blocks + truecolor SGR', cells.includes('▀') && cells.includes('[38;2;'))
  check('cells: reset-terminated lines', cells.split('\n').every(l => l.endsWith(`${ESC}[0m`)))
  check(
    'cells: Ink-safe — NO OSC/APC/DCS residue',
    !cells.includes(`${ESC}]`) && !cells.includes(`${ESC}_`) && !cells.includes(`${ESC}P`),
  )
  const maxWidth = Math.max(...cells.split('\n').map(l => l.replace(/\u001b\[[0-9;]*m/g, '').length))
  check('cells: bounded width', maxWidth <= 20, String(maxWidth))

  // ── the BUILT show path ───────────────────────────────────────────────────
  const dist = join(ROOT, 'dist', 'mercury.mjs')
  const fixture = join(mkdtempSync(join(tmpdir(), 'vista-show-')), 'fixture.png')
  writeFileSync(fixture, png)
  const cellsRun = spawnSync('node', [dist, 'show', fixture, '--protocol', 'cells', '--cols', '20'], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  check('show (bundle): cells tier renders half-blocks on stdout', cellsRun.status === 0 && cellsRun.stdout.includes('▀'), cellsRun.stderr.slice(0, 120))
  check('show (bundle): names the tier on stderr', cellsRun.stderr.includes('[cells]'))
  const itermRun = spawnSync('node', [dist, 'show', fixture, '--protocol', 'iterm'], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  check('show (bundle): iterm tier emits OSC 1337 on stdout', itermRun.status === 0 && itermRun.stdout.startsWith(`${ESC}]1337;File=`))
}

// ──/UI-126..128: the typed link fallback (the honest floor) ────────────
// A clean package without the sharp native binding must DEGRADE every
// decode-needing tier to the `link` outcome — a truthful pointer line —
// never a thrown render error; the iterm tier and the kitty PNG-direct path
// need no decode and stay native.
console.log('\nWI-6 — link fallback when native decode is unavailable:')
{
  const {
    renderImageForTerminal,
    imageLinkLine,
    _setSharpUnavailableForTesting,
    _resetSharpForTesting,
  } = await import('../../src/services/visual/imageDisplay.ts')
  // Async twin of withEnv (same restore discipline; the render entry awaits).
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
  // A real 1×1 PNG so the raster paths are exercised with honest bytes.
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
      check(`${tier} tier degrades to the typed link outcome (never throws)`, r.protocol === 'link')
      check(`${tier} link line carries the absolute path`, r.payload.includes(fixture))
      check(
        `${tier} degrade copy names Windows Terminal sixel explicitly`,
        r.payload.includes('Windows Terminal sixel'),
      )
      check(`${tier} link payload is plain text (no escapes)`, !r.payload.includes(ESC))
    }
    // iterm needs NO decode — native even with sharp dead.
    const iterm = await withEnvAsync({ MERCURY_IMAGE_PROTOCOL: 'iterm' }, () =>
      renderImageForTerminal(fixture),
    )
    check('iterm tier stays NATIVE without sharp (whole-file base64)', iterm.protocol === 'iterm' && iterm.payload.startsWith(`${ESC}]1337;File=`))
    // kitty PNG-direct path needs no decode either.
    const kitty = await withEnvAsync({ MERCURY_IMAGE_PROTOCOL: 'kitty' }, () =>
      renderImageForTerminal(fixture),
    )
    check('kitty tier stays NATIVE for real PNG bytes without sharp', kitty.protocol === 'kitty' && kitty.payload.includes(`${ESC}_G`))
  } finally {
    _resetSharpForTesting()
  }
  // With sharp healthy again, cells decodes for real (regression guard).
  const healthy = await withEnvAsync({ MERCURY_IMAGE_PROTOCOL: 'cells' }, () =>
    renderImageForTerminal(fixture),
  )
  check('healthy sharp: cells tier decodes again after reset', healthy.protocol === 'cells' && healthy.payload.includes('▀'))
  check('imageLinkLine is pure + truthful for arbitrary paths', imageLinkLine('/x/y.png', 'why').includes('/x/y.png') && imageLinkLine('/x/y.png', 'why').includes('why'))
  // Contract agreement (UI-128): enum carries link; the caller treats any
  // rendered outcome as success; the doctor names the consequence.
  const srcOf = (p: string) => require('node:fs').readFileSync(join(ROOT, p), 'utf8')
  check(
    'the protocol enum + render entry carry the link outcome',
    srcOf('src/services/visual/imageDisplay.ts').includes("'cells' | 'link'"),
  )
  check(
    'the doctor names the consequence (images render as file links)',
    srcOf('src/utils/healthReport.ts').includes('images render as file links'),
  )
}

if (failures > 0) {
  console.error(`\nimage display: ${failures} FAILURES`)
  process.exit(1)
}
console.log('\nimage display: green')
