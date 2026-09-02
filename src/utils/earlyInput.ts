import { lastGrapheme } from './intl.js'

/**
 * Capture keystrokes typed between process launch and the interactive UI
 * being ready, so nothing the operator types during boot is lost.
 */

let capturing = false
let capturedBuffer = ''
let readableHandler: (() => void) | null = null

function processChunk(chunk: string): void {
  for (let i = 0; i < chunk.length; i++) {
    const code = chunk.charCodeAt(i)
    if (code === 3) {
      // Interrupt: the graceful-shutdown machinery is not initialised yet at
      // this point in startup, so a direct exit with the conventional
      // interrupt code is required.
      stopCapturingEarlyInput()
      process.exit(130)
    }
    if (code === 4) {
      // End-of-transmission.
      stopCapturingEarlyInput()
      return
    }
    if (code === 127 || code === 8) {
      // Backspace: remove the last grapheme cluster, falling back to one
      // code unit when the cluster length is zero.
      const cluster = lastGrapheme(capturedBuffer)
      capturedBuffer = capturedBuffer.slice(0, capturedBuffer.length - (cluster.length || 1))
      continue
    }
    if (code === 27) {
      // Escape sequence: discard it whole. The INTRODUCER of a CSI ('[',
      // 0x5b) or SS3 ('O', 0x4f) sequence itself sits in the terminating
      // range 0x40–0x7e, so a scan that starts on it stops there and the
      // real final byte leaks into the buffer — an arrow pressed during
      // startup seeded a literal 'A' into the composer (TASK-017
      // supplement, SURVIVED). Step past the introducer first, then scan
      // to the final byte; a bare two-char escape consumes one char.
      let j = i + 1
      const intro = chunk.charCodeAt(j)
      if (intro === 0x5b || intro === 0x4f) {
        j++
        while (j < chunk.length) {
          const terminator = chunk.charCodeAt(j)
          if (terminator >= 0x40 && terminator <= 0x7e) break
          j++
        }
      }
      i = j
      continue
    }
    if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) {
      continue
    }
    if (code === 13) {
      capturedBuffer += '\n'
      continue
    }
    capturedBuffer += chunk[i]
  }
}

/**
 * Begin capturing. A no-op unless stdin is a TTY, capture is not already
 * active, and argv contains neither print-mode flag — raw mode disables the
 * terminal's signal generation, which would make print mode
 * uninterruptible (a correctness requirement, not an optimisation).
 */
export function startCapturingEarlyInput(): void {
  if (!process.stdin.isTTY) return
  if (capturing) return
  if (process.argv.includes('--print') || process.argv.includes('-p')) return
  try {
    capturing = true
    capturedBuffer = ''
    process.stdin.setEncoding('utf8')
    process.stdin.setRawMode?.(true)
    if (process.stdout.isTTY) {
      // The FIRST terminal write after raw mode engages: a graphic reset.
      // The launcher's splash suppresses keystroke echo during hand-off by
      // setting the foreground colour equal to the background and hiding
      // the cursor — a property of the terminal that outlives the splash.
      // Raw mode has stopped echo anyway, and without this reset anything
      // printed during a failed boot (a stack trace, most importantly)
      // would be written in background colour and be unreadable. A no-op
      // when no splash ran.
      process.stdout.write('\u001b[0m')
    }
    process.stdin.ref()
    readableHandler = () => {
      // Drain synchronously in a loop, matching how the UI library will
      // later consume stdin.
      let chunk: string | Buffer | null
      while ((chunk = process.stdin.read() as string | Buffer | null) !== null) {
        processChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
      }
    }
    process.stdin.on('readable', readableHandler)
  } catch {
    // Any setup error silently disables capture.
    capturing = false
  }
}

/**
 * Stop capturing. Idempotent. Deliberately does NOT restore stdin's raw-mode
 * state — the UI mounts its own stdin handling at about the same moment and
 * disabling raw mode here interferes with it.
 */
export function stopCapturingEarlyInput(): void {
  if (!capturing) return
  capturing = false
  if (readableHandler) {
    process.stdin.off('readable', readableHandler)
    readableHandler = null
  }
}

/** Stop capturing, return the trimmed buffer, and clear it. */
export function consumeEarlyInput(): string {
  stopCapturingEarlyInput()
  const text = capturedBuffer.trim()
  capturedBuffer = ''
  return text
}

/** Whether the trimmed buffer is non-empty, without consuming it. */
export function hasEarlyInput(): boolean {
  return capturedBuffer.trim().length > 0
}

/** Pre-fill the buffer so text appears in the prompt; never auto-submits. */
export function seedEarlyInput(text: string): void {
  capturedBuffer = text
}

/** Test seam (the __setBurstCrHostForTest precedent): drive the chunk
 *  parser without a TTY. Provers only. */
export function __processEarlyChunkForTest(chunk: string): void {
  processChunk(chunk)
}

export function isCapturingEarlyInput(): boolean {
  return capturing
}
