import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startCrossfamilyFixture } from '../lib/crossfamilyConcourseFixture.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const root = join(import.meta.dir, '..', '..')
const scratch = mkdtempSync(join(tmpdir(), 'resume-transcript-effort-'))
const work = join(scratch, 'work')
const home = join(scratch, 'home')
const daemon = join(scratch, 'daemon')
for (const path of [work, home, daemon]) mkdirSync(path)
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemon
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_EFFORT_LEVEL
delete process.env.MERCURY_MODEL
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const fixture = await startCrossfamilyFixture({ port: 0 })
Object.assign(process.env, fixture.env)
seedFirstRun(home, [work])
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const workers = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const { getProjectDir } = await import('../../src/sessions/transcripts/paths.ts')
const { encodeTranscriptLine } = await import('../../src/sessions/transcripts/vnext.ts')
const { buildRunnerInvocation } = await import('../../src/daemon/runner-link/headlessRun.ts')
const { restingStatusWords } = await import('../../src/screen/chat/SwitchboardTagBar.tsx')
const { focusedEffortLabelOf } = await import('../../src/screen/widgets/EffortChip.tsx')
const { getDefaultEngineModelSetting, parseUserSpecifiedModel, renderModelChip } = await import('../../src/models/catalogue/engineModel.ts')
const model = parseUserSpecifiedModel(getDefaultEngineModelSetting())
const project = getProjectDir(workers.canonicalWorkspaceId(work))
mkdirSync(project, { recursive: true })
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function transcript(sessionId: string, levels: string[]): void {
  const path = join(project, `${sessionId}.jsonl`)
  let parentUuid: string | null = null
  const rows: Record<string, unknown>[] = []
  const push = (row: Record<string, unknown>): void => {
    const uuid = randomUUID()
    rows.push({ cwd: work, sessionId, uuid, parentUuid, timestamp: new Date().toISOString(), isSidechain: false, entrypoint: 'cli', version: '1.0.0', ...row })
    parentUuid = uuid
  }
  push({ type: 'user', message: { role: 'user', content: 'Keep the selected effort.' } })
  for (const level of levels) push({ type: 'assistant', effort: { asked: level, applied: level, wire: `output_config.effort=${level}` }, message: { id: randomUUID(), type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'The saved reply.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
  writeFileSync(path, rows.map(row => (encodeTranscriptLine as (path: string, row: Record<string, unknown>) => { line: string })(path, row).line).join(''))
}
try {
  {
    const sid = randomUUID()
    transcript(sid, ['low', 'max', 'none'])
    let spec: import('../../src/daemon/runner-link/headlessRun.ts').RunnerChildSpec | undefined
    const admit = workers.makeConcourseAdmitHandler({
      dir: daemon,
      roster: () => ({ has: () => ({ present: false }), list: () => [], registerLongLived: (_id, input) => { spec = input; return { ok: true } } }),
    })
    const reply = await admit({ workspaceDir: work, resumeSessionId: sid, modelKey: model })
    check('record transcript resumes', reply.ok && spec !== undefined, `${JSON.stringify(reply)}; the admit handler refused or did not register a runner: check makeConcourseAdmitHandler in src/daemon/concourse-workers/admit.ts`)
    if (!reply.ok || !spec) throw new Error('fixture admission failed')
    check('admission keeps the last saved dial, skipping an unstamped tail', reply.effort === 'max', `${String(reply.effort)}; coldSpecOf in src/daemon/concourse-workers/admitCold.ts should take the last assistant row's effort.asked from the transcript and skip rows without one`)
    const rec = workers.readSessionWorkers(daemon)[reply.runnerId]
    check('durable session record keeps max', rec?.effort === 'max', `${String(rec?.effort)}; the session record written at admission should carry the effort coldSpecOf resolved (src/daemon/concourse-workers/admitCold.ts)`)
    const invocation = buildRunnerInvocation(spec)
    check('runner receives max', invocation.env.MERCURY_EFFORT_LEVEL === 'max', `${String(invocation.env.MERCURY_EFFORT_LEVEL)}; buildRunnerInvocation in src/daemon/runner-link/headlessRun.ts should set MERCURY_EFFORT_LEVEL from the spec's effort`)
    const childEnv = { ...invocation.env, ...fixture.env, MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: daemon }
    const from = fixture.captured.length
    const child = spawn('node', [join(root, 'dist', 'mercury.mjs'), 'run', '--resume', sid, '--format', 'rows', 'Reply with one short sentence.'], { cwd: work, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data.toString() })
    child.stderr.on('data', data => { output += data.toString() })
    const timer = setTimeout(() => child.kill(), 60_000)
    const code = await new Promise<number | null>(resolve => child.on('close', resolve))
    clearTimeout(timer)
    const hit = fixture.captured.slice(from).find(hit => hit.lane === 'anthropic-seat')
    const sent = (hit?.body as { output_config?: { effort?: string } } | undefined)?.output_config?.effort
    check('resumed next request reaches the loopback provider', hit !== undefined && code === 0, `exit=${code}; ${output.slice(-1600)}; the resumed 'mercury run --resume' child (dist/mercury.mjs, rebuild it if stale) should exit 0 and call the loopback provider: read its output above`)
    check('next request sends max', sent === 'max', `${String(sent)}; the resumed run's request output_config.effort should be the session's effort: the runner reads MERCURY_EFFORT_LEVEL set by buildRunnerInvocation in src/daemon/runner-link/headlessRun.ts`)
    const row = restingStatusWords(renderModelChip(model), focusedEffortLabelOf(model, rec?.effort, sent, undefined, undefined, false))
    check('status-row words keep max', row.endsWith(' · max'), `${row}; restingStatusWords in src/screen/chat/SwitchboardTagBar.tsx and focusedEffortLabelOf in src/screen/widgets/EffortChip.tsx should end the status words with the effort label`)
    workers.updateConcourseWorkers(records => { records[reply.runnerId]!.effort = 'medium'; records[reply.runnerId]!.endedAt = Date.now() }, daemon)
    const prior = await admit({ workspaceDir: work, resumeSessionId: sid, modelKey: model })
    check('a prior daemon record wins over transcript effort', prior.ok && prior.effort === 'medium', `${JSON.stringify(prior)}; coldSpecOf in src/daemon/concourse-workers/admitCold.ts should prefer the newest prior record's effort over the transcript`)
    if (prior.ok) workers.updateConcourseWorkers(records => { records[prior.runnerId]!.endedAt = Date.now() }, daemon)
    const override = await admit({ workspaceDir: work, resumeSessionId: sid, modelKey: model, effort: 'low' })
    check('an explicit launch effort wins over record and transcript', override.ok && override.effort === 'low', `${JSON.stringify(override)}; coldSpecOf in src/daemon/concourse-workers/admitCold.ts should take the request's effort before any record or transcript`)
    const missing = await admit({ workspaceDir: work, resumeSessionId: randomUUID(), modelKey: model })
    check('no saved effort retains the high default', missing.ok && missing.effort === 'high', `${JSON.stringify(missing)}; coldSpecOf in src/daemon/concourse-workers/admitCold.ts should fall back to 'high' when no record or transcript has an effort`)
  }
} finally {
  await fixture.close()
  removeScratch(scratch)
}
console.log(`prove-resume-transcript-effort: ${checks - failures}/${checks} PASS`)
process.exit(failures === 0 ? 0 : 1)
