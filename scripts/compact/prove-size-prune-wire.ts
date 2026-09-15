#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { startOverflowFixture, type Captured, type ScriptedCall, type Turn } from './overflowFixture.ts'

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const root = resolve(import.meta.dir, '../..')
const dist = resolve(arg('--dist') ?? join(root, 'dist/mercury.mjs'))
const output = resolve(arg('--output') ?? mkdtempSync(join(tmpdir(), 'size-prune-evidence-')))
mkdirSync(output, { recursive: true })
const home = mkdtempSync(join(output, 'world-'))
const cwd = join(home, 'work')
const config = join(home, 'config')
mkdirSync(cwd)
mkdirSync(config)
mkdirSync(join(cwd, 'skills'))
const model = arg('--model') ?? 'gpt-5.6-sol'
const limit = Number(arg('--limit') ?? 240_000)
const rounds = Number(arg('--rounds') ?? 30)
const node = join(dirname(dist), 'vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const fixture = await startOverflowFixture()
const payload = Array.from({ length: process.argv.includes('--bounded-window') ? 192 : 384 }, (_, i) => `entry ${String(i).padStart(3, '0')}: the module records the complete current file contents and keeps its checks repeatable.\n`).join('')
const paths = [join(cwd, 'alpha.txt'), join(cwd, 'beta.txt')]
for (const path of paths) writeFileSync(path, `revision 0\n${payload}`)
writeFileSync(join(cwd, 'skills', 'reference.txt'), `PROTECTED_REFERENCE\n${payload.slice(0, 2000)}`)
writeFileSync(join(cwd, 'unique.txt'), `UNIQUE_REFERENCE\n${payload.slice(0, 2000)}`)
writeFileSync(join(config, '.mercury.json'), JSON.stringify({
  hasCompletedOnboarding: true,
  lastOnboardingVersion: '99.0.0',
  numStartups: 10,
  projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  customApiKeyResponses: { approved: ['proof-key-ci-gate-not-a-real-key'.slice(-20)], rejected: [] },
}))
writeFileSync(join(config, 'settings.json'), '{}')

const calls: ScriptedCall[] = [
  { id: 'protected_read', name: 'Read', args: JSON.stringify({ file_path: join(cwd, 'skills', 'reference.txt') }) },
  { id: 'unique_read', name: 'Read', args: JSON.stringify({ file_path: join(cwd, 'unique.txt') }) },
]
for (let round = 0; round < rounds; round++) {
  const file_path = paths[round % paths.length]!
  const version = Math.floor(round / paths.length)
  calls.push({ id: `read_${round}`, name: 'Read', args: JSON.stringify({ file_path }) })
  calls.push({ id: `edit_${round}`, name: 'Edit', args: JSON.stringify({ file_path, old_string: `revision ${version}`, new_string: `revision ${version + 1}` }) })
}
const callById = new Map(calls.map(call => [call.id, call]))
type Result = { id: string; text: string; error: boolean }
const textOf = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content)
  ? content.map(block => typeof block?.text === 'string' ? block.text : '').join('\n') : ''
