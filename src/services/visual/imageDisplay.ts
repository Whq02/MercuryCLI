// ============================================================================
//  services/visual/imageDisplay — the terminal-visuals owner: ONE
//  image-capability detection (cached outside render paths) + the display
//  tiers, best-first:
//
//    iterm   — OSC 1337 File= inline PNG (iTerm2 · WezTerm · Konsole ≥22);
//    kitty   — APC _G chunked PNG (kitty · ghostty);
//    sixel   — our own deterministic fixed-palette encoder (terminals that
//              ADVERTISE sixel; never guessed);
//    cells   — the always-works half-block truecolor preview (2 px/cell,
//              plain SGR text — safe INSIDE the Ink frame on any terminal);
//    link    — the openable artifact line (OSC 8 when supported).
//
//  Raster tiers (iterm/kitty/sixel) are emitted ONLY on plain-stdout paths
//  (`mercury show`, print mode) — never inside the owned Ink differ, whose
//  cell accounting cannot carry opaque raster blocks (recorded follow-up:
//  a differ-level opaque-block contract). In-frame surfaces use `cells`.
//  Degradation is clean by construction: unsupported terminals get cells or
//  the link line — raw escapes are never sent unadvertised.
//
//  sharp decodes lazily (the spriteToAnsi discipline): a missing native
//  binding degrades ONLY image work, at call time — the render entry folds
//  it to the typed `link` tier, so a
//  clean package without the binding never throws on an image render.
// ============================================================================

import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { flagEnv } from '../../substrate/flagRegistry.js'

export type ImageProtocol = 'iterm' | 'kitty' | 'sixel' | 'cells' | 'link'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

let detected: ImageProtocol | null = null

/**
 * Detect the terminal's best image protocol — env-conservative (a protocol
 * is used only when the terminal ADVERTISES itself), latched once, refreshed
 * never (terminals do not change identity mid-session). The operator pin
 * MERCURY_IMAGE_PROTOCOL wins outright (also the proof seam).
 */
export function detectImageProtocol(): ImageProtocol {
  const pin = flagEnv('MERCURY_IMAGE_PROTOCOL')
  if (pin === 'iterm' || pin === 'kitty' || pin === 'sixel' || pin === 'cells') return pin
  // A redirected stdout gets the PLAIN tier (FC-043): `mercury show > file`
  // carried raw truecolor escapes into the file, and NO_COLOR was ignored —
  // every other surface falls back to plain text. The explicit pin above
  // still wins (a deliberate ask); this arm is not latched, so the same
  // process answering a later TTY (never happens for the one-shot verb, but
  // the latch stays honest) re-detects.
  if (!process.stdout.isTTY || (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '')) {
    return 'link'
  }
  if (detected) return detected
  const termProgram = process.env.TERM_PROGRAM ?? ''
  const term = process.env.TERM ?? ''
  if (termProgram === 'iTerm.app' || termProgram === 'WezTerm' || process.env.KONSOLE_VERSION) {
    detected = 'iterm'
  } else if (term === 'xterm-kitty' || process.env.KITTY_WINDOW_ID || termProgram === 'ghostty') {
    detected = 'kitty'
  } else if (term.includes('sixel') || term.startsWith('foot') || term.startsWith('mlterm')) {
    detected = 'sixel'
  } else {
    detected = 'cells'
  }
  return detected
}

/** TEST-ONLY: drop the latch (proof harnesses vary the env). */
export function _resetImageProtocolForTesting(): void {
  detected = null
}

// ── native tiers ────────────────────────────────────────────────────────────

/** iTerm2 OSC 1337 inline image (whole-file base64; WezTerm/Konsole speak it). */
export function encodeItermImage(png: Buffer, name = 'image.png'): string {
  const b64 = png.toString('base64')
  const nameB64 = Buffer.from(name, 'utf8').toString('base64')
  return `${ESC}]1337;File=name=${nameB64};size=${png.byteLength};inline=1:${b64}${BEL}`
}

/** kitty graphics: APC _G chunked PNG transmit-and-display (q=2 quiet). */
export function encodeKittyImage(png: Buffer): string {
  const b64 = png.toString('base64')
  const chunks: string[] = []
  const CHUNK = 4096
  for (let i = 0; i < b64.length; i += CHUNK) {
    const part = b64.slice(i, i + CHUNK)
    const first = i === 0
    const last = i + CHUNK >= b64.length
    const controls = first ? `a=T,f=100,q=2${last ? '' : ',m=1'}` : `m=${last ? 0 : 1},q=2`
    chunks.push(`${ESC}_G${controls};${part}${ESC}\\`)
  }
  return chunks.join('')
}

