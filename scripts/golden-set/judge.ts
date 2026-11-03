import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GoldenTask } from './tasks.ts'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

export interface GoldenToolCall {
  tool: string
  input: Record<string, unknown>
  index: number
  output?: string
  resultIndex?: number
  failed?: boolean
}

export interface GoldenJudgeInput {
  task: GoldenTask
  cwd: string
  configHome: string
  answer: string
  calls: readonly GoldenToolCall[]
  seconds: number
  outcomeStatus: string
}

interface GoldenVerdict {
  completed: boolean
  reasons: string[]
  wrongToolCalls: string[]
  changedFiles: string[]
}

export function fixtureSnapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
      else files[relative(root, path)] = '<not a regular file>'
    }
  }
  walk(root)
  return files
}

function changedFiles(actual: Record<string, string>, expected: Record<string, string>): string[] {
  return [...new Set([...Object.keys(actual), ...Object.keys(expected)])].filter(path => actual[path] !== expected[path]).sort()
}

function expectedSnapshot(replacements: Record<string, (text: string) => string>): Record<string, string> {
  const expected = fixtureSnapshot(FIXTURE)
  for (const [path, replace] of Object.entries(replacements)) {
    expected[path] = createHash('sha256').update(replace(readFileSync(join(FIXTURE, path), 'utf8'))).digest('hex')
  }
  return expected
}