function resultsOf(request: Captured): Result[] {
  if (request.dialect === 'responses') {
    return (request.body.input as Array<Record<string, unknown>> ?? []).filter(item => item.type === 'function_call_output')
      .map(item => ({ id: String(item.call_id), text: textOf(item.output), error: false }))
  }
  const messages = request.body.messages as Array<Record<string, unknown>> ?? []
  if (request.dialect === 'chat') {
    return messages.filter(item => item.role === 'tool').map(item => ({ id: String(item.tool_call_id), text: textOf(item.content), error: false }))
  }
  return messages.flatMap(item => Array.isArray(item.content) ? item.content
    .filter(block => block.type === 'tool_result')
    .map(block => ({ id: String(block.tool_use_id), text: textOf(block.content), error: block.is_error === true })) : [])
}
const placeholder = (text: string): boolean => text.startsWith('[stale tool result pruned') || text.startsWith('[stale tool result · digest:')
const measurements: Array<Record<string, unknown>> = []
let nextCall = 0
let refusals = 0
fixture.inputRule = true
fixture.script((request): Turn => {
  const results = resultsOf(request)
  const input = Math.ceil(JSON.stringify(request.body).length / 4)
  const byPath = new Map<string, string>()
  const superseded = new Set<string>()
  for (const result of results) {
    const call = callById.get(result.id)
    if (call === undefined || result.error) continue
    const path = (JSON.parse(call.args) as { file_path: string }).file_path
    const prior = byPath.get(path)
    if (prior !== undefined) superseded.add(prior)
    byPath.set(path, result.id)
  }
  const row = {
    request: measurements.length + 1,
    dialect: request.dialect,
    inputTokens: input,
    cachedInputTokens: 0,
    uncachedInputTokens: input,
    resultCount: results.length,
    carriedSuperseded: results.filter(result => superseded.has(result.id) && !placeholder(result.text)).map(result => result.id),
    prunedIds: results.filter(result => placeholder(result.text)).map(result => result.id),
    resultChars: Object.fromEntries(results.map(result => [result.id, result.text.length])),
    protectedPresent: results.some(result => result.id === 'protected_read' && result.text.includes('PROTECTED_REFERENCE')),
    uniquePresent: results.some(result => result.id === 'unique_read' && result.text.includes('UNIQUE_REFERENCE')),
    refused: input > limit,
  }
  measurements.push(row)
  writeFileSync(join(output, 'requests.json'), JSON.stringify(measurements, null, 2) + '\n')
  if (input > limit) {
    refusals++
    writeFileSync(join(output, `refused-${refusals}.json`), JSON.stringify(request.body) + '\n')
    return { error: { status: 400, body: request.dialect === 'anthropic'
      ? { type: 'error', error: { type: 'invalid_request_error', message: `prompt is too long: ${input} tokens > ${limit} maximum` } }
      : { error: { type: 'invalid_request_error', code: 'context_length_exceeded', message: `This model's maximum context length is ${limit} tokens. However, your messages resulted in ${input} tokens. Please reduce the length of the messages.` } } } }
  }
  const call = calls[nextCall++]
  if (call !== undefined) return { calls: [call], usage: { input, output: 40 } }
  return { text: 'The file revisions are complete.', usage: { input, output: 12 } }
})

