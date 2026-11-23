#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'local-lane-cwd-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_ENTRYPOINT = 'headless'
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_BARE', 'MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL']) {
  delete process.env[k]
}

const j = (v: unknown): string => JSON.stringify(v)
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond && hint ? ` — to fix: ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the local-lane working-directory proof exceeded 90s; check that refreshLocalDiscovery (src/models/roads/local/localDiscovery.ts) and getSystemPrompt (src/engine/system-prompt/defaultSystemPrompt.ts) return')
  process.exit(1)
}, 90_000)
guard.unref?.()

type Route = (req: IncomingMessage, body: string, res: ServerResponse) => boolean
function serve(route: Route): Promise<{ server: Server; root: string }> {
  return new Promise(resolvePromise => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => {
        body += String(chunk)
      })
      req.on('end', () => {
        if (!route(req, body, res)) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'not found' }))
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolvePromise({ server, root: `http://127.0.0.1:${port}` })
    })
  })
}
const MODEL_ID = 'Qwen/Qwen3-32B'
const VLLM_MODELS = { object: 'list', data: [{ id: MODEL_ID, object: 'model', created: 1, owned_by: 'vllm', root: '/models/Qwen3-32B', parent: null, max_model_len: 40960, permission: [] }] }
const vllm = await serve((req, _body, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(VLLM_MODELS))
    return true
  }
  return false
})
process.env.MERCURY_LOCAL_PROBE_TARGETS = `vllm=${vllm.root}`

const { getSystemPrompt, localFirstTurnFacts } = await import('../../src/engine/system-prompt/defaultSystemPrompt.ts')
const { appendSystemContext } = await import('../../src/engine/messages/apiSystemAndToolSchema.ts')
const { clearSystemPromptSections } = await import('../../src/engine/system-prompt/systemPromptSections.ts')
const { getOriginalCwd, setOriginalCwd, setCwdState, getSystemPromptSectionCache } = await import('../../src/boot/process-state/processState.ts')
const { refreshLocalDiscovery } = await import('../../src/models/roads/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/models/roads/local/localCatalogue.ts')
await refreshLocalDiscovery({ force: true })

const scratch = mkdtempSync(join(tmpdir(), 'local-lane-cwd-'))
const cwd = process.cwd()
const originalCwd = getOriginalCwd()
process.chdir(scratch)
setOriginalCwd(scratch)
setCwdState(scratch)

const LOCAL_MODEL = `local/${MODEL_ID}`
const CLOUD_MODEL = 'claude-fable-5-1'
const ENV_HEADING = '# Environment'
const MEMORY_WORDS = 'What Mercury remembers about this project lives in topic pages under'
const LINE = `Files you create go in the working directory: ${scratch}. The memory folder named above is not it.`
const tool = (name: string): { name: string } => ({ name })
const pool = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Crewmate', 'Skill', 'AskUserQuestion'].map(tool)
const build = async (model: string): Promise<string> => (await getSystemPrompt(pool as never, model)).join('\n\n')
const envBlock = (prompt: string): string => {
  const start = prompt.indexOf(ENV_HEADING)
  if (start === -1) return ''
  const end = prompt.indexOf('\n\n', start)
  return end === -1 ? prompt.slice(start) : prompt.slice(start, end)
}

