import { spawnSync } from 'node:child_process'
import { captureEngineEntry, type AvailableCaptureDriver } from './captureDriver.ts'

export type CapturePreflight =
  | { ok: true; emulator: string }
  | { ok: false; reason: string; remedy: string }

const preflightCache = new Map<string, CapturePreflight>()

export const CAPTURE_PREFLIGHT_MISSING_EXIT = 78

export function preflightCaptureDriver(
  driver: AvailableCaptureDriver,
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): CapturePreflight {
  const key = `${driver.kind}\0${driver.python}\0${env.HOME ?? ''}\0${env.PYTHONPATH ?? ''}\0${env.MERCURY_VSHOT_EMULATOR ?? ''}`
  const cached = preflightCache.get(key)
  if (cached !== undefined) return cached
  const res = spawnSync(driver.python, [captureEngineEntry(driver, repoRoot), '--preflight'], { encoding: 'utf8', env, timeout: 15_000 })
  const answer: CapturePreflight =
    res.status === 0
      ? { ok: true, emulator: (res.stdout ?? '').trim() }
      : {
          ok: false,
          reason:
            res.error !== undefined
              ? `the capture engine's preflight did not run under ${driver.python} (${res.error.message})`
              : `the capture engine cannot start (exit ${res.status ?? `signal ${res.signal ?? 'unknown'}`})`,
          remedy: (res.stderr ?? '').trim() || `run the engine's --preflight by hand under ${driver.python} for the exact line`,
        }
  preflightCache.set(key, answer)
  return answer
}

export function describeCapturePreflight(answer: CapturePreflight): string {
  if (answer.ok) return answer.emulator
  return `${answer.reason}\n${answer.remedy
    .split('\n')
    .map(l => `  ${l.trim()}`)
    .join('\n')}`
}