const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  HOME: home,
  USERPROFILE: home,
  TMPDIR: home,
  TMP: home,
  TEMP: home,
  LANG: 'en_US.UTF-8',
  ...fixture.env,
  MERCURY_CONFIG_DIR: config,
  MERCURY_DAEMON_DIR: join(home, 'daemon'),
  MERCURY_TEAMS_DIR: join(home, 'teams'),
  MERCURY_TABULA_DIR: join(home, 'tabula'),
  MERCURY_HOME: join(home, 'product-home'),
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_VERIFY_EVIDENCE: '0',
  MERCURY_AUTO_COMPACT: '0',
  ...(process.argv.includes('--bounded-window') ? { MERCURY_DISABLE_1M_CONTEXT: '1' } : {}),
  ...(arg('--prune-pct') !== undefined ? { MERCURY_PRUNE_PCT: arg('--prune-pct')! } : {}),
  BROWSER: '/usr/bin/true',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
}
delete env.ANTHROPIC_AUTH_TOKEN
const proc = spawn(existsSync(node) ? node : 'node', [dist, '-p', '--model', model,
  '--allowed-tools', 'Edit', '--output-format', 'stream-json',
  'Read and update the scratch files until the requested revisions are complete.'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
let stdout = ''
let stderr = ''
proc.stdout.on('data', chunk => { stdout += String(chunk) })
proc.stderr.on('data', chunk => { stderr += String(chunk) })
const watchdog = setTimeout(() => { stderr += '\nfixture deadline exceeded\n'; proc.kill('SIGTERM') }, 210_000)
const exit = await new Promise<number | null>((resolveExit, reject) => { proc.once('exit', resolveExit); proc.once('error', reject) })
clearTimeout(watchdog)
await fixture.close()
writeFileSync(join(output, 'stdout.jsonl'), stdout)
writeFileSync(join(output, 'stderr.txt'), stderr)
const frames = stdout.split('\n').filter(line => line.startsWith('{')).flatMap(line => {
  try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] }
})
const notices = frames.filter(frame => frame.type === 'system' && !['init', 'status', 'turn_started'].includes(String(frame.subtype)))
const counts = measurements.map(row => row.inputTokens as number)
const firstRefusal = measurements.find(row => row.refused)
const accepted = measurements.filter(row => !row.refused)
const seenPruned = new Set<string>()
const pruneRequests = measurements.filter(row => {
  const ids = row.prunedIds as string[]
  const fresh = ids.some(id => !seenPruned.has(id))
  for (const id of ids) seenPruned.add(id)
  return fresh
}).map(row => Number(row.request))
const summary = {
  bundle: dist,
  bundleSha256: createHash('sha256').update(readFileSync(dist)).digest('hex'),
  model,
  home,
  cwd,
  limit,
  rounds,
  childExit: exit,
  requests: measurements.length,
  refusals,
  pruneThreshold: arg('--prune-pct') ?? 'default',
  boundedWindow: process.argv.includes('--bounded-window'),
  pruneCount: pruneRequests.length,
  pruneRequests,
  requestsBetweenPrunes: pruneRequests.slice(1).map((request, index) => request - pruneRequests[index]!),
  prunedResultCount: seenPruned.size,
  firstInputTokens: counts[0] ?? null,
  peakInputTokens: counts.length > 0 ? Math.max(...counts) : null,
  averageUncachedInputTokens: counts.length > 0 ? Math.round(counts.reduce((a, b) => a + b, 0) / counts.length) : null,
  averageAcceptedUncachedInputTokens: accepted.length > 0 ? Math.round(accepted.reduce((sum, row) => sum + Number(row.inputTokens), 0) / accepted.length) : null,
  supersededAtFirstRefusal: firstRefusal?.carriedSuperseded ?? [],
  prunedBeforeRefusal: measurements.some(row => !row.refused && (row.prunedIds as string[]).length > 0 && (firstRefusal === undefined || Number(row.request) < Number(firstRefusal.request))),
  notices,
  metering: 'fixture reports ceil(serialized request characters / 4), cached input zero; not a vendor tokenizer or billing measurement',
  isolation: 'automatic summary disabled so the replay measures pruning only; all provider bases and credentials point to the fixture',
}
writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
let failures = 0
const check = (label: string, passed: boolean): void => { if (!passed) failures++; console.log(`[${passed ? 'PASS' : 'FAIL'}] ${label}`) }
check('the built product completes the scripted file work', exit === 0 && stdout.includes('The file revisions are complete.'))
check('the replay makes every scripted Read and Edit', nextCall === calls.length + 1)
check('every edit landed in the scratch files', paths.every((path, index) => readFileSync(path, 'utf8').startsWith(`revision ${Math.ceil((rounds - index) / paths.length)}\n`)))
check('no tool result reports an error', !frames.some(frame => frame.type === 'user' && Array.isArray((frame.message as { content?: unknown })?.content) && ((frame.message as { content: Array<{ is_error?: boolean }> }).content).some(block => block.is_error === true)))
check('the provider input-pairing rule refuses nothing', fixture.refusals.length === 0)
check('the size prune lands before any provider refusal', summary.prunedBeforeRefusal)
check('the replay incurs no context refusals', refusals === 0)
check('a protected skill-file read remains on every later request', measurements.length > 2 && measurements.slice(1).every(row => row.protectedPresent))
check('a file result with no later same-path operation remains', measurements.length > 2 && measurements.slice(2).every(row => row.uniquePresent))
console.log(JSON.stringify({ ...summary, notices: notices.length }, null, 2))
console.log(`evidence: ${output}`)
process.exit(failures === 0 ? 0 : 1)
