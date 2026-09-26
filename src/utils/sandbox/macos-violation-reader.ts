import { spawn } from 'node:child_process'
import type { IgnoreViolationsConfig, SandboxViolationEvent } from '@anthropic-ai/sandbox-runtime'
import { logForDebugging } from '../debug.js'
import { subprocessEnv } from '../subprocessEnv.js'

export const MACOS_SANDBOX_NOISE: readonly string[] = [
  'mDNSResponder',
  'mach-lookup com.apple.diagnosticd',
  'mach-lookup com.apple.analyticsd',
  'sysctl-read kern.iossupportversion',
]

export const SANDBOX_LOG_PREDICATE = '(eventMessage ENDSWITH "_SBX")'

const TAG = /CMD64_([A-Za-z0-9+/=]*)_END(_[A-Za-z0-9_]*_SBX)/
const DETAILS = /Sandbox:\s+(.+)$/
const KEY_CHARS = 100
const TAIL_CAP = 65_536

export type ParsedSandboxEvent = { line: string; encodedCommand?: string; session?: string }
export type ViolationSink = { addViolation(event: SandboxViolationEvent): void }
export type MacOSViolationReader = { learn(wrapped: string): void; session(): string | null; stop(): void }

export function sessionTagOf(wrapped: string): string | null {
  return TAG.exec(wrapped)?.[2] ?? null
}

function isDenyLine(line: string): boolean {
  return line.includes('Sandbox:') && line.includes('deny')
}

export function parseSandboxLogLines(lines: readonly string[]): ParsedSandboxEvent[] {
  const events: ParsedSandboxEvent[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (!isDenyLine(line)) continue
    const details = DETAILS.exec(line)?.[1]
    if (details === undefined) continue
    const next = lines[index + 1] ?? ''
    const tag = next.startsWith('CMD64_') ? TAG.exec(next) : null
    const event: ParsedSandboxEvent = { line: details }
    if (tag?.[1] !== undefined && tag[2] !== undefined) {
      event.encodedCommand = tag[1]
      event.session = tag[2]
    }
    events.push(event)
  }
  return events
}

export class SandboxLogFeed {
  private tail = ''

  push(chunk: string): ParsedSandboxEvent[] {
    const lines = (this.tail + chunk).split('\n')
    this.tail = lines.pop() ?? ''
    const last = lines.at(-1)
    if (last !== undefined && isDenyLine(last)) {
      lines.pop()
      this.tail = `${last}\n${this.tail}`
    }
    if (this.tail.length > TAIL_CAP) this.tail = ''
    return parseSandboxLogLines(lines)
  }

  flush(): ParsedSandboxEvent[] {
    const lines = this.tail.split('\n')
    this.tail = ''
    return parseSandboxLogLines(lines)
  }
}

function commandOfKey(encodedCommand: string): string {
  return Buffer.from(encodedCommand, 'base64').toString('utf8').replace(/\p{Cc}+/gu, ' ').trim().slice(0, KEY_CHARS)
}

function ignoredByConfig(line: string, command: string | undefined, config: IgnoreViolationsConfig | undefined): boolean {
  if (!config) return false
  if ((config['*'] ?? []).some(pattern => line.includes(pattern))) return true
  if (command === undefined) return false
  return Object.entries(config).some(([match, patterns]) => match !== '*' && command.includes(match) && patterns.some(pattern => line.includes(pattern)))
}

export function violationDelivery(sink: ViolationSink, ignoreViolations: () => IgnoreViolationsConfig | undefined): (events: readonly ParsedSandboxEvent[], session: string | null) => void {
  return (events, session) => {
    for (const event of events) {
      if (session === null || event.session !== session) continue
      if (MACOS_SANDBOX_NOISE.some(noise => event.line.includes(noise))) continue
      const command = event.encodedCommand === undefined ? undefined : commandOfKey(event.encodedCommand)
      if (ignoredByConfig(event.line, command, ignoreViolations())) continue
      const record: SandboxViolationEvent = { line: event.line, timestamp: new Date() }
      if (command !== undefined) record.command = command
      if (event.encodedCommand !== undefined) record.encodedCommand = event.encodedCommand
      sink.addViolation(record)
    }
  }
}

export function startMacOSViolationReader(sink: ViolationSink, ignoreViolations: () => IgnoreViolationsConfig | undefined): MacOSViolationReader {
  let session: string | null = null
  const feed = new SandboxLogFeed()
  const deliver = violationDelivery(sink, ignoreViolations)
  const child = spawn('log', ['stream', '--predicate', SANDBOX_LOG_PREDICATE, '--style', 'compact'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: subprocessEnv(),
    windowsHide: true,
  })
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => deliver(feed.push(chunk), session))
  child.stdout?.on('end', () => deliver(feed.flush(), session))
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => logForDebugging(`sandbox monitor: log stream said ${chunk.trim()}`))
  child.on('error', error => logForDebugging(`sandbox monitor: log stream did not start — ${error.message}`))
  child.on('exit', code => logForDebugging(`sandbox monitor: log stream exited with ${String(code)}`))
  child.unref()
  const stop = (): void => {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
  }
  process.once('exit', stop)
  return {
    learn(wrapped) {
      if (session === null) session = sessionTagOf(wrapped)
    },
    session: () => session,
    stop() {
      process.off('exit', stop)
      stop()
    },
  }
}