function isScriptCall(call: GoldenToolCall, script: string): boolean {
  const invocation = new RegExp(`(?:^|[;&|\\n])\\s*(?:(?:bash|sh)\\s+)?[\"']?(?:[a-zA-Z0-9_./-]+/)?${script.replaceAll('.', '\\.')}[\"']?(?:\\s|$|[;&|])`)
  if (call.tool === 'Bash') return invocation.test(String(call.input.command ?? ''))
  if (call.tool === 'Eval') return /tool(?:\\.|\[).*Bash|tool\.Bash/.test(String(call.input.code ?? '')) && String(call.input.code ?? '').includes(script)
  return false
}

function isWatchdog(call: GoldenToolCall): boolean {
  const text = call.tool === 'Bash' ? String(call.input.command ?? '') : call.tool === 'Eval' ? String(call.input.code ?? '') : call.tool === 'Write' ? String(call.input.content ?? '') : ''
  return /watchdog|(?:while|until)[\s\S]*(?:kill -0|\bps\b|\bsleep\b)|sleep\s+\d+[\s\S]*\bkill\b|(?:setTimeout|subprocess\.run)[\s\S]*(?:kill|timeout\s*=)/i.test(text)
}

function contextSearch(calls: readonly GoldenToolCall[]): boolean {
  return calls.some(call => call.tool === 'ContextLeft' && !call.failed && calls.some(search =>
    search.tool === 'ToolSearch' && !search.failed && (search.resultIndex ?? Infinity) < call.index && /ContextLeft/i.test(search.output ?? ''),
  ))
}

function wrongTools(task: GoldenTask, calls: readonly GoldenToolCall[]): string[] {
  const wrong: string[] = []
  for (const call of calls) {
    const command = call.tool === 'Bash' ? String(call.input.command ?? '') : ''
    const labels: string[] = []
    if (/\b(?:cat|sed)\s+/.test(command)) labels.push('shell file read/edit instead of dedicated tool')
    if (task.id === 'T1' && isWatchdog(call)) labels.push('watchdog script/loop')
    if (task.id === 'T3' && call.tool === 'Edit') labels.push('separate Edit for the multi-file rename')
    if (task.id === 'T6' && /\b(?:curl|wget)\b/.test(command)) labels.push('curl/wget public-page request through Bash')
    if (task.id === 'T8' && call.tool === 'Write' && /\.md$/i.test(String(call.input.file_path ?? ''))) labels.push('unsolicited Markdown Write')
    if (labels.length) wrong.push(`${call.tool} #${call.index}: ${labels.join(', ')} — ${JSON.stringify(call.input).slice(0, 180)}`)
  }
  return wrong
}

export function judgeGoldenTask(input: GoldenJudgeInput): GoldenVerdict {
  const { task, answer, calls } = input
  const original = fixtureSnapshot(FIXTURE)
  const actual = fixtureSnapshot(input.cwd)
  const reasons: string[] = []
  let expected = original
  if (task.id === 'T2') expected = expectedSnapshot({ 'src/b.ts': text => text.replace("export const greeting = 'hello'", "export const greeting = 'hello there'") })
  if (task.id === 'T3') expected = expectedSnapshot({
    'src/a.ts': text => text.replaceAll('LIMIT', 'MAX_ITEMS'),
    'src/c.ts': text => text.replaceAll('LIMIT', 'MAX_ITEMS'),
  })
  if (task.id === 'T8') expected = expectedSnapshot({ 'src/util.ts': text => text.replace('retreiveFirstCell', 'retrieveFirstCell') })
  const unexpected = changedFiles(actual, expected)
  if (unexpected.length) reasons.push(`fixture state differs from required final state: ${unexpected.join(', ')}`)
  if (input.outcomeStatus !== 'completed') reasons.push(`headless outcome was ${input.outcomeStatus || 'missing'}`)
  if (task.id === 'T1') {
    const lines = readFileSync(join(FIXTURE, 'src/a.ts'), 'utf8').split('\n').length - 1
    if (!new RegExp(`(?:\\b${lines}\\s*lines?\\b|lines?\\s*[:=]?\\s*${lines}\\b|src/a\\.ts[\\s\\S]{0,40}\\b${lines}\\b)`, 'i').test(answer.replaceAll('*', ''))) reasons.push(`answer did not report ${lines} lines for src/a.ts`)
    if (!calls.some(call => isScriptCall(call, 'slow.sh'))) reasons.push('slow.sh was not run')
    if (input.seconds > 160) reasons.push(`run exceeded the bounded 160-second ceiling (${input.seconds.toFixed(1)}s)`)
    if (calls.some(isWatchdog)) reasons.push('a watchdog script or loop was used')
  }
  if (task.id === 'T3' && unexpected.length === 0) {
    const env: NodeJS.ProcessEnv = { ...process.env, MERCURY_CONFIG_DIR: input.configHome, TMPDIR: '/private/tmp/mw' }
    delete env.MERCURY_HOME
    const test = spawnSync('bun', ['test.ts'], { cwd: input.cwd, env, encoding: 'utf8', timeout: 15_000 })
    if (test.status !== 0) reasons.push(`fixture test failed: ${(test.stderr || test.stdout || String(test.error)).slice(0, 200)}`)
  }
  if (task.id === 'T4') {
    const text = answer.replaceAll('*', '')
    if (!/(?:\b(?:2|two)\b[^\n.]{0,40}\b(?:calls?|places?|sites?|locations?|files?)\b|\b(?:calls?|called|places?|sites?|locations?)\b[^\n.]{0,40}\b(?:2|two)\b)/i.test(text) || !text.includes('src/b.ts') || !text.includes('src/c.ts')) reasons.push('answer did not give two call sites in src/b.ts and src/c.ts')
    if (/\b(?:3|three)\s+(?:calls?|places?|sites?|locations?|files?)\b/i.test(text)) reasons.push('answer included a third call site')
  }
  if (task.id === 'T5' && !answer.includes('Parser Contract')) reasons.push('answer did not contain the exact page-2 heading Parser Contract')
  if (task.id === 'T6' && !answer.includes('Example Domain')) reasons.push('answer did not contain Example Domain')
  if (task.id === 'T7') {
    if (!contextSearch(calls)) reasons.push('ContextLeft was not loaded through ToolSearch and then called')
    const results = calls.filter(call => call.tool === 'ContextLeft' && !call.failed).map(call => call.output ?? '').join('\n')
    const remaining = [...results.matchAll(/Left until[^\n]*?:\s*([\d,]+)\s+tokens/g)].map(match => match[1]!.replaceAll(',', ''))
    const numbers = new Set([...answer.matchAll(/\d[\d,]*/g)].map(match => match[0].replaceAll(',', '')))
    if (!remaining.some(number => numbers.has(number))) reasons.push('answer did not report the remaining-token count measured by ContextLeft')
  }
  if (task.id === 'T9') {
    if (!answer.includes('noise line 60000')) reasons.push('answer did not contain the exact final line noise line 60000')
    if (!calls.some(call => isScriptCall(call, 'noisy.sh'))) reasons.push('noisy.sh was not run')
  }
  if (task.id === 'T10') {
    if (!/(?:\b0\b|\bzero\b|\bno\s+(?:`?FIXME`?\s+)?comments?\b|\bno\s+`?FIXME\b)/i.test(answer)) reasons.push('answer did not report zero FIXME comments')
    const errorClaim = answer.replace(/(?:not|isn't|is not)\s+(?:an?\s+)?(?:error|failure)/gi, '')
    if (/\b(?:could not|unable|failed|failure|error)\b/i.test(errorClaim)) reasons.push('answer treated the no-match result as an error')
  }
  return { completed: reasons.length === 0, reasons, wrongToolCalls: wrongTools(task, calls), changedFiles: changedFiles(actual, original) }
}
