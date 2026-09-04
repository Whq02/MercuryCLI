
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { execa } from 'execa'
import { execFileNoThrow } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import { getImageProcessor } from '../tools/FileReadTool/imageProcessor.js'
import {
  detectImageFormatFromBase64,
  maybeResizeAndDownsampleImageBuffer,
  type ImageDimensions,
} from './imageResizer.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { logError } from './log.js'
import { logForDebugging } from './debug.js'

export const PASTE_THRESHOLD = 800

export const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp)$/i

export type ImageWithDimensions = {
  base64: string
  mediaType: string
  dimensions?: ImageDimensions
  byteLength?: number
}


type ClipboardPlatform = 'darwin' | 'linux' | 'win32'

function clipboardPlatform(): ClipboardPlatform {
  if (process.platform === 'darwin') return 'darwin'
  if (process.platform === 'win32') return 'win32'
  return 'linux'
}

function tempDir(): string {
  const override = process.env.MERCURY_TMPDIR
  if (override) return override
  if (clipboardPlatform() === 'win32') return process.env.TEMP || 'C:\\Temp'
  return '/tmp'
}

export function pasteArtifactDir(): string {
  return join(tempDir(), `mercury-paste-${process.pid}`)
}

let pasteSequence = 0

export function nextPasteArtifactPath(): string {
  pasteSequence += 1
  return join(pasteArtifactDir(), `paste-${pasteSequence}-${randomBytes(4).toString('hex')}.png`)
}

function psQuote(path: string): string {
  return path.replace(/'/g, "''")
}


function fixtureClipboardFile(): string | null {
  const file = flagEnv('MERCURY_CLIPBOARD_IMAGE_FILE')
  return file !== undefined && file.trim() !== '' ? file : null
}


export async function hasImageInClipboard(): Promise<boolean> {
  try {
    return await checkClipboardImage(clipboardPlatform())
  } catch {
    return false
  }
}


async function checkClipboardImage(platform: ClipboardPlatform): Promise<boolean> {
  const fixture = fixtureClipboardFile()
  if (fixture !== null) return getFsImplementation().existsSync(fixture)
  if (platform === 'darwin') {
    const result = await execFileNoThrow('osascript', ['-e', 'the clipboard as «class PNGf»'])
    return result.code === 0
  }
  if (platform === 'win32') {
    const result = await execFileNoThrow('powershell', [
      '-NoProfile',
      '-Command',
      '$img = Get-Clipboard -Format Image; if ($null -eq $img) { exit 1 }; exit 0',
    ])
    return result.code === 0
  }
  const imageMime = /image\/(png|jpe?g|gif|webp|bmp)/i
  const xTargets = await execFileNoThrow('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'])
  if (xTargets.code === 0 && imageMime.test(xTargets.stdout)) return true
  const wlTypes = await execFileNoThrow('wl-paste', ['--list-types'])
  return wlTypes.code === 0 && imageMime.test(wlTypes.stdout)
}

async function saveClipboardImage(platform: ClipboardPlatform, path: string): Promise<boolean> {
  const fixture = fixtureClipboardFile()
  if (fixture !== null) {
    try {
      await copyFile(fixture, path)
      return true
    } catch {
      return false
    }
  }
  if (platform === 'darwin') {
    const script = [
      `set theFile to open for access POSIX file "${path}" with write permission`,
      'write (the clipboard as «class PNGf») to theFile',
      'close access theFile',
    ]
    const result = await execFileNoThrow('osascript', script.flatMap(line => ['-e', line]))
    return result.code === 0
  }
  if (platform === 'win32') {
    const result = await execFileNoThrow('powershell', [
      '-NoProfile',
      '-Command',
      `Add-Type -AssemblyName System.Drawing; $img = Get-Clipboard -Format Image; if ($null -eq $img) { exit 1 }; $img.Save('${psQuote(path)}', [System.Drawing.Imaging.ImageFormat]::Png); exit 0`,
    ])
    return result.code === 0
  }
  const attempts: Array<[string, string[]]> = [
    ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
    ['wl-paste', ['--type', 'image/png']],
    ['xclip', ['-selection', 'clipboard', '-t', 'image/bmp', '-o']],
    ['wl-paste', ['--type', 'image/bmp']],
  ]
  for (const [tool, args] of attempts) {
    try {
      const result = await execa(tool, args, { encoding: 'buffer', windowsHide: true, timeout: 2000 })
      if (result.exitCode === 0 && result.stdout.length > 0) {
        await writeFile(path, result.stdout)
        return true
      }
    } catch {
    }
  }
  return false
}

