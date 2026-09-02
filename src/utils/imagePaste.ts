// ============================================================================
//  Clipboard images and image paths: the three-platform check → save →
//  read → normalise pipeline, image-path recognition/cleaning, and
//  file-path → image reading with format normalisation.
//
//  The verdict lives in the EXIT CODE: a check that prints a boolean but
//  always exits zero makes an empty clipboard attach the STALE screenshot
//  from a previous paste. Likewise no save means no attachment.
// ============================================================================

import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { execa } from 'execa'
import { execFileNoThrow } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import { getImageProcessor } from '../tools/FileReadTool/imageProcessor.js'
import {
  detectImageFormatFromBase64,
  maybeResizeAndDownsampleImageBuffer,
  type ImageDimensions,
} from './imageResizer.js'
import { logError } from './log.js'
import { logForDebugging } from './debug.js'

/** Pasted text at or above this length becomes a reference chip. */
export const PASTE_THRESHOLD = 800

/** Recognised image extensions, anchored at the end (contract data — must
 *  stay in sync with the upload MIME table, or a recognised paste uploads
 *  as a generic byte stream with a broken remote thumbnail). */
export const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp)$/i

export type ImageWithDimensions = {
  base64: string
  mediaType: string
  dimensions?: ImageDimensions
}

// ── the temporary artifact ──────────────────────────────────────────────────

/** One fixed Mercury-named artifact shared by all three platforms; stale
 *  files written under an older name simply stop being read. */
const ARTIFACT_NAME = 'mercury_latest_screenshot.png'

type ClipboardPlatform = 'darwin' | 'linux' | 'win32'

/** Platform selection: anything outside the three supported platforms falls
 *  back to the Linux command set AND the Linux temp path. */
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

function artifactPath(): string {
  return join(tempDir(), ARTIFACT_NAME)
}

/** Single-quote escaping for the PowerShell string literal (apostrophes in
 *  user names broke the old interpolation). */
function psQuote(path: string): string {
  return path.replace(/'/g, "''")
}

// ── clipboard probe (macOS only) ────────────────────────────────────────────

/** Cheap "does the clipboard hold an image": macOS only (false everywhere
 *  else), success purely from the platform command's exit status. */
export async function hasImageInClipboard(): Promise<boolean> {
  if (clipboardPlatform() !== 'darwin') return false
  try {
    const result = await execFileNoThrow('osascript', ['-e', 'the clipboard as «class PNGf»'])
    return result.code === 0
  } catch {
    return false
  }
}

// ── check / save / read-path commands per platform ──────────────────────────

async function checkClipboardImage(platform: ClipboardPlatform): Promise<boolean> {
  if (platform === 'darwin') {
    const result = await execFileNoThrow('osascript', ['-e', 'the clipboard as «class PNGf»'])
    return result.code === 0
  }
  if (platform === 'win32') {
    const result = await execFileNoThrow('powershell', [
      '-NoProfile',
      '-Command',
      // The verdict must be the EXIT CODE: exit non-zero when no image.
      '$img = Get-Clipboard -Format Image; if ($null -eq $img) { exit 1 }; exit 0',
    ])
    return result.code === 0
  }
  // Linux: list the offered flavours — X TARGETS first, Wayland types as
  // the fallback — and match an image MIME type.
  const imageMime = /image\/(png|jpe?g|gif|webp|bmp)/i
  const xTargets = await execFileNoThrow('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'])
  if (xTargets.code === 0 && imageMime.test(xTargets.stdout)) return true
  const wlTypes = await execFileNoThrow('wl-paste', ['--list-types'])
  return wlTypes.code === 0 && imageMime.test(wlTypes.stdout)
}

