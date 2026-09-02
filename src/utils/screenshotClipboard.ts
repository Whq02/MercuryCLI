import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ansiToPng, type AnsiToPngOptions } from './ansiToPng.js'
import { errorMessage } from './errors.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { logError } from './log.js'
import { getPlatform } from './platform.js'

/**
 * ANSI text → PNG → the system clipboard. The pipeline is pure in-process
 * (bitmap-font render, PNG encode), so the same code works in the compiled
 * binary and the script build alike.
 */

export type CopyResult = { success: boolean; message: string }

const SCRIPT_TIMEOUT_MS = 5000

async function macCopy(filePath: string): Promise<CopyResult> {
  // POSIX-file coercion + the PNGf class token: no other spelling puts an
  // image (rather than a path string) on the pasteboard.
  const escaped = filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const script = `set the clipboard to (read (POSIX file "${escaped}") as «class PNGf»)`
  const result = await execFileNoThrow('osascript', ['-e', script], { timeout: SCRIPT_TIMEOUT_MS, useCwd: false })
  if (result.code !== 0) return { success: false, message: result.stderr.trim() || 'Failed to copy the screenshot' }
  return { success: true, message: 'Screenshot copied to the clipboard' }
}

async function linuxCopy(filePath: string): Promise<CopyResult> {
  const xclip = await execFileNoThrow('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-i', filePath], {
    timeout: SCRIPT_TIMEOUT_MS,
    useCwd: false,
  })
  if (xclip.code === 0) return { success: true, message: 'Screenshot copied to the clipboard' }
  // Reproduced as observed: the fallback is given no file path and no piped
  // stdin, so it cannot in practice place the image (recorded, not fixed).
  const xsel = await execFileNoThrow('xsel', ['--clipboard', '--input', '-t', 'image/png'], {
    timeout: SCRIPT_TIMEOUT_MS,
    useCwd: false,
  })
  if (xsel.code === 0) return { success: true, message: 'Screenshot copied to the clipboard' }
  return {
    success: false,
    message: 'Failed to copy the screenshot. Install xclip or xsel (for example: sudo apt-get install xclip).',
  }
}

async function windowsCopy(filePath: string): Promise<CopyResult> {
  const escaped = filePath.replace(/'/g, "''")
  const script =
    `Add-Type -AssemblyName System.Windows.Forms; ` +
    `[System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('${escaped}'))`
  const result = await execFileNoThrow('powershell', ['-NoProfile', '-Command', script], {
    timeout: SCRIPT_TIMEOUT_MS,
    useCwd: false,
  })
  if (result.code !== 0) return { success: false, message: result.stderr.trim() || 'Failed to copy the screenshot' }
  return { success: true, message: 'Screenshot copied to the clipboard' }
}

export async function copyAnsiToClipboard(ansiText: string, options?: AnsiToPngOptions): Promise<CopyResult> {
  try {
    const directory = join(tmpdir(), 'mercury-screenshots')
    await mkdir(directory, { recursive: true })
    const filePath = join(directory, `screenshot-${Date.now()}.png`)
    await writeFile(filePath, ansiToPng(ansiText, options))
    try {
      // Dispatch on the COARSE classification: a WSL host takes the
      // unsupported branch, not the X-clipboard one.
      switch (getPlatform()) {
        case 'macos':
          return await macCopy(filePath)
        case 'linux':
          return await linuxCopy(filePath)
        case 'windows':
          return await windowsCopy(filePath)
        default:
          return { success: false, message: `Screenshot copy is not supported on ${getPlatform()}` }
      }
    } finally {
      unlink(filePath).catch(() => {})
    }
  } catch (err) {
    logError(err)
    return { success: false, message: errorMessage(err) || 'Unknown error copying the screenshot' }
  }
}