try {
  section('0 · the lane: the fixture model is a discovered local record')
  check('local record present', localRecordFor(LOCAL_MODEL) !== undefined, '', 'refreshLocalDiscovery in src/models/roads/local/localDiscovery.ts did not register the fixture vllm model from MERCURY_LOCAL_PROBE_TARGETS; check the /v1/models probe and localRecordFor in src/models/roads/local/localCatalogue.ts')

  section('1 · a first build for a local record: the environment section opens on the working-directory line (the head names the working directory); the memory folder is named above it')
  clearSystemPromptSections()
  const local = await build(LOCAL_MODEL)
  const block = envBlock(local)
  check('the environment section renders', block.startsWith(ENV_HEADING), block.slice(0, 80), 'getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts must include the # Environment section for a local model')
  const lines = block.split('\n').map(l => l.trim()).filter(l => l !== '')
  check('the working-directory line opens the environment section', lines[1] === `- ${LINE}`, j(lines.slice(0, 3)), 'the working-directory line is pushed in computeSimpleEnvInfo in src/engine/system-prompt/defaultSystemPrompt.ts and must be the first item after the # Environment heading')
  check('the memory section (the memory home) is named ABOVE the line', local.includes(MEMORY_WORDS) && local.indexOf(LINE) !== -1 && local.indexOf(MEMORY_WORDS) < local.indexOf(LINE), `memory at ${local.indexOf(MEMORY_WORDS)}, line at ${local.indexOf(LINE)}`, 'in the prompt assembled by getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts the memory section must come before the environment section')
  check('the section cache keys the local profile\'s environment section on the local model', getSystemPromptSectionCache().get('local_env')?.key === LOCAL_MODEL, j(getSystemPromptSectionCache().get('local_env')?.key), 'the local_env section in src/engine/system-prompt/defaultSystemPrompt.ts must be keyed on the model id passed to getSystemPrompt')

  section('2 · a cloud model: no such line, the section bytes are the local section minus the line, the key is the cloud model')
  clearSystemPromptSections()
  const cloud = await build(CLOUD_MODEL)
  const cloudBlock = envBlock(cloud)
  check('the cloud environment section carries no working-directory line', !cloud.includes('Files you create go in the working directory'), cloudBlock.slice(0, 200), 'computeSimpleEnvInfo in src/engine/system-prompt/defaultSystemPrompt.ts must add the working-directory line for a local model only')
  const localWithoutLine = block.split('\n').filter(l => l.trim() !== `- ${LINE}`).join('\n')
  const cloudWithoutEngine = (text: string): string => text.split('\n').filter(l => !l.includes('In this seat the model you run through Mercury is') && !l.startsWith(' - Knowledge cutoff')).join('\n')
  const scratchpadLine = cloudBlock.split('\n').find(l => l.trim().startsWith('- Scratchpad directory: ')) ?? ''
  const cloudWithoutScratchpad = cloudBlock.split('\n').filter(l => l !== scratchpadLine).join('\n')
  check('nothing else removed: the local section is the cloud section plus the one line, less the scratchpad line the local route moves to the first user turn (the engine and cutoff lines aside, which name each model)', scratchpadLine !== '' && cloudWithoutEngine(localWithoutLine) === cloudWithoutEngine(cloudWithoutScratchpad), j({ local: localWithoutLine.slice(0, 160), cloud: cloudWithoutScratchpad.slice(0, 160) }), 'the local and cloud environment sections built by computeSimpleEnvInfo in src/engine/system-prompt/defaultSystemPrompt.ts must differ only by the working-directory line, the scratchpad line and the engine and cutoff lines')
  const moved = (await localFirstTurnFacts(undefined, undefined)).Scratchpad
  const wire = appendSystemContext(await getSystemPrompt(pool as never, LOCAL_MODEL), {}, LOCAL_MODEL).join('\n\n')
  check('the moved scratchpad line is the one the local first user turn carries, word for word, and the local system text on the wire has none', moved === scratchpadLine.trim().replace(/^- /, '') && !wire.includes('Scratchpad directory: '), j({ moved, cloud: scratchpadLine }), 'localFirstTurnFacts in src/engine/system-prompt/defaultSystemPrompt.ts must return the same Scratchpad line the cloud section carries, and appendSystemContext in src/engine/messages/apiSystemAndToolSchema.ts must not leave it in the local system text')
  check('the cloud key is the cloud model', getSystemPromptSectionCache().get('env_info_simple')?.key === CLOUD_MODEL, j(getSystemPromptSectionCache().get('env_info_simple')?.key), 'the env_info_simple section in src/engine/system-prompt/defaultSystemPrompt.ts must be keyed on the model id passed to getSystemPrompt')
  check('a second cloud build in the same process is byte-identical (the frozen conversation)', (await build(CLOUD_MODEL)) === cloud, '', 'the sections of getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts must be cached per model (src/engine/system-prompt/systemPromptSections.ts) so a second build of the same model gives the same bytes')

  section('3 · a /model switch mid-conversation: cloud → local adds the line, local → cloud drops it')
  clearSystemPromptSections()
  const first = await build(CLOUD_MODEL)
  check('the conversation starts on the cloud model without the line', !first.includes(LINE), '', 'computeSimpleEnvInfo in src/engine/system-prompt/defaultSystemPrompt.ts must add the working-directory line for a local model only')
  const switched = await build(LOCAL_MODEL)
  check('after the switch the environment section carries the line (recomputed at the model switch, not frozen)', envBlock(switched).includes(LINE), envBlock(switched).slice(0, 200), 'the environment section in src/engine/system-prompt/defaultSystemPrompt.ts must be recomputed when the model changes, not served from the cache of the earlier model')
  const back = await build(CLOUD_MODEL)
  check('switching back drops the line again', !back.includes(LINE) && envBlock(back) === envBlock(first), '', 'the environment section in src/engine/system-prompt/defaultSystemPrompt.ts must be recomputed for the cloud model after a switch back, dropping the line')
} finally {
  clearSystemPromptSections()
  process.chdir(cwd)
  setOriginalCwd(originalCwd)
  setCwdState(cwd)
  vllm.server.close()
}

clearTimeout(guard)
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-local-lane-working-directory: ALL GREEN' : `prove-local-lane-working-directory: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
