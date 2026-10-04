import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DIST, NODE, SCRATCH_ROOT, bound, childEnv, makeTally } from '../daemon/dupline-world.js'
import { seedScratchHome, startScriptedFixture } from '../lib/scriptedTurn.js'
import { capsuleFixtures } from './capsule-fixtures.js'

const tally = makeTally('prove-capsule-request')
if (!existsSync(DIST)) throw new Error('Build the product before the capsule request proof')
const rootArg = process.argv.indexOf('--source-root')
const source = rootArg < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[rootArg + 1]!)
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'capsule-request-')))
const home = join(scratch, 'home')
const cwd = join(scratch, 'work')
seedScratchHome(home, cwd)
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_TASKS = '1'
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.chdir(cwd)
const bootstrap = await import(`${source}/src/bootstrap/state.ts`)
bootstrap.setOriginalCwd(cwd)
bootstrap.setProjectRoot(cwd)
bootstrap.setCwdState(cwd)
const { enableConfigs } = await import(`${source}/src/utils/config/globalConfig.ts`)
enableConfigs()
const writer = await import(`${source}/src/utils/sessionStorage/writer.ts`)
const { createUserMessage } = await import(`${source}/src/utils/messages/factories.ts`)
const { createAttachmentMessage } = await import(`${source}/src/utils/attachments/orchestrator.ts`)
const capsule = await import(`${source}/src/utils/attachments/contextCapsule.ts`)
const { normalizeAttachmentForAPI } = await import(`${source}/src/utils/messages/attachmentText.ts`)
const original = Object.values(capsuleFixtures).flat()
const attachments = capsule.foldAttachmentsIntoCapsule ? capsule.foldAttachmentsIntoCapsule(original, [], 'Prove the attachment facts') : original
const sessionId = bootstrap.getSessionId()
const { getTranscriptPathForSession } = await import(`${source}/src/utils/sessionStorage/paths.ts`)
const transcript = getTranscriptPathForSession(sessionId)
writer.setSessionFileForTesting(transcript)
await writer.recordTranscript([createUserMessage({ content: 'Prove the attachment facts' }), ...attachments.map(createAttachmentMessage)])
await writer.flushSessionStorage()
console.log(`build under proof: ${DIST}`)
console.log(`seed records: ${readFileSync(transcript, 'utf8').split('\n').filter(Boolean).length}`)
const fixture = await startScriptedFixture(() => [{ type: 'text', text: 'capsule request answered' }])
const port = Number(new URL(fixture.base).port)
try {
  const run = await new Promise<{ code: number | null; stderr: string; stdout: string }>(resolveRun => {
    const env = childEnv(home, port)
    delete env.MERCURY_HOME
    const child = spawn(NODE, [DIST, 'run', '--format', 'rows', '--resume', sessionId, 'capsule resume proof'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), bound(120_000))
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', code => { clearTimeout(timer); resolveRun({ code, stderr, stdout }) })
    child.on('error', error => { clearTimeout(timer); resolveRun({ code: null, stderr: String(error), stdout }) })
  })
  tally.check('the built product resumes the stored fixture and completes', run.code === 0 && fixture.requests.length > 0, JSON.stringify(run).slice(-1500))
  const request = fixture.requests.find(row => row.ask.includes('capsule resume proof')) ?? fixture.requests.at(-1)
  const text = request?.allTexts.join('\n') ?? ''
  const reminders = text.match(/<system-reminder>[\s\S]*?<\/system-reminder>/g) ?? []
  const capsules = reminders.filter(block => block.includes('capsule-digest:'))
  tally.check('one capsule reaches the actual request body', capsules.length === 1, `capsules=${capsules.length}, reminders=${reminders.length}, sections=${JSON.stringify(capsules.map(block => block.match(/^## .*$/gm)))}`)
  const old = JSON.parse(readFileSync(resolve(import.meta.dir, 'capsule-old.json'), 'utf8'))
  for (const [kind, blocks] of Object.entries(old) as Array<[string, Array<{ type: string; text?: string }>]>) {
    const oldText = blocks.filter(block => block.type === 'text').map(block => block.text!)
    const bodies = oldText.map(block => block.startsWith('<system-reminder>\n') && block.endsWith('\n</system-reminder>') ? block.slice(18, -19) : block)
    tally.check(`${kind}: the capsule carries every old fact on the wire`, capsules.length === 1 && bodies.every(body => capsules[0]!.includes(body)))
    tally.check(`${kind}: no separate old reminder block remains`, oldText.every(block => !reminders.includes(block)))
  }
  const disk = readFileSync(transcript, 'utf8')
  const persistedKinds = original.filter(row => normalizeAttachmentForAPI(row).length > 0).map(row => row.type)
  tally.check('the transcript keeps every previously-persisted receipt kind for old readers', persistedKinds.every(kind => disk.includes(`"attachmentType":"${kind}"`)))
} finally {
  await fixture.close()
  process.chdir(source)
  rmSync(scratch, { recursive: true, force: true })
}
tally.finish()