// ── sixel (own deterministic encoder — fixed 6×7×6 palette + bands) ─────────

const SIXEL_LEVELS_R = 6
const SIXEL_LEVELS_G = 7
const SIXEL_LEVELS_B = 6

function sixelPaletteIndex(r: number, g: number, b: number): number {
  const ri = Math.round((r / 255) * (SIXEL_LEVELS_R - 1))
  const gi = Math.round((g / 255) * (SIXEL_LEVELS_G - 1))
  const bi = Math.round((b / 255) * (SIXEL_LEVELS_B - 1))
  return ri * SIXEL_LEVELS_G * SIXEL_LEVELS_B + bi * SIXEL_LEVELS_G + gi
}

/**
 * Encode raw RGBA to a complete sixel sequence (DCS … ST) over the fixed
 * 252-colour cube. Deterministic; bands of 6 rows; per-band colour passes.
 */
export function encodeSixel(rgba: Buffer, width: number, height: number): string {
  const paletteDefs: string[] = []
  for (let ri = 0; ri < SIXEL_LEVELS_R; ri++) {
    for (let bi = 0; bi < SIXEL_LEVELS_B; bi++) {
      for (let gi = 0; gi < SIXEL_LEVELS_G; gi++) {
        const idx = ri * SIXEL_LEVELS_G * SIXEL_LEVELS_B + bi * SIXEL_LEVELS_G + gi
        const pr = Math.round((ri / (SIXEL_LEVELS_R - 1)) * 100)
        const pg = Math.round((gi / (SIXEL_LEVELS_G - 1)) * 100)
        const pb = Math.round((bi / (SIXEL_LEVELS_B - 1)) * 100)
        paletteDefs.push(`#${idx};2;${pr};${pg};${pb}`)
      }
    }
  }
  const indexed = new Uint16Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    indexed[i] = sixelPaletteIndex(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!)
  }
  const bands: string[] = []
  for (let bandTop = 0; bandTop < height; bandTop += 6) {
    const used = new Set<number>()
    for (let y = bandTop; y < Math.min(bandTop + 6, height); y++) {
      for (let x = 0; x < width; x++) used.add(indexed[y * width + x]!)
    }
    const passes: string[] = []
    for (const color of used) {
      let pass = `#${color}`
      let run = 0
      let prev = -1
      const flush = (): void => {
        if (run === 0) return
        const ch = String.fromCharCode(63 + prev)
        pass += run > 3 ? `!${run}${ch}` : ch.repeat(run)
        run = 0
      }
      for (let x = 0; x < width; x++) {
        let bits = 0
        for (let dy = 0; dy < 6; dy++) {
          const y = bandTop + dy
          if (y >= height) break
          if (indexed[y * width + x] === color) bits |= 1 << dy
        }
        if (bits === prev) run++
        else {
          flush()
          prev = bits
          run = 1
        }
      }
      flush()
      passes.push(pass)
    }
    bands.push(passes.join('$'))
  }
  return `${ESC}P;1;q"1;1;${width};${height}${paletteDefs.join('')}${bands.join('-')}${ESC}\\`
}

// ── the cells tier (generalized half-block — screenshots, not sprites) ──────

type Sharp = typeof import('sharp').default
let sharpLoad: Promise<Sharp> | null = null
const loadSharp = (): Promise<Sharp> => {
  sharpLoad ??= import('sharp').then(m => ((m as { default?: Sharp }).default ?? m) as Sharp)
  return sharpLoad
}

/** TEST-ONLY: force the sharp loader to fail (the clean-package
 *  missing-native-binding condition, made deterministic). */
export function _setSharpUnavailableForTesting(message = 'sharp native binding unavailable'): void {
  sharpLoad = Promise.reject(new Error(message))
  // A rejected latch must never become an unhandled rejection before the
  // first consumer awaits it.
  sharpLoad.catch(() => {})
}

/** TEST-ONLY: drop the sharp latch (pair with _setSharpUnavailableForTesting). */
export function _resetSharpForTesting(): void {
  sharpLoad = null
}

/**
 * The honest floor: when inline decode is impossible on this
 * install, the image renders as a LINK LINE — a truthful pointer, plain
 * text, safe on every terminal — never a thrown render error. The copy names
 * the consequence and the Windows Terminal sixel tier explicitly (the field
 * host most likely to hit a missing native binding).
 */
