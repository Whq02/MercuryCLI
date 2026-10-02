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
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the local-lane working-directory proof exceeded 90s')
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

const { getSystemPrompt } = await import('../../src/constants/prompts.ts')
const { clearSystemPromptSections } = await import('../../src/constants/systemPromptSections.ts')
const { getOriginalCwd, setOriginalCwd, setCwdState, getSystemPromptSectionCache } = await import('../../src/bootstrap/state.ts')
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
await refreshLocalDiscovery({ force: true })

const scratch = mkdtempSync(join(tmpdir(), 'local-lane-cwd-'))
const cwd = process.cwd()
const originalCwd = getOriginalCwd()
process.chdir(scratch)
setOriginalCwd(scratch)
setCwdState(scratch)

const LOCAL_MODEL = `local/${MODEL_ID}`
const CLOUD_MODEL = 'claude-fable-5-1'
const TOOLS_HEADING = '# Using your tools'
const TONE_HEADING = '# Tone and style'
const MEMORY_WORDS = 'What Mercury remembers about this project lives in topic pages under'
const ENV_LINE = `Primary working directory: ${scratch}`
const LINE = `Files you create go in the working directory: ${scratch}. The memory folder named below is not it.`
const tool = (name: string): { name: string } => ({ name })
const pool = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Agent', 'Skill', 'AskUserQuestion'].map(tool)
const build = async (model: string): Promise<string> => (await getSystemPrompt(pool as never, model)).join('\n\n')
const toolsBlock = (prompt: string): string => {
  const start = prompt.indexOf(TOOLS_HEADING)
  const end = prompt.indexOf(TONE_HEADING)
  return start === -1 || end === -1 ? '' : prompt.slice(start, end).trimEnd()
}

try {
  section('0 · the lane: the fixture model is a discovered local record')
  check('local record present', localRecordFor(LOCAL_MODEL) !== undefined)

  section('1 · a first build for a local record: the tools section opens with the working-directory line; the memory folder is named below it')
  clearSystemPromptSections()
  const local = await build(LOCAL_MODEL)
  const block = toolsBlock(local)
  check('the tools section renders', block.startsWith(TOOLS_HEADING), block.slice(0, 80))
  const firstLine = block.split('\n').map(l => l.trim()).filter(l => l !== '')[1] ?? ''
  check('its first line after the heading is the working-directory line', firstLine === LINE, j(firstLine))
  check('the line names the same cwd the environment section states', local.includes(ENV_LINE) && local.indexOf(LINE) !== -1)
  check('the memory section (the auto-memory folder) is named BELOW the line', local.includes(MEMORY_WORDS) && local.indexOf(LINE) !== -1 && local.indexOf(MEMORY_WORDS) > local.indexOf(LINE), `memory at ${local.indexOf(MEMORY_WORDS)}, line at ${local.indexOf(LINE)}`)
  check('the section cache keys the tools section on the local model', getSystemPromptSectionCache().get('using_tools')?.key === LOCAL_MODEL, j(getSystemPromptSectionCache().get('using_tools')?.key))

  section('2 · a cloud model: no such line, the section bytes are the local section minus the line, the cache key stays null (the resume record\'s shape)')
  clearSystemPromptSections()
  const cloud = await build(CLOUD_MODEL)
  const cloudBlock = toolsBlock(cloud)
  check('the cloud tools section carries no working-directory line', !cloud.includes('Files you create go in the working directory'), cloudBlock.slice(0, 200))
  check('nothing removed: the local section is the cloud section plus the one line', block.split('\n').filter(l => l.trim() !== LINE).join('\n').replace(/\n{3,}/g, '\n\n') === cloudBlock, j({ local: block.slice(0, 160), cloud: cloudBlock.slice(0, 160) }))
  check('the cloud key is null (as first recorded)', getSystemPromptSectionCache().get('using_tools')?.key === null, j(getSystemPromptSectionCache().get('using_tools')?.key))
  check('a second cloud build in the same process is byte-identical (the frozen conversation)', (await build(CLOUD_MODEL)) === cloud)

  section('3 · a /model switch mid-conversation: cloud → local adds the line, local → cloud drops it')
  clearSystemPromptSections()
  const first = await build(CLOUD_MODEL)
  check('the conversation starts on the cloud model without the line', !first.includes(LINE))
  const switched = await build(LOCAL_MODEL)
  check('after the switch the tools section opens with the line (recomputed at the model switch, not frozen)', toolsBlock(switched).includes(LINE), toolsBlock(switched).slice(0, 200))
  const back = await build(CLOUD_MODEL)
  check('switching back drops the line again', !back.includes(LINE) && toolsBlock(back) === toolsBlock(first))
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
