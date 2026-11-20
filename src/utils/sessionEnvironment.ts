import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { flagEnv } from '../substrate/flagRegistry.js'
import { getSessionId } from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { getMercuryHome } from './envUtils.js'
import { isENOENT } from './errors.js'
import { passedOver } from './passedOver.js'


const ENV_FILE_EVENTS = ['session.start', 'file.changed'] as const
type SessionEnvHookEvent = (typeof ENV_FILE_EVENTS)[number]

export function hookEventWritesEnvFile(event: string): event is SessionEnvHookEvent {
  return (ENV_FILE_EVENTS as readonly string[]).includes(event)
}

function fragmentFamily(event: SessionEnvHookEvent): string {
  return event.replace('.', '-')
}

function eventRank(family: string): number {
  const index = ENV_FILE_EVENTS.findIndex(event => fragmentFamily(event) === family)
  return index === -1 ? ENV_FILE_EVENTS.length : index
}

const FRAGMENT_PATTERN = /^([a-z]+-[a-z]+)-hook-(\d+)\.sh$/

async function getSessionEnvDirPath(): Promise<string> {
  const dir = join(getMercuryHome(), 'session-env', getSessionId())
  await mkdir(dir, { recursive: true })
  return dir
}

export async function getHookEnvFilePath(hookEvent: SessionEnvHookEvent, hookIndex: number): Promise<string> {
  const dir = await getSessionEnvDirPath()
  return join(dir, `${fragmentFamily(hookEvent)}-hook-${hookIndex}.sh`)
}

type CacheState = { state: 'not-loaded' } | { state: 'absent' } | { state: 'loaded'; script: string }

let cache: CacheState = { state: 'not-loaded' }

export function invalidateSessionEnvCache(): void {
  cache = { state: 'not-loaded' }
  logForDebugging('sessionEnvironment: cache invalidated')
}

async function readFragments(): Promise<string[]> {
  let dir: string
  try {
    dir = await getSessionEnvDirPath()
  } catch (error) {
    passedOver(error)
    return []
  }
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    passedOver(error)
    return []
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
  for (const entry of matched) {
    try {
      const content = await readScript(join(dir, entry.name))
      if (content !== '') fragments.push(content)
    } catch (err) {
      if (!isENOENT(err)) logForDebugging(`sessionEnvironment: failed to read ${entry.name}: ${String(err)}`)
    }
  }
  return fragments
}

async function readScript(path: string): Promise<string> {
  if (process.platform !== 'win32') return (await readFile(path, 'utf8')).trim()
  const bytes = await readFile(path)
  const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8').replace(/^\uFEFF/, '')
  return text.replace(/\r\n?/g, '\n').trim()
}

export async function getSessionEnvironmentScript(windowsBash = false): Promise<string | null> {
  if (process.platform === 'win32' && !windowsBash) {
    logForDebugging('sessionEnvironment: read on Windows by the bash roads alone')
    return null
  }
  if (cache.state === 'absent') return null
  if (cache.state === 'loaded') return cache.script
  const parts: string[] = []
  const envFile = flagEnv('MERCURY_ENV_FILE')
  if (envFile) {
    try {
      const content = await readScript(envFile)
      if (content !== '') parts.push(content)
    } catch (err) {
      if (!isENOENT(err)) logForDebugging(`sessionEnvironment: failed to read the env file: ${String(err)}`)
    }
  }
  const fragments = await readFragments()
  parts.push(...fragments)
  logForDebugging(`sessionEnvironment: ${fragments.length} hook file(s) loaded; script length ${parts.join('\n').length}`)
  if (parts.length === 0) {
    cache = { state: 'absent' }
    return null
  }
  const script = parts.join('\n')
  cache = { state: 'loaded', script }
  return script
}

