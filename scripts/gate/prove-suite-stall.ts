import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const root = resolve(import.meta.dir, '../..')
const work = mkdtempSync(join(tmpdir(), 'suite-stall-'))
const live = process.argv.includes('--live')
const health = process.argv.indexOf('--health-baseline')
const bun = process.env.BUN ?? process.execPath
const shell = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`

async function run(name: string, body: string, helper: string): Promise<{ rc: number; seconds: number; cpu: number; output: string; hang: string | null }> {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  const runner = join(dir, 'run-all.sh')
  writeFileSync(runner, body)
  const child = spawn('bash', [helper, runner, '900', dir, '', 'fixed'], { cwd: root, env: { ...process.env, BUN: bun }, stdio: ['ignore', 'pipe', 'pipe'] })
  let detail = ''
  child.stdout.on('data', chunk => { detail += chunk })
  child.stderr.on('data', chunk => { detail += chunk })
  const rc = await new Promise<number>((done, reject) => { child.once('error', reject); child.once('close', code => done(code ?? 1)) })
  assert.ok(existsSync(join(dir, `${name}.rc`)), detail)
  assert.equal(Number(readFileSync(join(dir, `${name}.rc`), 'utf8')), rc, detail)
  const output = readFileSync(join(dir, `${name}.out`), 'utf8')
  const seconds = Number(readFileSync(join(dir, `${name}.secs`), 'utf8'))
  const cpu = Number(readFileSync(join(dir, `${name}.cpu`), 'utf8'))
  const hang = existsSync(join(dir, `${name}.hang`)) ? readFileSync(join(dir, `${name}.hang`), 'utf8').trim() : null
  console.log(`${name}: rc=${rc} wall=${seconds}s cpu=${cpu}s hang=${hang ?? 'none'}`)
  if (rc !== 0) console.log(output)
  return { rc, seconds, cpu, output, hang }
}

try {
  let helper = join(root, 'scripts/gate/run-suite.sh')
  if (health >= 0) {
    const baseline = process.argv[health + 1]
    assert.ok(baseline, 'supply the unmodified run-suite.sh')
    const proofs = ['prove-activity-verbs-producer.ts', 'prove-advice-names-this-mercury.ts', 'prove-auth-routed-verdict.ts', 'prove-baseline-row-substance.ts', 'prove-boot-spine-order.ts', 'prove-boot-spine-setup-boundary.ts', 'prove-boot-spine-setup-screens.ts', 'prove-browser-row.ts', 'prove-cert-clean-hands.ts', 'prove-cert-core.ts']
    const body = `set -e\n${proofs.map(path => `echo ${shell(path)}\n${shell(bun)} run ${shell(join(root, 'scripts/health', path))}`).join('\n')}\n`
    const before = await run('health-before', body, resolve(baseline))
    const after = await run('health-after', body, helper)
    assert.equal(before.rc, 0)
    assert.equal(after.rc, before.rc)
    assert.equal(after.hang, null)
    assert.ok(Math.abs(after.seconds - before.seconds) <= Math.max(5, before.seconds * 0.25), 'health timings stay within five seconds or 25%')
    console.log('PASS ten health proofs keep their exit and timing with the stall watcher')
  } else {
    const duration = live ? 330 : 6
    const interval = live ? 60 : 0.6
    if (!live) {
      const scripts = join(work, 'scripts')
      mkdirSync(join(scripts, 'gate'), { recursive: true })
      symlinkSync(join(root, 'scripts/lib'), join(scripts, 'lib'), process.platform === 'win32' ? 'junction' : 'dir')
      const source = readFileSync(helper, 'utf8')
      assert.equal(source.split('sleep 1; n=$((n + 1))').length, 2)
      helper = join(scripts, 'gate/run-suite.sh')
      writeFileSync(helper, source.replace('sleep 1; n=$((n + 1))', 'sleep 0.01; n=$((n + 1))'))
    }
    const [idle, output, cpu] = await Promise.all([
      run('idle', `sleep 600 &\necho $! >${shell(join(work, 'idle-child'))}\nwait\n`, helper),
      run('output', `${shell(bun)} -e ${shell(`const timer = setInterval(() => console.log('alive'), ${interval * 1000}); setTimeout(() => clearInterval(timer), ${duration * 1000})`)}\n`, helper),
      run('cpu', `${shell(bun)} -e ${shell(`const end = Date.now() + ${duration * 1000}; while (Date.now() < end) Math.sqrt(Math.random())`)}\n`, helper),
    ])
    assert.equal(idle.rc, 137)
    assert.equal(idle.hang, '310')
    assert.match(idle.output, /__SUITE_STALLED after 300s silent \(.+\) \(tree-killed\)__/)
    const child = Number(readFileSync(join(work, 'idle-child'), 'utf8'))
    let state = ''
    try { state = readFileSync(`/proc/${child}/stat`, 'utf8') } catch {}
    if (state) assert.match(state, /^\d+ \(.+\) Z /, 'the sleeping child is dead')
    else assert.throws(() => process.kill(child, 0))
    for (const result of [output, cpu]) { assert.equal(result.rc, 0); assert.equal(result.hang, null) }
    assert.ok(output.output.includes('alive'))
    if (live) { assert.ok(idle.seconds >= 300 && idle.seconds <= 340); assert.ok(output.seconds >= duration); assert.ok(cpu.seconds >= duration) }
    console.log(`PASS ${live ? 'real-time' : 'accelerated'} stall watcher kills only a silent, idle tree; output and descendant CPU each keep it alive`)
  }
} finally {
  removeScratch(work)
}
