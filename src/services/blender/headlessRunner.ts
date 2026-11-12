import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { getCwd } from '../../utils/cwd.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { getMercuryTempDir } from '../../utils/permissions/filesystem.js'
import {
  BLENDER_BRIDGE_FILES,
  BLENDER_HEADLESS_DRIVER_SOURCE,
} from './bridgeFiles.generated.js'
import {
  BLENDER_BRIDGE_PYTHON_OUTPUT_CAP_BYTES,
  BLENDER_HEADLESS_RENDER_TIMEOUT_MS,
  type BlenderBridgeError,
} from './bridgeProtocol.js'

const HEADLESS_PYTHON_EXIT_CODE = '1'
const HEADLESS_DEFAULT_TIMEOUT_MS = 30_000
const HEADLESS_PYTHON_RUN_TIMEOUT_MS = 120_000
const HEADLESS_TIMEOUT_CAP_MS = 600_000

export function isHeadlessRenderJobRequest(
  op: string,
  args: Record<string, unknown> | undefined,
): boolean {
  if (op !== 'render_still' || !args) return false
  if (args.invoke === true || args.mode === 'job' || args.mode === 'invoke') return true
  return typeof args.executionContext === 'string' && args.executionContext.startsWith('INVOKE')
}

export function formatHeadlessWindowRefusal(port: number): string {
  return (
    `road: headless (no Blender process was started)\n` +
    `render_still failed: [WINDOW_REQUIRED] render_still's editor job/INVOKE_DEFAULT form needs a Blender window — no Blender process was started.\n` +
    `hint: omit invoke/mode to run render_still synchronously on the headless road, or open Blender with mercury_blender_bridge installed and enabled on 127.0.0.1:${port}`
  )
}

interface HeadlessDriverEnvelope {
  ok: boolean
  result?: unknown
  error?: BlenderBridgeError
  traceback?: string
  stdout?: string
  stderr?: string
  truncated?: { stdout: number; stderr: number }
}

function capByteTail(text: string, capBytes: number): { text: string; truncated: number } {
  const raw = Buffer.from(text, 'utf8')
  if (raw.byteLength <= capBytes) return { text, truncated: 0 }
  const over = raw.byteLength - capBytes
  return { text: raw.subarray(over).toString('utf8'), truncated: over }
}

function resolveHeadlessTimeoutMs(op: string, args: Record<string, unknown> | undefined): number {
  const override = args?.timeoutMs
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.min(HEADLESS_TIMEOUT_CAP_MS, Math.max(1, Math.floor(override)))
  }
  if (op === 'render_still') return BLENDER_HEADLESS_RENDER_TIMEOUT_MS
  if (op === 'python_run') return HEADLESS_PYTHON_RUN_TIMEOUT_MS
  return HEADLESS_DEFAULT_TIMEOUT_MS
}

function appendBlenderLines(lines: string[], blenderOut: string, blenderErr: string): void {
  const out = capByteTail(blenderOut, BLENDER_BRIDGE_PYTHON_OUTPUT_CAP_BYTES)
  const err = capByteTail(blenderErr, BLENDER_BRIDGE_PYTHON_OUTPUT_CAP_BYTES)
  if (out.text.length > 0) {
    lines.push(
      `blender stdout${out.truncated > 0 ? ` (truncated ${out.truncated} bytes)` : ''}:\n${out.text.trimEnd()}`,
    )
  }
  if (err.text.length > 0) {
    lines.push(
      `blender stderr${err.truncated > 0 ? ` (truncated ${err.truncated} bytes)` : ''}:\n${err.text.trimEnd()}`,
    )
  }
}

