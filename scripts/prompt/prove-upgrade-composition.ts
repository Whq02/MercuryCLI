import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { bindingDropsFor, handoffTurn, isHandoffRequest, startFixtureApi } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { runTurns } from '../lib/rows.ts'
import { MERCURY_CONSTITUTION } from '../../src/prompt/mercuryContract.ts'

const root = resolve(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'upgrade-composition-'))
const arg = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const dist = arg('--dist') ?? join(root, 'dist/mercury.mjs')
let baseDist = arg('--base-dist')
let failures = 0
const check = (name: string, good: boolean, detail = '') => { if (!good) failures++; console.log(`${good ? 'PASS' : 'FAIL'} ${name}${good || !detail ? '' : ` — ${detail}`}`) }
const systemTexts = (body: unknown): string[] => ((body as { system?: Array<{ text?: string }> }).system ?? []).map(block => block.text ?? '')
const oldWords = 'Operate for the operator first, and read the room'
const node = Bun.which('node')!
const run = (home: string, cwd: string, url: string, artifact: string, args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>(done => {
  const child = spawn(node, [artifact, 'run', ...args, '--model', 'claude-opus-4-8', '--format', 'rows'], { cwd, env: environment(home, url) })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const timer = setTimeout(() => child.kill('SIGKILL'), 120000)
  child.on('close', code => { clearTimeout(timer); done({ code, stdout, stderr }) })
})
const environment = (home: string, url: string): Record<string, string> => ({
  HOME: home, PATH: `/usr/bin:/bin:${dirname(node)}`, TERM: 'dumb',
  MERCURY_CONFIG_DIR: join(home, 'config'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', MERCURY_THINKING_BINDING: 'drop_block',
})
try {
  if (!baseDist) {
    const base = join(scratch, 'base')
    const baseOut = mkdtempSync(join(tmpdir(), 'upgrade-composition-dist-'))
    mkdirSync(base)
    const baseSpellings = ['961944cbb6', '04a4d2da3755', 'd6fce20666b4', 'v1.0.0-beta.31']
    const baseSha = baseSpellings.find(sha => spawnSync('git', ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { cwd: root }).status === 0)
    assert.ok(baseSha, `the 1.0.0-beta.31 base is on none of the spellings this checkout carries (${baseSpellings.join(' / ')})`)
    const archive = spawnSync('git', ['archive', baseSha], { cwd: root, maxBuffer: 256 * 1024 * 1024 })
    assert.equal(archive.status, 0, archive.stderr.toString())
    const unpack = spawnSync('tar', ['-xf', '-', '-C', base], { input: archive.stdout })
    assert.equal(unpack.status, 0, unpack.stderr.toString())
    symlinkSync(join(root, 'node_modules'), join(base, 'node_modules'))
    for (const name of readdirSync(join(root, 'vendor'))) {
      if (name === 'desktop' || existsSync(join(base, 'vendor', name))) continue
      symlinkSync(join(root, 'vendor', name), join(base, 'vendor', name))
    }
    const build = spawnSync('nice', ['-n', '10', process.execPath, 'run', 'build.ts'], { cwd: base, env: { ...process.env, MERCURY_CONFIG_DIR: join(scratch, 'build-home'), MERCURY_BUILD_OUTDIR: baseOut }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    assert.equal(build.status, 0, build.stdout + build.stderr)
    baseDist = join(baseOut, 'mercury.mjs')
  }
  for (const sidecar of [true, false]) {
    const home = join(scratch, sidecar ? 'kept' : 'missing')
    const cwd = join(home, 'work')
    mkdirSync(cwd, { recursive: true })
    const sid = crypto.randomUUID()
    const config = join(home, 'config')
    seedFirstRun(config, [cwd])
    const fixture = await startFixtureApi([
      { kind: 'text', text: 'RECORDED-ANSWER', thinking: 'Recorded thinking.', model: 'claude-opus-4-8' },
      { kind: 'text', text: 'RESUMED-ANSWER', thinking: 'Resumed thinking.', model: 'claude-opus-4-8' },
      { kind: 'text', text: 'NEXT-ANSWER', thinking: 'Next thinking.', model: 'claude-opus-4-8' },
      handoffTurn('The note.'),
      { kind: 'text', text: 'FORK-ANSWER', thinking: 'Fork thinking.', model: 'claude-opus-4-8' },
      handoffTurn('The fork note.'),
      { kind: 'text', text: '<summary>The work continues after the fold.</summary>', model: 'claude-opus-4-8' },
      { kind: 'text', text: 'AFTER-COMPACT', thinking: 'A fresh prefix.', model: 'claude-opus-4-8' },
      handoffTurn('The compacted note.'),
    ], { bindingCheck: true })
    try {
      const first = await run(home, cwd, fixture.url, baseDist, ['record this work', '--session-id', sid])
      assert.equal(first.code, 0, first.stderr)
      const original = fixture.messageRequests()[0]!
      assert.ok(systemTexts(original.body).join('\n').includes(oldWords), 'the transcript was produced by the actual release base')
      const ledger = join(config, 'sessions', sid, 'prefix-ledger.json')
      assert.ok(existsSync(ledger), 'the recording wrote its full prompt sidecar')
      if (!sidecar) rmSync(ledger)
      const resumed = await runTurns({ node, dist, cwd, env: environment(home, fixture.url), args: ['--resume', sid, '--model', 'claude-opus-4-8'], turns: ['resume this work', 'continue this work'], timeoutMs: 120000 })
      check(`${sidecar ? 'kept' : 'missing'} sidecar resume answers twice`, resumed.exit === 0 && resumed.stdout.includes('RESUMED-ANSWER') && resumed.stdout.includes('NEXT-ANSWER'), resumed.stderr.slice(-400))
      const requests = fixture.messageRequests().filter(request => !isHandoffRequest(request))
      const replay = systemTexts(requests[1]?.body ?? {})
      const drops = requests.slice(1).map(request => bindingDropsFor(request.body).length)
      if (sidecar) {
        check('the complete recorded prompt replays byte-equal', JSON.stringify(replay) === JSON.stringify(systemTexts(original.body)))
        check('the recorded whole carries neither the constitution nor lineage', !replay.join('\n').includes(MERCURY_CONSTITUTION) && !replay.join('\n').includes('# Lineage'))
        const toolNames = (body: unknown): string[] => ((body as { tools?: Array<{ name?: string }> }).tools ?? []).map(tool => tool.name ?? '')
        check('on a moved build the roster is decided afresh at the first request: the resumed request offers the live tools, not the recorded roster', JSON.stringify(toolNames(requests[1]?.body)) !== JSON.stringify(toolNames(original.body)) && toolNames(requests[1]?.body).includes('Crewmate') && !toolNames(requests[1]?.body).includes('Agent'), toolNames(requests[1]?.body).join(','))
        check('the recorded thinking, minted over the old roster, is dropped once at that request and never on the next (the prefix moved by its tools alone; the system replayed whole)', drops[0] === 1 && drops.slice(1).every(count => count === 0) && JSON.stringify(bindingDropsFor(requests[1]?.body)).includes('prefix_binding_mismatch'), JSON.stringify(drops))
      } else {
        const text = replay.join('\n')
        check('the missing-record leg sends the constitution whole with one identity and no old floor', text.includes(MERCURY_CONSTITUTION) && !text.includes(oldWords) && (text.match(/You are/g) ?? []).length === 1)
        check('the missing-record leg drops old thinking once, never on the next request', drops[0] === 1 && drops.slice(1).every(count => count === 0), JSON.stringify(drops))
        const oldThinking = JSON.stringify((requests[2]?.body as { messages?: unknown })?.messages ?? null)
        check('the dead reasoning is absent from the next request', !oldThinking.includes('Recorded thinking.'))
      }
      const transcriptFiles: string[] = []
      const walk = (dir: string) => { for (const file of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, file.name); if (file.isDirectory()) walk(path); else if (file.name === `${sid}.jsonl`) transcriptFiles.push(path) } }
      walk(join(config, 'projects'))
      const saved = transcriptFiles.map(path => readFileSync(path, 'utf8')).join('\n')
      check('the resumed composition is recorded for the next process', saved.includes(sidecar ? 'recorded-composition' : 'static-composition'))
      if (existsSync(ledger)) rmSync(ledger)
      const forkAt = fixture.messageRequests().length
      const forked = await run(home, cwd, fixture.url, dist, ['fork this work', '--resume', sid, '--fork'])
      const forkRequest = fixture.messageRequests()[forkAt]!
      check('a subsequent fork without a sidecar keeps the newly recorded whole', forked.code === 0 && forked.stdout.includes('FORK-ANSWER') && JSON.stringify(systemTexts(forkRequest.body)) === JSON.stringify(replay), forked.stderr.slice(-300))
      check('the fork drops no preserved reasoning', bindingDropsFor(forkRequest.body).length === 0)
      const compactAt = fixture.messageRequests().length
      const compacted = await runTurns({ node, dist, cwd, env: environment(home, fixture.url), args: ['--resume', sid, '--model', 'claude-opus-4-8'], turns: ['/compact', 'work after compact'], timeoutMs: 120000 })
      const after = fixture.messageRequests().slice(compactAt).find(request => JSON.stringify(request.body).includes('work after compact'))
      const afterText = systemTexts(after?.body ?? {}).join('\n')
      check('the lawful compact boundary adopts the live composition whole', compacted.exit === 0 && afterText.includes(MERCURY_CONSTITUTION) && !afterText.includes(oldWords) && (afterText.match(/You are/g) ?? []).length === 1, compacted.stderr.slice(-300))
    } finally {
      await fixture.close()
    }
  }
  if (failures) throw new Error(`${failures} upgrade composition checks failed`)
  console.log('UPGRADE COMPOSITION GREEN')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