async function readClipboardPathText(platform: ClipboardPlatform): Promise<string | null> {
  try {
    if (platform === 'darwin') {
      const result = await execFileNoThrow('osascript', [
        '-e',
        'POSIX path of (the clipboard as «class furl»)',
      ])
      if (result.code !== 0) return null
      const trimmed = result.stdout.trim()
      return trimmed === '' ? null : trimmed
    }
    if (platform === 'win32') {
      const result = await execFileNoThrow('powershell', ['-NoProfile', '-Command', 'Get-Clipboard'])
      if (result.code !== 0) return null
      const trimmed = result.stdout.trim()
      return trimmed === '' ? null : trimmed
    }
    const xText = await execFileNoThrow('xclip', ['-selection', 'clipboard', '-t', 'text/plain', '-o'])
    if (xText.code === 0 && xText.stdout.trim() !== '') return xText.stdout.trim()
    const wlText = await execFileNoThrow('wl-paste', [])
    if (wlText.code === 0 && wlText.stdout.trim() !== '') return wlText.stdout.trim()
    return null
  } catch (error) {
    logError(error)
    return null
  }
}

function deleteArtifact(platform: ClipboardPlatform, path: string): void {
  if (platform === 'win32') {
    void execFileNoThrow('powershell', [
      '-NoProfile',
      '-Command',
      `Remove-Item -ErrorAction SilentlyContinue '${psQuote(path)}'`,
    ]).catch(() => {})
    return
  }
  void execFileNoThrow('rm', ['-f', path]).catch(() => {})
}


async function normalizeBmp(buffer: Buffer): Promise<Buffer> {
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    const sharp = await getImageProcessor()
    return sharp(buffer).png().toBuffer()
  }
  return buffer
}


export async function getImageFromClipboard(): Promise<ImageWithDimensions | null> {
  const platform = clipboardPlatform()
  const path = nextPasteArtifactPath()
  try {
    if (!(await checkClipboardImage(platform))) return null
    await mkdir(pasteArtifactDir(), { recursive: true })
    if (!(await saveClipboardImage(platform, path))) return null
  } catch (error) {
    logForDebugging(`imagePaste: clipboard save failed: ${String(error)}`)
    return null
  }
  try {
    const raw = await getFsImplementation().readFileBytes(path)
    const normalized = await normalizeBmp(raw)
    const resized = await maybeResizeAndDownsampleImageBuffer(normalized, normalized.length, 'png')
    const base64 = resized.buffer.toString('base64')
    const mediaType = detectImageFormatFromBase64(base64)
    return { base64, mediaType, dimensions: resized.dimensions, byteLength: resized.buffer.length }
  } finally {
    deleteArtifact(platform, path)
  }
}

export async function getImagePathFromClipboard(): Promise<string | null> {
  return readClipboardPathText(clipboardPlatform())
}


function cleanPath(text: string): string {
  let cleaned = text.trim()
  if (
    cleaned.length >= 2 &&
    ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'")))
  ) {
    cleaned = cleaned.slice(1, -1)
  }
  if (process.platform !== 'win32') {
    const placeholder = `\u0001MERCURY_BS_${randomBytes(8).toString('hex')}\u0001`
    cleaned = cleaned
      .split('\\\\')
      .join(placeholder)
      .replace(/\\(.)/g, '$1')
      .split(placeholder)
      .join('\\')
  }
  return cleaned
}

export function isImageFilePath(text: string): boolean {
  return IMAGE_EXTENSION_REGEX.test(cleanPath(text))
}

export function asImageFilePath(text: string): string | null {
  const cleaned = cleanPath(text)
  return IMAGE_EXTENSION_REGEX.test(cleaned) ? cleaned : null
}


export async function tryReadImageFromPath(
  text: string,
): Promise<(ImageWithDimensions & { path: string }) | null> {
  const cleaned = asImageFilePath(text)
  if (cleaned === null) return null
  let readFrom: string | null = null
  if (isAbsolute(cleaned)) {
    readFrom = cleaned
  } else if (getFsImplementation().existsSync(resolve(cleaned))) {
    readFrom = resolve(cleaned)
  } else {
    const clipboardPath = await getImagePathFromClipboard()
    if (clipboardPath && basename(clipboardPath) === basename(cleaned)) {
      readFrom = clipboardPath
    }
  }
  if (readFrom === null) return null
  let raw: Buffer
  try {
    raw = await getFsImplementation().readFileBytes(readFrom)
  } catch (error) {
    logError(error)
    return null
  }
  if (raw.length === 0) {
    logForDebugging(`imagePaste: pasted image file is empty: ${readFrom}`)
    return null
  }
  const normalized = await normalizeBmp(raw)
  const ext = extname(cleaned).slice(1).toLowerCase() || 'png'
  const resized = await maybeResizeAndDownsampleImageBuffer(normalized, normalized.length, ext)
  const base64 = resized.buffer.toString('base64')
  const mediaType = detectImageFormatFromBase64(base64)
  return { base64, mediaType, dimensions: resized.dimensions, byteLength: resized.buffer.length, path: cleaned }
}
