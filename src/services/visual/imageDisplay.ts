
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { flagEnv } from '../../substrate/flagRegistry.js'

export type ImageProtocol = 'iterm' | 'kitty' | 'sixel' | 'cells' | 'link'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

let detected: ImageProtocol | null = null

export function detectImageProtocol(): ImageProtocol {
  const pin = flagEnv('MERCURY_IMAGE_PROTOCOL')
  if (pin === 'iterm' || pin === 'kitty' || pin === 'sixel' || pin === 'cells') return pin
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

export function _resetImageProtocolForTesting(): void {
  detected = null
}


export function encodeItermImage(png: Buffer, name = 'image.png'): string {
  const b64 = png.toString('base64')
  const nameB64 = Buffer.from(name, 'utf8').toString('base64')
  return `${ESC}]1337;File=name=${nameB64};size=${png.byteLength};inline=1:${b64}${BEL}`
}

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


const SIXEL_LEVELS_R = 6
const SIXEL_LEVELS_G = 7
const SIXEL_LEVELS_B = 6

function sixelPaletteIndex(r: number, g: number, b: number): number {
  const ri = Math.round((r / 255) * (SIXEL_LEVELS_R - 1))
  const gi = Math.round((g / 255) * (SIXEL_LEVELS_G - 1))
  const bi = Math.round((b / 255) * (SIXEL_LEVELS_B - 1))
  return ri * SIXEL_LEVELS_G * SIXEL_LEVELS_B + bi * SIXEL_LEVELS_G + gi
}

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


type Sharp = typeof import('sharp').default
let sharpLoad: Promise<Sharp> | null = null
const loadSharp = (): Promise<Sharp> => {
  sharpLoad ??= import('sharp').then(m => ((m as { default?: Sharp }).default ?? m) as Sharp)
  return sharpLoad
}

export function _setSharpUnavailableForTesting(message = 'sharp native binding unavailable'): void {
  sharpLoad = Promise.reject(new Error(message))
  sharpLoad.catch(() => {})
}

export function _resetSharpForTesting(): void {
  sharpLoad = null
}

export function imageLinkLine(filePath: string, reason: string): string {
  const abs = path.resolve(filePath)
  return (
    `[image] ${abs}\n` +
    `        inline decode unavailable on this install (${reason}) — open the file directly.\n` +
    `        Raster tiers (incl. Windows Terminal sixel) need the native image binding; iTerm2/WezTerm/kitty render PNGs natively.`
  )
}

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


export interface RenderedImage {
  protocol: ImageProtocol
  payload: string
}

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
      return linkFallback(new Error('link tier requested'))
  }
}
