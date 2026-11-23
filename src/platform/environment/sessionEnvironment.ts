import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { flagEnv } from '../substrate/flagRegistry.js'
import { getSessionId } from '../../boot/process-state/processState.js'
import { logForDebugging } from '../logs/debugLog.js'
import { getMercuryHome } from './envUtils.js'
import { isENOENT } from '../errors/errors.js'
import { passedOver } from '../errors/passedOver.js'
import { decodeShellScriptBytes } from '../host-os/spawn.js'
import { isOneOf } from '../primitives/isOneOf.js'


const ENV_FILE_EVENTS = ['session.start', 'file.changed'] as const
type SessionEnvHookEvent = (typeof ENV_FILE_EVENTS)[number]

export function hookEventWritesEnvFile(event: string): event is SessionEnvHookEvent {
  return isOneOf(ENV_FILE_EVENTS, event)
}

function fragmentFamily(event: SessionEnvHookEvent): string {
  return event.replace('.', '-')
}

function eventRank(family: string): number {
  const index = ENV_FILE_EVENTS.findIndex(event => fragmentFamily(event) === family)
  return index === -1 ? ENV_FILE_EVENTS.length : index
}

const FRAGMENT_PATTERN = /^([a-z]+-[a-z]+)-hook-(\d+)\.sh$/

function sessionEnvDirPath(): string {
  return join(getMercuryHome(), 'session-env', getSessionId())
}

async function getSessionEnvDirPath(): Promise<string> {
  const dir = sessionEnvDirPath()
  await mkdir(dir, { recursive: true })
  return dir
}
export async function getHookEnvFilePath(hookEvent: SessionEnvHookEvent, hookIndex: number): Promise<string> {
  const dir = await getSessionEnvDirPath()
  return join(dir, `${fragmentFamily(hookEvent)}-hook-${hookIndex}.sh`)
}

type CacheState =
  | { state: 'not-loaded'; epoch: number }
  | { state: 'absent'; key: string; epoch: number }
  | { state: 'loaded'; key: string; script: string; epoch: number }

let cache: CacheState = { state: 'not-loaded', epoch: 0 }

function resolveFilesystemPath(path: string): string {
  try {
    return resolve(path)
  } catch (error) {
    passedOver(error)
    return path
  }
}

function resolveSessionEnvFile(): string | undefined {
  const envFile = flagEnv('MERCURY_ENV_FILE')
  return envFile ? resolveFilesystemPath(envFile) : undefined
}

function sessionEnvCacheKey(dir: string, envFile: string | undefined): string {
  return `${dir}\0${envFile ?? ''}`
}

export function invalidateSessionEnvCache(): void {
  cache = { state: 'not-loaded', epoch: cache.epoch + 1 }
  logForDebugging('sessionEnvironment: cache invalidated')
}

async function readFragments(dir: string): Promise<{ fragments: string[]; failed: boolean }> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    if (isENOENT(error)) return { fragments: [], failed: false }
    passedOver(error)
    const code = (error as NodeJS.ErrnoException | null)?.code ?? String(error)
    logForDebugging(`sessionEnvironment: failed to list ${dir} (${code}): ${String(error)}`)
    return { fragments: [], failed: true }
  }
  const matched = entries
    .map(name => {
      const match = FRAGMENT_PATTERN.exec(name)
      return match ? { name, event: match[1] as string, index: parseInt(match[2] as string, 10) } : null
    })
    .filter((entry): entry is { name: string; event: string; index: number } => entry !== null)
    .sort((a, b) => {
      const rank = eventRank(a.event) - eventRank(b.event)
      if (rank !== 0) return rank
      return a.index - b.index
    })
  const fragments: string[] = []
  let failed = false
  for (const entry of matched) {
    const fragmentPath = join(dir, entry.name)
    try {
      const content = await readScript(fragmentPath)
      if (content !== '') fragments.push(content)
    } catch (err) {
      if (!isENOENT(err)) {
        failed = true
        const code = (err as NodeJS.ErrnoException | null)?.code ?? String(err)
        logForDebugging(`sessionEnvironment: failed to read ${fragmentPath} (${code}): ${String(err)}`)
      }
    }
  }
  return { fragments, failed }
}

async function readScript(path: string): Promise<string> {
  return decodeShellScriptBytes(await readFile(path))
}

export async function getSessionEnvironmentScript(windowsBash = false): Promise<string | null> {
  if (process.platform === 'win32' && !windowsBash) {
    logForDebugging('sessionEnvironment: read on Windows by the bash roads alone')
    return null
  }
  const dir = resolveFilesystemPath(sessionEnvDirPath())
  const envFile = resolveSessionEnvFile()
  const key = sessionEnvCacheKey(dir, envFile)
  if (cache.state === 'absent' && cache.key === key) return null
  if (cache.state === 'loaded' && cache.key === key) return cache.script
  const epoch = cache.epoch
  const parts: string[] = []
  let failed = false
  if (envFile) {
    try {
      const content = await readScript(envFile)
      if (content !== '') parts.push(content)
    } catch (err) {
      if (!isENOENT(err)) {
        failed = true
        const code = (err as NodeJS.ErrnoException | null)?.code ?? String(err)
        logForDebugging(`sessionEnvironment: failed to read ${envFile} (${code}): ${String(err)}`)
      }
    }
  }
  const { fragments, failed: fragmentsFailed } = await readFragments(dir)
  failed ||= fragmentsFailed
  parts.push(...fragments)
  logForDebugging(`sessionEnvironment: ${fragments.length} hook file(s) loaded; script length ${parts.join('\n').length}`)
  const currentKey = sessionEnvCacheKey(resolveFilesystemPath(sessionEnvDirPath()), resolveSessionEnvFile())
  const cacheable = !failed && cache.epoch === epoch && currentKey === key
  if (parts.length === 0) {
    if (cacheable) cache = { state: 'absent', key, epoch }
    return null
  }
  const script = parts.join('\n')
  if (cacheable) cache = { state: 'loaded', key, script, epoch }
  return script
}