async function saveClipboardImage(platform: ClipboardPlatform, path: string): Promise<boolean> {
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
      // The save must exit non-zero when the clipboard raced empty; the
      // path is single-quote-escaped for the shell language.
      `Add-Type -AssemblyName System.Drawing; $img = Get-Clipboard -Format Image; if ($null -eq $img) { exit 1 }; $img.Save('${psQuote(path)}', [System.Drawing.Imaging.ImageFormat]::Png); exit 0`,
    ])
    return result.code === 0
  }
  // Linux: an ordered four-step fallback chain — X/PNG → Wayland/PNG →
  // X/BMP → Wayland/BMP — each writing the artifact.
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
      // Try the next tool in the chain.
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
  // A platform shell command, not a filesystem call — fire-and-forget,
  // never awaited.
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

// ── normalisation ───────────────────────────────────────────────────────────

/** A payload whose first two bytes are the BMP magic converts to PNG (the
 *  WSL2 case: Windows offers BMP by default and the provider API rejects
 *  it). */
async function normalizeBmp(buffer: Buffer): Promise<Buffer> {
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    const sharp = await getImageProcessor()
    return sharp(buffer).png().toBuffer()
  }
  return buffer
}

// ── clipboard image acquisition ─────────────────────────────────────────────

export async function getImageFromClipboard(): Promise<ImageWithDimensions | null> {
  const platform = clipboardPlatform()
  const path = artifactPath()
  try {
    if (!(await checkClipboardImage(platform))) return null
    if (!(await saveClipboardImage(platform, path))) return null
    const raw = await getFsImplementation().readFileBytes(path)
    const normalized = await normalizeBmp(raw)
    const resized = await maybeResizeAndDownsampleImageBuffer(normalized, normalized.length, 'png')
    const base64 = resized.buffer.toString('base64')
    const mediaType = detectImageFormatFromBase64(base64)
    deleteArtifact(platform, path)
    return { base64, mediaType, dimensions: resized.dimensions }
  } catch {
    // Any error anywhere yields no image rather than propagating.
    return null
  }
}

export async function getImagePathFromClipboard(): Promise<string | null> {
  return readClipboardPathText(clipboardPlatform())
}

// ── path recognition and cleaning ───────────────────────────────────────────

/** Trim, remove one layer of matching outer quotes, then (non-Windows only)
 *  remove shell escape backslashes — preserving genuine double backslashes
 *  via a randomly SALTED placeholder, so a path containing the
 *  placeholder's own text cannot inject a backslash. */
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

// ── reading an image from a pasted path ─────────────────────────────────────

export async function tryReadImageFromPath(
  text: string,
): Promise<(ImageWithDimensions & { path: string }) | null> {
  const cleaned = asImageFilePath(text)
  if (cleaned === null) return null
  try {
    let readFrom: string | null = null
    if (isAbsolute(cleaned)) {
      readFrom = cleaned
    } else {
      // The VS Code terminal case: a copy-paste delivers only the file
      // name; when its base name matches the path on the clipboard, read
      // the clipboard path.
      const clipboardPath = await getImagePathFromClipboard()
      if (clipboardPath && basename(clipboardPath) === basename(cleaned)) {
        readFrom = clipboardPath
      }
    }
    if (readFrom === null) return null
    const raw = await getFsImplementation().readFileBytes(readFrom)
    if (raw.length === 0) {
      logForDebugging(`imagePaste: pasted image file is empty: ${readFrom}`)
      return null
    }
    const normalized = await normalizeBmp(raw)
    const ext = extname(cleaned).slice(1).toLowerCase() || 'png'
    const resized = await maybeResizeAndDownsampleImageBuffer(normalized, normalized.length, ext)
    const base64 = resized.buffer.toString('base64')
    const mediaType = detectImageFormatFromBase64(base64)
    // The reported path is the CLEANED PASTED path — in the clipboard
    // fallback case that is the bare file name the terminal delivered.
    // Callers use it for display, never for re-reading.
    return { base64, mediaType, dimensions: resized.dimensions, path: cleaned }
  } catch (error) {
    logError(error)
    return null
  }
}