export async function runBlenderHeadlessOp(opts: {
  bin: string
  op: string
  args?: Record<string, unknown>
  blend?: string
  abortSignal?: AbortSignal
}): Promise<string> {
  const ceilingMs = resolveHeadlessTimeoutMs(opts.op, opts.args)
  const baseTmp = getMercuryTempDir()
  mkdirSync(baseTmp, { recursive: true })
  const callDir = mkdtempSync(path.join(baseTmp, 'blender-headless-'))
  try {
    for (const f of BLENDER_BRIDGE_FILES) {
      if (!f.path.endsWith('.py')) continue
      const target = path.join(callDir, f.path)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, f.content, 'utf8')
    }
    const driverPath = path.join(callDir, 'driver.py')
    writeFileSync(driverPath, BLENDER_HEADLESS_DRIVER_SOURCE, 'utf8')
    const requestPath = path.join(callDir, 'request.json')
    const responsePath = path.join(callDir, 'response.json')
    const forwardArgs: Record<string, unknown> = {}
    if (opts.args) {
      for (const [k, v] of Object.entries(opts.args)) {
        if (k === 'blend' || k === 'timeoutMs') continue
        forwardArgs[k] = v
      }
    }
    writeFileSync(
      requestPath,
      JSON.stringify({
        op: opts.op,
        args: forwardArgs,
        ...(opts.blend ? { blend: opts.blend } : {}),
      }),
      'utf8',
    )
    const t0 = Date.now()
    const outcome = await execFileNoThrowWithCwd(
      opts.bin,
      [
        '-b',
        '-q',
        '--factory-startup',
        '--disable-autoexec',
        '--python-exit-code',
        HEADLESS_PYTHON_EXIT_CODE,
        '--offline-mode',
        '--python',
        driverPath,
        '--',
        requestPath,
        responsePath,
      ],
      {
        cwd: getCwd(),
        timeout: ceilingMs,
        abortSignal: opts.abortSignal,
        stdin: 'ignore',
        maxBuffer: 8 * 1024 * 1024,
      },
    )
    const elapsedMs = Date.now() - t0
    const lines: string[] = [
      `road: headless (${opts.bin} -b)`,
      `exit status: ${outcome.code}`,
    ]
    if (existsSync(responsePath)) {
      let envelope: HeadlessDriverEnvelope | null = null
      try {
        envelope = JSON.parse(readFileSync(responsePath, 'utf8')) as HeadlessDriverEnvelope
      } catch {
        envelope = null
      }
      if (envelope && envelope.ok) {
        lines.push(
          typeof envelope.result === 'string'
            ? envelope.result
            : (JSON.stringify(envelope.result, null, 2) ?? String(envelope.result)),
        )
        appendBlenderLines(lines, outcome.stdout, outcome.stderr)
        return lines.join('\n')
      }
      if (envelope && !envelope.ok && envelope.error) {
        lines.push(
          `${opts.op} failed: [${envelope.error.code}] ${envelope.error.message}${
            envelope.error.hint ? `\nhint: ${envelope.error.hint}` : ''
          }`,
        )
        if (envelope.traceback && envelope.traceback.length > 0) {
          lines.push(`traceback:\n${envelope.traceback.trimEnd()}`)
        }
        if (envelope.stdout && envelope.stdout.length > 0) {
          const t = envelope.truncated?.stdout ?? 0
          lines.push(
            `script stdout${t > 0 ? ` (truncated ${t} bytes)` : ''}:\n${envelope.stdout.trimEnd()}`,
          )
        }
        if (envelope.stderr && envelope.stderr.length > 0) {
          const t = envelope.truncated?.stderr ?? 0
          lines.push(
            `script stderr${t > 0 ? ` (truncated ${t} bytes)` : ''}:\n${envelope.stderr.trimEnd()}`,
          )
        }
        appendBlenderLines(lines, outcome.stdout, outcome.stderr)
        return lines.join('\n')
      }
    }
    const timedOut =
      /timed?\s*out|ETIMEDOUT/i.test(outcome.error ?? '') ||
      (outcome.code !== 0 && elapsedMs >= ceilingMs - 25 && /SIGTERM|SIGKILL/i.test(outcome.error ?? ''))
    if (timedOut) {
      lines.push(
        `${opts.op} failed: [REQUEST_TIMEOUT] headless Blender timed out after ${ceilingMs}ms and was terminated`,
      )
    } else {
      lines.push(
        `${opts.op} failed: [HEADLESS_EXIT] Blender exited with status ${outcome.code}${
          outcome.error ? ` (${outcome.error})` : ''
        }`,
      )
    }
    appendBlenderLines(lines, outcome.stdout, outcome.stderr)
    return lines.join('\n')
  } finally {
    rmSync(callDir, { recursive: true, force: true })
  }
}