export function imageLinkLine(filePath: string, reason: string): string {
  const abs = path.resolve(filePath)
  return (
    `[image] ${abs}\n` +
    `        inline decode unavailable on this install (${reason}) — open the file directly.\n` +
    `        Raster tiers (incl. Windows Terminal sixel) need the native image binding; iTerm2/WezTerm/kitty render PNGs natively.`
  )
}

/**
 * Bounded half-block truecolor preview: resize to ≤maxCols×(2·maxRows),
 * stack two pixels per cell with U+2580. Plain SGR text — Ink-safe.
 * No sprite matte: screenshots keep every pixel.
 */
export async function imageToCells(png: Buffer, maxCols = 76, maxRows = 22): Promise<string> {
  const sharp = await loadSharp()
  const { data, info } = await sharp(png)
    .resize(maxCols, maxRows * 2, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width, height } = info
  const lines: string[] = []
  for (let y = 0; y < height; y += 2) {
    let line = ''
    for (let x = 0; x < width; x++) {
      const top = (y * width + x) * 4
      const hasBottom = y + 1 < height
      const bot = ((y + 1) * width + x) * 4
      const tr = data[top]!
      const tg = data[top + 1]!
      const tb = data[top + 2]!
      if (hasBottom) {
        line += `${ESC}[38;2;${tr};${tg};${tb}m${ESC}[48;2;${data[bot]};${data[bot + 1]};${data[bot + 2]}m▀`
      } else {
        line += `${ESC}[38;2;${tr};${tg};${tb}m▀`
      }
    }
    line += `${ESC}[0m`
    lines.push(line)
  }
  return lines.join('\n')
}

// ── the chooser ─────────────────────────────────────────────────────────────

export interface RenderedImage {
  protocol: ImageProtocol
  /** The complete payload — write to a PLAIN stdout (never the Ink frame)
   *  for iterm/kitty/sixel; `cells` is Ink-safe SGR text. */
  payload: string
}

/**
 * Render an image file at the terminal's best tier. Raster tiers read the
 * PNG whole; sixel/cells (and the kitty non-PNG transcode) decode through
 * sharp (lazy)./UI-128: a missing native binding DEGRADES to the typed
 * `link` tier — a truthful pointer line — never a thrown render error; the
 * iterm tier and the kitty PNG-direct path need no decode and stay native.
 */
export async function renderImageForTerminal(
  filePath: string,
  opts: { maxCols?: number; maxRows?: number } = {},
): Promise<RenderedImage> {
  const protocol = detectImageProtocol()
  const png = readFileSync(filePath)
  const linkFallback = (err: unknown): RenderedImage => ({
    protocol: 'link',
    payload: imageLinkLine(filePath, (err as Error)?.message ?? String(err)),
  })
  switch (protocol) {
    case 'iterm':
      return { protocol, payload: encodeItermImage(png, path.basename(filePath)) }
    case 'kitty': {
      // kitty's f=100 is PNG-SPECIFIC and q=2 suppresses its error reply —
      // a mis-declared JPEG would silently display nothing (verify-wave
      // finding #4). Non-PNG bytes transcode through sharp first.
      const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      if (png.subarray(0, 4).equals(PNG_MAGIC)) {
        return { protocol, payload: encodeKittyImage(png) }
      }
      try {
        const sharp = await loadSharp()
        const asPng = await sharp(png).png().toBuffer()
        return { protocol, payload: encodeKittyImage(asPng) }
      } catch (err) {
        return linkFallback(err)
      }
    }
    case 'sixel': {
      try {
        const sharp = await loadSharp()
        const { data, info } = await sharp(png)
          .resize(Math.min(800, (opts.maxCols ?? 76) * 10), null, { fit: 'inside', withoutEnlargement: true })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true })
        return { protocol, payload: encodeSixel(data, info.width, info.height) }
      } catch (err) {
        return linkFallback(err)
      }
    }
    case 'cells':
      try {
        return { protocol, payload: await imageToCells(png, opts.maxCols, opts.maxRows) }
      } catch (err) {
        return linkFallback(err)
      }
    case 'link':
      // Never detected — 'link' is an OUTCOME tier (decode unavailable), not
      // a terminal identity; present so the enum and the outcome agree.
      return linkFallback(new Error('link tier requested'))
  }
}
