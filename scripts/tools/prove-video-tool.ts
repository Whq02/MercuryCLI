import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import { startVideoFixture, videoBytes } from './videoFixture.mjs'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const source = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
assert.ok(existsSync(join(source, 'tools/VideoTool/VideoTool.tsx')), 'Video must be implemented and callable (absent on the base)')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'video-proof-')))
const project = join(scratch, 'project')
mkdirSync(project)
mkdirSync(join(project, '.mercury'))
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MINIMAX_API_KEY
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
const { VideoTool } = await import(`${source}/tools/VideoTool/VideoTool.tsx`)
const { getAllBaseTools } = await import(`${source}/tools.ts`)
const { withheldTools } = await import(`${source}/utils/withheldTools.ts`)
const { enableConfigs } = await import(`${source}/utils/config/globalConfig.ts`)
const { getEmptyToolPermissionContext } = await import(`${source}/Tool.ts`)
const { runWithCwdOverride } = await import(`${source}/utils/cwd.ts`)
const { resetSettingsCache } = await import(`${source}/utils/settings/settingsCache.ts`)
const { SettingsSchema } = await import(`${source}/utils/settings/types.ts`)
const { writeStoredMinimaxApiKey } = await import(`${source}/services/providers/providerSecrets.ts`)
const { hasPermissionsToUseTool } = await import(`${source}/utils/permissions/permissions.ts`)
const { setCwdState, setOriginalCwd } = await import(`${source}/bootstrap/state.ts`)
const { prepareVideo } = await import(`${source}/services/video/generate.ts`)
const { gateToolCall } = await import(`${source}/services/providers/toolCallGate.ts`)
enableConfigs()
setCwdState(project)
setOriginalCwd(project)
const fixture = await startVideoFixture()
let checked = 0
function check(name: string, condition: unknown): void {
  assert.ok(condition, name)
  checked++
  console.log(`PASS ${name}`)
}
const settingsFile = join(project, '.mercury/settings.local.json')
function configure(on: boolean): void {
  writeFileSync(settingsFile, JSON.stringify(on ? { videoProvider: { studio: { kind: 'minimax', baseUrl: fixture.baseUrl, model: 'MiniMax-H3' } } } : {}))
  resetSettingsCache()
}
function context(mode = 'default'): any {
  return {
    options: { engineModel: 'claude-opus-4-8', isNonInteractiveSession: false, tools: [VideoTool] },
    abortController: new AbortController(), messages: [],
    getAppState: () => ({ toolPermissionContext: { ...getEmptyToolPermissionContext(), mode } }),
    setAppState: () => {},
  }
}
async function call(input: Record<string, unknown>, ctx = context()): Promise<any> {
  const parsed = VideoTool.inputSchema.parse(input)
  return runWithCwdOverride(project, () => VideoTool.call(parsed, ctx, null, { uuid: 'video-proof', message: { id: 'video-proof' } }))
}
function image(): Buffer {
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n
    for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const chunk = (type: string, body: Buffer): Buffer => {
    const bytes = Buffer.concat([Buffer.from(type), body])
    let crc = 0xffffffff
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8)
    const length = Buffer.alloc(4); length.writeUInt32BE(body.length)
    const sum = Buffer.alloc(4); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, bytes, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(256); header.writeUInt32BE(256, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(256 * (1 + 256 * 3)))), chunk('IEND', Buffer.alloc(0))])
}
const guard = setTimeout(() => { console.error('Video proof exceeded 300s'); process.exit(1) }, 300_000)
guard.unref()
try {
  configure(false)
  check('Video is absent without configuration', !getAllBaseTools().some((tool: any) => tool.name === 'Video'))
  check('the withheld row names both setup steps', JSON.stringify(withheldTools().find((tool: any) => tool.tool === 'Video')).includes('/logins minimax'))
  const unconfigured = await call({ prompt: 'no provider' })
  check('no provider returns the two-step refusal, not a stack', unconfigured.data.result.includes('/logins minimax') && unconfigured.data.result.includes('videoProvider.<name>') && !unconfigured.data.result.includes('\n    at '))
  configure(true)
  check('Video joins the live roster with a configured provider', getAllBaseTools().some((tool: any) => tool.name === 'Video'))
  check('configured Video is no longer withheld', !withheldTools().some((tool: any) => tool.tool === 'Video'))
  check('settings reject a key in videoProvider', !SettingsSchema().safeParse({ videoProvider: { studio: { kind: 'minimax', key: 'not-a-secret' } } }).success)
  check('settings reject an unknown provider kind', !SettingsSchema().safeParse({ videoProvider: { studio: { kind: 'unknown' } } }).success)
  const missingKey = await call({ prompt: 'no key' })
  check('missing key names the existing login door and sends nothing', missingKey.data.result.includes('/logins minimax') && fixture.requests.length === 0)
  writeStoredMinimaxApiKey('video-proof-key')
  const ask = await VideoTool.checkPermissions({ prompt: 'a blue square', duration: 5, aspect: '16:9', outputDir: 'renders' }, context())
  check('billable permission ask names destination, endpoint and prompt before any request', ask.behavior === 'ask' && ask.message.includes('billable') && ask.message.includes(fixture.baseUrl) && ask.message.includes('a blue square') && ask.message.includes('renders') && fixture.requests.length === 0)
  const sovereign = await hasPermissionsToUseTool(VideoTool, { prompt: 'a blue square' }, context('sovereign'), { uuid: 'video-proof', message: { id: 'video-proof' } }, 'video-pregrant')
  check('a pre-granting mode permits Video through the real permission chain', sovereign.behavior === 'allow')
  writeFileSync(join(project, 'reference.png'), image())
  writeFileSync(join(project, 'reference.mp4'), videoBytes)
  writeFileSync(join(project, 'reference.wav'), Buffer.alloc(44))
  const referenceAsk = await VideoTool.checkPermissions({ prompt: 'reference', references: [{ path: 'reference.png' }], callback_url: 'https://callbacks.example/video' }, context())
  check('reference and callback disclosure rides the ask', referenceAsk.message.includes('reference.png') && referenceAsk.message.includes('https://callbacks.example/video'))
  const plan = await prepareVideo({ prompt: 'multimodal', references: [{ path: 'reference.png' }, { path: 'reference.mp4' }, { path: 'reference.wav' }] }, project)
  check('image video and audio paths keep documented roles', plan.references.map((ref: any) => ref.role).join(',') === 'reference_image,reference_video,reference_audio')
  const strictAnswer = { prompt: 'every unused box null', provider: null, references: [{ path: 'reference.png', role: null }], duration: null, aspect: null, ratio: null, resolution: null, extra: { prompt_expansion_mode: null }, callback_url: null, outputDir: null, timeoutSeconds: null }
  const gated = gateToolCall([VideoTool], { id: 'strict', name: 'Video', argumentsRaw: JSON.stringify(strictAnswer), malformed: false })
  check('a strict-dialect answer with null in every unused box passes the gate with the nested nulls gone', gated.ok && !('role' in gated.input.references[0]) && !('prompt_expansion_mode' in (gated.input.extra ?? {})))
  const unasked = await prepareVideo(gated.ok ? gated.input : strictAnswer, project)
  check('an extra object whose only box the model left empty is no extra: MiniMax-H3 accepts the call and the job carries none', !('extra' in unasked.job))
  check('a named prompt_expansion_mode on MiniMax-H3 is still refused as the H3-Max option it is', await prepareVideo({ prompt: 'mode', extra: { prompt_expansion_mode: 'quality' } }, project).then(() => false, (error: Error) => error.message.includes('MiniMax-H3-Max only')))
  for (const bad of [
    { prompt: 'escape', outputDir: '../outside' },
    { prompt: 'escape', references: [{ path: '../outside.png' }] },
    { prompt: 'mixed roles', references: [{ path: 'reference.png', role: 'first_frame' }, { path: 'reference.mp4' }] },
    { prompt: 'bad ratio', aspect: 'adaptive' },
  ]) {
    const verdict = await VideoTool.validateInput(bad, context())
    check(`preflight refuses ${bad.prompt} without a billable call`, !verdict.result && fixture.requests.length === 0)
  }
  const outside = join(scratch, 'outside'); mkdirSync(outside)
  symlinkSync(outside, join(project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  check('a symlink output cannot escape the project', !(await VideoTool.validateInput({ prompt: 'escape', outputDir: 'escape/renders' }, context())).result)
  const success = await call({ prompt: 'a blue square', duration: 5, aspect: '16:9', outputDir: 'renders' })
  check('create poll download saves the MP4 under the named folder', success.data.outcome === 'succeeded' && success.data.path.startsWith(join(project, 'renders')) && readFileSync(success.data.path).equals(videoBytes))
  check('result carries duration, vendor job ID and exact usage without invented price', success.data.duration === 5 && success.data.jobId === 'task-1' && success.data.result.includes('total_seconds=5') && success.data.result.includes('monetary charge not reported') && !success.data.result.includes('$'))
  const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
  check('frame is a PNG when ffmpeg is installed, otherwise absence is named', ffmpeg ? !!success.data.framePath && readFileSync(success.data.framePath).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : success.data.result.includes('ffmpeg is not installed'))
  check('effects name exactly the files created', success.effect.changedPaths.includes(success.data.path) && success.effect.outcome === 'succeeded')
  const mapped = VideoTool.mapToolResultToToolResultBlockParam(success.data, 'video-output')
  check('the model receives paths, not MP4 bytes', JSON.stringify(mapped).includes(success.data.path) && !JSON.stringify(mapped).includes(videoBytes.toString('base64')))
  const reference = await call({ prompt: 'animate the reference', duration: 5, references: [{ path: 'reference.png', role: 'first_frame' }], outputDir: 'renders' })
  check('reference-image generation completes', reference.data.outcome === 'succeeded')
  check('the documented content array carries project image bytes and first_frame', fixture.requests[1].content[1].type === 'image_url' && fixture.requests[1].content[1].role === 'first_frame' && fixture.requests[1].content[1].image_url.url === `data:image/png;base64,${image().toString('base64')}`)
  const failed = await call({ prompt: 'vendor failure' })
  check('failed job returns vendor words verbatim', failed.data.result === 'video description contains sensitive content' && failed.data.outcome === 'failed')
  const oldPath = process.env.PATH
  const noBin = join(scratch, 'empty-bin'); mkdirSync(noBin)
  process.env.PATH = noBin
  let expired: any
  try { expired = await call({ prompt: 'expired URL' }) } finally { process.env.PATH = oldPath }
  check('expired URL is refreshed through query and saved, without another create', expired.data.outcome === 'succeeded' && fixture.requests.length === 4 && fixture.jobs.get(expired.data.jobId).queries === 3)
  check('without ffmpeg the MP4 still succeeds and names the skipped frame', !expired.data.framePath && expired.data.result.includes('ffmpeg is not installed') && existsSync(expired.data.path))
  check('the API key is never forwarded to a signed download URL', fixture.downloads.every((entry: any) => entry.authorization === undefined))
  writeStoredMinimaxApiKey('wrong-proof-key')
  const auth = await call({ prompt: 'auth refusal' })
  check('authentication refusal keeps vendor words and does not resubmit', auth.data.result.startsWith('fixture authentication refused (1004)') && fixture.requests.length === 4)
  writeStoredMinimaxApiKey('video-proof-key')
  const pending = await call({ prompt: 'pending forever', timeoutSeconds: 1 })
  check('deadline returns an existing vendor ID and warns not to duplicate its billable job', pending.data.jobId && pending.data.outcome === 'indeterminate' && pending.data.result.includes('deadline') && pending.data.result.includes('does not cancel'))
  const cancelledContext = context(); cancelledContext.abortController.abort()
  const count = fixture.requests.length
  const cancelled = await call({ prompt: 'cancel before submit' }, cancelledContext)
  check('cancel before submission sends nothing', cancelled.data.outcome === 'failed' && fixture.requests.length === count)
  check('polling observes the documented ten-second interval', [...fixture.jobs.values()].filter((job: any) => job.times.length >= 3).every((job: any) => job.times[1] - job.times[0] >= 9_900 && job.times[2] - job.times[1] >= 9_900))
  check('no output escaped to a symlink target', readdirSync(outside).length === 0)
  const { runScriptedTurn, startScriptedFixture } = await import('../lib/scriptedTurn.ts')
  const work = join(scratch, 'model-project'); mkdirSync(join(work, '.mercury'), { recursive: true })
  writeFileSync(join(work, '.mercury/settings.local.json'), readFileSync(settingsFile))
  writeFileSync(join(work, 'reference.png'), image())
  const seen: any[] = []
  const model = await startScriptedFixture(req => {
    if (req.opening !== 'video-tool-proof') return [{ type: 'text', text: 'done' }]
    if (req.results.length) seen.push(...req.results)
    if (req.step === 0) return [{ type: 'tool_use', name: 'ToolSearch', input: { query: 'Video' } }]
    if (req.step === 1) return [{ type: 'tool_use', name: 'Video', input: { prompt: 'model text to video', duration: 5, outputDir: 'model-renders' } }]
    if (req.step === 2) return [{ type: 'tool_use', name: 'Video', input: { prompt: 'model image to video', references: [{ path: 'reference.png' }], outputDir: 'model-renders' } }]
    return [{ type: 'text', text: 'done' }]
  })
  try {
    const turn = await runScriptedTurn({ runHome: join(scratch, 'model-home'), cwd: work, base: model.base, ask: 'video-tool-proof', timeoutMs: 120_000, extraEnv: { MINIMAX_API_KEY: 'video-proof-key', MERCURY_HOME: '' } })
    const videos = seen.filter(result => result.text.includes('Video saved:'))
    check(`the built model-to-tool loop saves prompt and reference videos (exit ${turn.exitCode}; ${turn.stderr.slice(-200)})`, turn.exitCode === 0 && videos.length === 2 && videos.every(result => !result.isError))
    check('the model sees usage and the saved path in each result', videos.every(result => result.text.includes('total_seconds=5') && result.text.includes('model-renders')))
  } finally { await model.close() }
  console.log(`ALL PASS — ${checked} video assertions`)
} finally {
  clearTimeout(guard)
  await fixture.close()
  rmSync(scratch, { recursive: true, force: true })
}
