import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { execa } from 'execa'
import { execFileNoThrow } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import { getImageProcessor } from './imageProcessor/imageProcessor.js'
import {
  detectImageFormatFromBase64,
  maybeResizeAndDownsampleImageBuffer,
  type ImageDimensions,
} from './imageResizer.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { logError } from './log.js'
import { logForDebugging } from './debug.js'
import { escapeForPowershellSingleQuotes } from './powershellLiteral.js'
import { passedOver } from './passedOver.js'
import { hostEnv } from './hostEnv.js'
import { normalizedOsPlatform } from './platform/programs.js'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'

export const PASTE_THRESHOLD: Unbuilt = unbuilt('src/utils/imagePaste.ts:22')

type ImageWithDimensions = Unbuilt


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
  return notBuilt('src/utils/imagePaste.ts:75')
}

async function saveClipboardImage(platform: ClipboardPlatform, path: string): Promise<boolean> {
  return notBuilt('src/utils/imagePaste.ts:97')
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
  return notBuilt('src/utils/imagePaste.ts:241')
}

export function asImageFilePath(text: string): string | null {
  return notBuilt('src/utils/imagePaste.ts:245')
}


export async function tryReadImageFromPath(
  text: string,
): Promise<(ImageWithDimensions & { path: string }) | null> {
  return notBuilt('src/utils/imagePaste.ts:251')
}
