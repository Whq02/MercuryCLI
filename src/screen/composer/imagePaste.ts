import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { execa } from 'execa'
import { execFileNoThrow } from '../../platform/processes/execFileNoThrow.js'
import { getFsImplementation } from '../../platform/files/fsOperations.js'
import { getImageProcessor } from '../../platform/images/imageProcessor.js'
import {
  detectImageFormatFromBase64,
  maybeResizeAndDownsampleImageBuffer,
  type ImageDimensions,
} from '../../platform/images/imageResizer.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { logError } from '../../platform/logs/errorLog.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { escapeForPowershellSingleQuotes } from '../../platform/shell/powershellLiteral.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'
import { normalizedOsPlatform } from '../../platform/host-os/programs.js'

export const PASTE_THRESHOLD = 800

type ImageWithDimensions = {
  base64: string
  mediaType: string
  dimensions?: ImageDimensions
  byteLength?: number
}


type ClipboardPlatform = 'darwin' | 'linux' | 'win32'

function clipboardPlatform(): ClipboardPlatform {
  return normalizedOsPlatform()
}

function tempDir(): string {
  const override = flagEnv('MERCURY_TMPDIR')
  if (override) return override
  if (clipboardPlatform() === 'win32') return hostEnv().TEMP || 'C:\\Temp'
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


function fixtureClipboardFile(): string | null {
  const file = flagEnv('MERCURY_CLIPBOARD_IMAGE_FILE')
  return file !== undefined && file.trim() !== '' ? file : null
}


export async function hasImageInClipboard(): Promise<boolean> {
  try {
    return await checkClipboardImage(clipboardPlatform())
  } catch (error) {
    passedOver(error)
    return false
  }
}


async function checkClipboardImage(platform: ClipboardPlatform): Promise<boolean> {
  const fixture = fixtureClipboardFile()
  if (fixture !== null) return getFsImplementation().existsSync(fixture)
  if (platform === 'darwin') {
    return (await execFileNoThrow('osascript', ['-e', 'the clipboard as «class PNGf»'])).code === 0
  }
  if (platform === 'win32') {
    return (await execFileNoThrow('powershell', ['-NoProfile', '-Command', '$img = Get-Clipboard -Format Image; if ($null -eq $img) { exit 1 }; exit 0'])).code === 0
  }
  const hasImageType = /image\/(?:png|jpe?g|gif|webp|bmp)/i
  const x = await execFileNoThrow('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'])
  if (x.code === 0 && hasImageType.test(x.stdout)) return true
  const wl = await execFileNoThrow('wl-paste', ['--list-types'])
  return wl.code === 0 && hasImageType.test(wl.stdout)
}

async function saveClipboardImage(platform: ClipboardPlatform, path: string): Promise<boolean> {
  const fixture = fixtureClipboardFile()
  if (fixture !== null) {
    try {
      await copyFile(fixture, path)
      return true
    } catch (error) {
      passedOver(error)
      return false
    }
  }
  if (platform === 'darwin') {
    return (await execFileNoThrow('osascript', [
      '-e', `set theFile to open for access POSIX file "${path}" with write permission`,
      '-e', 'write (the clipboard as «class PNGf») to theFile',
      '-e', 'close access theFile',
    ])).code === 0
  }
  if (platform === 'win32') {
    return (await execFileNoThrow('powershell', [
      '-NoProfile', '-Command', `Add-Type -AssemblyName System.Drawing; $img = Get-Clipboard -Format Image; if ($null -eq $img) { exit 1 }; $img.Save('${escapeForPowershellSingleQuotes(path)}', [System.Drawing.Imaging.ImageFormat]::Png); exit 0`,
    ])).code === 0
  }
  for (const type of ['image/png', 'image/bmp']) {
    const commands = [
      ['xclip', ['-selection', 'clipboard', '-t', type, '-o']],
      ['wl-paste', ['--type', type]],
    ] as const
    for (const [program, args] of commands) {
      let bytes: Uint8Array
      try {
        const result = await execa(program, args, { encoding: 'buffer', windowsHide: true, timeout: 2000 })
        if (result.exitCode !== 0 || !result.stdout.length) continue
        bytes = result.stdout
      } catch (error) {
        passedOver(error)
        continue
      }
      await writeFile(path, bytes)
      return true
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
      `Remove-Item -ErrorAction SilentlyContinue '${escapeForPowershellSingleQuotes(path)}'`,
    ]).catch(passedOver)
    return
  }
  void execFileNoThrow('rm', ['-f', path]).catch(passedOver)
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
  if (!(await checkClipboardImage(platform))) return null
  await mkdir(pasteArtifactDir(), { recursive: true })
  if (!(await saveClipboardImage(platform, path))) return null
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

async function getImagePathFromClipboard(): Promise<string | null> {
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
  return asImageFilePath(text) !== null
}

export function asImageFilePath(text: string): string | null {
  const path = cleanPath(text)
  return /\.(?:png|jpe?g|gif|webp)$/i.test(path) ? path : null
}


export async function tryReadImageFromPath(
  text: string,
): Promise<(ImageWithDimensions & { path: string }) | null> {
  const path = asImageFilePath(text)
  if (path === null) return null
  const fs = getFsImplementation()
  let source = path
  if (!isAbsolute(path)) {
    source = resolve(path)
    if (!fs.existsSync(source)) {
      const clipboard = await getImagePathFromClipboard()
      if (clipboard === null || basename(clipboard) !== basename(path)) return null
      source = clipboard
    }
  }
  let raw: Buffer
  try {
    raw = await fs.readFileBytes(source)
  } catch (error) {
    logError(error)
    return null
  }
  if (!raw.length) {
    logForDebugging(`imagePaste: pasted image file is empty: ${source}`)
    return null
  }
  const normalized = await normalizeBmp(raw)
  const extension = extname(path).slice(1).toLowerCase() || 'png'
  const resized = await maybeResizeAndDownsampleImageBuffer(normalized, normalized.length, extension)
  const base64 = resized.buffer.toString('base64')
  return { base64, mediaType: detectImageFormatFromBase64(base64), dimensions: resized.dimensions, byteLength: resized.buffer.length, path }
}
