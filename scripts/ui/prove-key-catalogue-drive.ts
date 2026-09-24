#!/usr/bin/env bun
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const ROOT = resolve(import.meta.dir, '../..')
const DIST = resolve(arg('--dist') ?? join(ROOT, 'dist/mercury.mjs'))
const OUT = arg('--frames')
const SIZES = (arg('--sizes') ?? '120x40,80x21,80x14,82x17').split(',').map(size => size.split('x').map(Number) as [number, number])
const FAMILIES = (arg('--families') ?? 'zai,moonshot,kimi').split(',')
const SCRATCH = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), arg('--scratch-prefix') ?? 'key-catalogue-')))
const node = join(dirname(DIST), 'vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const NODE = existsSync(node) ? node : 'node'
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') throw new Error(driver.remedy)
if (!existsSync(DIST)) throw new Error(`Build missing: ${DIST}`)
if (OUT) mkdirSync(OUT, { recursive: true })
const DEAD = 'http://127.0.0.1:1'
const KEY = 'proof-key-ci-gate-not-a-real-key'
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
type Grid = Array<Array<{ c?: string }>>
type Payload = { grid: Grid; marks?: Array<{ label: string; grid: Grid }>; sendReceipts?: unknown[]; endReason?: string }
const text = (grid: Grid): string => grid.map(row => row.map(cell => cell.c ?? ' ').join('').trimEnd()).join('\n')
console.log(`bundle ${DIST}\nscratch ${SCRATCH}`)
for (const family of FAMILIES) {
  for (const [cols, rows] of SIZES) {
    const tag = `${family}-${cols}x${rows}`
    const home = join(SCRATCH, tag)
    const cwd = join(home, 'work')
    mkdirSync(cwd, { recursive: true })
    process.env.ANTHROPIC_API_KEY = KEY
    seedFirstRun(home, [cwd])
    writeFileSync(join(home, 'settings.json'), '{}')
    const provider = family === 'zai' ? 'zai' : 'moonshot'
    const retired = family === 'zai' ? 'glm-5.3' : 'kimi-k3'
    const next = family === 'zai' ? 'glm-fixture-next' : 'kimi-fixture-next'
    const kept = family === 'zai' ? 'glm-5.2' : 'kimi-k2.6'
    const live = { object: 'list', data: [
      { id: kept, object: 'model', owned_by: provider, created: 100, context_length: 262144, supports_image_in: false, supports_video_in: false, supports_reasoning: true },
      { id: next, object: 'model', owned_by: provider, created: 200, context_length: 524288, supports_image_in: true, supports_video_in: true, supports_reasoning: true },
    ] }
    writeFileSync(join(home, '.sign-ins.json'), JSON.stringify({ version: 1, signIns: { [provider]: { kind: family === 'kimi' ? 'oauth' : 'api-key', at: Date.now() } } }))
    if (family === 'kimi') writeFileSync(join(home, '.moonshot-auth.json'), JSON.stringify({ version: 1, region: 'global', tokens: { accessToken: KEY, refreshToken: 'fixture-refresh', accessTokenExpiresAtMs: Date.now() + 86400000 } }), { mode: 0o600 })
    else writeFileSync(join(home, '.provider-secrets.json'), JSON.stringify({ version: 1, [family === 'zai' ? 'zaiApiKey' : 'moonshotApiKey']: KEY }), { mode: 0o600 })
    const ledger = join(home, 'wire.jsonl')
    writeFileSync(ledger, '')
    const wire: Array<{ method: string; url: string; model?: string; status: number }> = []
    let listMode = 'live'
    let serveRetired = false
    const fixture = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const path = new URL(req.url ?? '/', 'http://fixture').pathname
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
        const isList = req.method === 'GET' && path.endsWith('/models')
        const isChat = req.method === 'POST' && path.endsWith('/chat/completions')
        const served = live.data.some(row => row.id === body.model) || (serveRetired && body.model === retired)
        const status = req.headers.authorization !== `Bearer ${KEY}` ? 401 : isList ? listMode === 'unreachable' ? 503 : 200 : isChat && served ? 200 : 404
        const hit = { method: req.method ?? '', url: path, ...(typeof body.model === 'string' ? { model: body.model } : {}), status }
        wire.push(hit)
        appendFileSync(ledger, JSON.stringify(hit) + '\n')
        if (status !== 200) {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 'resource_not_found_error', message: `fixture refuses retired model ${body.model ?? path}` } }))
        } else if (isList) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(listMode === 'empty' ? { object: 'list', data: [] } : live))
        } else {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          const chunk = (delta: unknown, finish_reason: string | null, usage?: unknown): string => `data: ${JSON.stringify({ id: 'fixture-chat', object: 'chat.completion.chunk', created: 200, model: body.model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`
          res.end(chunk({ role: 'assistant', content: 'fixture catalogue answer' }, null) + chunk({}, 'stop', { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }) + 'data: [DONE]\n\n')
        }
      })
    })
    await new Promise<void>(resolvePort => fixture.listen(0, '127.0.0.1', resolvePort))
    try {
      const address = fixture.address()
      if (!address || typeof address === 'string') throw new Error('fixture has no port')
      const base = `http://127.0.0.1:${address.port}`
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH, HOME: home, TMPDIR: realpathSync(tmpdir()),
        TERM: 'xterm-256color', LANG: 'en_US.UTF-8', COLORTERM: 'truecolor',
        MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true',
        ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: DEAD, MERCURY_CUSTOM_OAUTH_URL: DEAD,
        MERCURY_OPENAI_API_BASE: DEAD, MERCURY_OPENAI_AUTH_BASE: DEAD, MERCURY_OPENAI_CHATGPT_BASE: DEAD,
        MERCURY_OPENROUTER_API_BASE: DEAD, MERCURY_OPENROUTER_AUTH_BASE: DEAD,
        MERCURY_GEMINI_API_BASE: DEAD, MERCURY_GEMINI_OAUTH_AUTH_BASE: DEAD, MERCURY_GEMINI_OAUTH_TOKEN_BASE: DEAD,
        MERCURY_ZAI_API_BASE: family === 'zai' ? `${base}/zai` : DEAD,
        MERCURY_MOONSHOT_API_BASE: family === 'moonshot' ? `${base}/platform/v1` : DEAD,
        MERCURY_MOONSHOT_CODING_BASE: family === 'kimi' ? `${base}/coding/v1` : DEAD,
        MERCURY_MOONSHOT_OAUTH_BASE: DEAD, MERCURY_DEEPSEEK_API_BASE: DEAD,
        MERCURY_HUGGINGFACE_API_BASE: DEAD, MERCURY_HUGGINGFACE_HUB_BASE: DEAD, MERCURY_UPDATE_API_BASE_URL: DEAD,
        MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_TEAMS_DIR: join(home, 'teams'), MERCURY_TABULA_DIR: join(home, 'tabula'),
        MERCURY_HOME: join(home, 'proof-home'), MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor-state'), MERCURY_LOCAL_PROBE_TARGETS: 'none',
        MERCURY_BOOT_PREFLIGHT: '0', MERCURY_LIVE_GLYPHS: '0', MERCURY_LIVE_CLOCK: '0',
        MERCURY_CRITTER_GAZE: '0', MERCURY_CRITTER_IDLE: '0', MERCURY_CRITTER_SLEEP: '0',
        MERCURY_TURN_RECEIPT: '0', MERCURY_VERIFY_EVIDENCE: '0',
        MERCURY_TERMINAL_TITLE: '0', MERCURY_UPDATE_NOTICE: '0', MERCURY_OPERATOR: 'sam', MERCURY_CAP_FAILOVER: '0',
      }
      if (process.argv.includes('--print-control')) {
        const modelsUrl = `${base}/${family === 'zai' ? 'zai' : family === 'kimi' ? 'coding/v1' : 'platform/v1'}/models`
        const response = await fetch(modelsUrl, { headers: { authorization: `Bearer ${KEY}` } })
        const listed = await response.json() as typeof live
        const result = await new Promise<{ code: number; stdout: string; stderr: string }>(resolveRun => {
          execFile(NODE, [DIST, '-p', '--model', next, '--output-format', 'json', 'hello'], { env, cwd, windowsHide: true, timeout: vshotBudgetMs(60000) }, (error, stdout, stderr) => resolveRun({ code: error ? Number(error.code) || 1 : 0, stdout, stderr }))
        })
        const output = JSON.stringify({ modelsUrl, listStatus: response.status, listed, ...result, wire }, null, 2)
        writeFileSync(join(OUT ?? home, `${tag}-control.json`), output)
        check(`${tag}: the fixture lists the next id and lacks the typed default`, listed.data.some(row => row.id === next) && listed.data.every(row => row.id !== retired))
        check(`${tag}: naming the served id succeeds on the same bundle and credential`, result.code === 0 && result.stdout.includes('fixture catalogue answer'), output)
        continue
      }
      const runPrintMatrix = async (): Promise<void> => {
        const cases = family === 'zai' ? [{ name: 'provider-reason', model: retired, refused: true }] : [
          { name: 'default', expected: next },
          { name: 'explicit', model: kept, expected: kept },
          { name: 'saved', saved: kept, expected: kept },
          { name: 'environment', envModel: kept, expected: kept },
          { name: 'retired', model: retired, refused: true },
          { name: 'empty', model: next, list: 'empty', refused: true },
          { name: 'unreachable', model: next, list: 'unreachable', expected: next, degraded: true },
          { name: 'dated-default', list: 'unreachable', oldServed: true, expected: retired, degraded: true },
          { name: 'traffic-off', model: next, dark: true, expected: next, degraded: true },
        ]
        for (const test of cases as Array<{ name: string; model?: string; expected?: string; saved?: string; envModel?: string; list?: string; oldServed?: boolean; refused?: boolean; degraded?: boolean; dark?: boolean }>) {
          wire.splice(0)
          listMode = test.list ?? 'live'
          serveRetired = test.oldServed ?? false
          writeFileSync(join(home, 'settings.json'), JSON.stringify(test.saved ? { model: test.saved } : {}))
          const childEnv = { ...env, ...(test.envModel ? { MERCURY_MODEL: test.envModel } : {}), ...(test.dark ? { MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1' } : {}) }
          const result = await new Promise<{ code: number; stdout: string; stderr: string }>(resolveRun => {
            execFile(NODE, [DIST, '-p', ...(test.model ? ['--model', test.model] : []), '--output-format', 'stream-json', 'hello'], { env: childEnv, cwd, windowsHide: true, timeout: vshotBudgetMs(60000) }, (error, stdout, stderr) => resolveRun({ code: error ? Number(error.code) || 1 : 0, stdout, stderr }))
          })
          writeFileSync(join(OUT ?? home, `${tag}-${test.name}.json`), JSON.stringify({ test, ...result, wire }, null, 2))
          const chats = wire.filter(hit => hit.url.endsWith('/chat/completions'))
          if (family === 'zai') {
            const words = result.stdout
            check(`${tag}: the Z.AI reason follows the status`, words.includes('http-404') && words.includes('fixture refuses retired model') && words.indexOf('http-404') < words.indexOf('fixture refuses retired model'), words)
          } else if (test.refused) {
            check(`${tag} ${test.name}: refusal precedes every chat request`, chats.length === 0 && result.stdout.includes('is not offered by the') && result.stdout.includes('live catalogue'), JSON.stringify({ chats, stdout: result.stdout }))
          } else {
            check(`${tag} ${test.name}: the chosen id reaches its own wire and answers`, chats.some(hit => hit.model === test.expected && hit.status === 200) && result.stdout.includes('fixture catalogue answer'), JSON.stringify({ chats, stdout: result.stdout }))
          }
          if (test.degraded) check(`${tag} ${test.name}: degraded admission is visible`, result.stdout.includes('live model catalogue is unavailable') && result.stdout.includes('proceeding with'), result.stdout)
          if (test.dark) check(`${tag}: traffic off makes no models request`, !wire.some(hit => hit.url.endsWith('/models')))
        }
      }
      if (process.argv.includes('--print-matrix')) {
        await runPrintMatrix()
        continue
      }
      const out = join(home, 'grid.json')
      const cfg = join(home, 'cfg.json')
      const landed = cols >= 100 && rows >= 26 ? '← back' : '1 session on'
      const ready = cols >= 100 && rows >= 26 ? 'ready · ' : '1 session on'
      const sends = [
        { requireAwait: true, awaitText: 'New Session', minTick: 5, awaitSettleTicks: 3, data: '', mark: 'birth' },
        { requireAwait: true, awaitText: 'New Session', minTick: 3, awaitSettleTicks: 2, data: '\r' },
        { requireAwait: true, awaitText: landed, minTick: 10, awaitSettleTicks: 3, data: 'hello\r', mark: 'default' },
        { requireAwait: true, awaitText: 'fixture ', minTick: 4, awaitSettleTicks: 3, data: '', mark: 'chat' },
        { requireAwait: true, awaitText: ready, minTick: 3, awaitSettleTicks: 3, data: '/model\r' },
        { requireAwait: true, awaitText: '↑↓', minTick: 5, awaitSettleTicks: 3, data: '', mark: 'picker' },
      ]
      writeFileSync(cfg, JSON.stringify({ argv: [NODE, DIST], cwd, cols, rows, total: 400, sends, out, stableTicks: 4 }))
      const status = await new Promise<number>((resolveCapture, reject) => {
        execFile(driver.python, [captureEngineEntry(driver, ROOT), cfg], { env, cwd, windowsHide: true, timeout: vshotBudgetMs(180000) }, (error, stdout, stderr) => {
          writeFileSync(join(home, 'capture.log'), stdout + stderr)
          if (error && !existsSync(out)) reject(new Error(`${error}\n${stderr}`))
          else resolveCapture(error ? Number(error.code) || 1 : 0)
        })
      })
      const payload = JSON.parse(readFileSync(out, 'utf8')) as Payload
      const marks = new Map((payload.marks ?? []).map(mark => [mark.label, text(mark.grid)]))
      if (OUT) {
        for (const [label, screen] of marks) writeFileSync(join(OUT, `${tag}-${label}.txt`), screen + '\n')
        writeFileSync(join(OUT, `${tag}-final.txt`), text(payload.grid) + '\n')
        writeFileSync(join(OUT, `${tag}-grid.json`), JSON.stringify(payload))
        writeFileSync(join(OUT, `${tag}-wire.jsonl`), readFileSync(ledger))
      }
      const chat = wire.find(hit => hit.url.endsWith('/chat/completions'))
      const picker = marks.get('picker') ?? text(payload.grid)
      const liveName = family === 'zai' ? 'GLM Fixture Next' : 'Kimi Fixture Next'
      check(`${tag}: the drive reached every state`, status === 0 && payload.sendReceipts?.length === sends.length, `${payload.sendReceipts?.length}/${sends.length}; ${payload.endReason}`)
      if (family === 'zai') {
        const words = marks.get('chat') ?? ''
        check(`${tag}: Z.AI paints its static rows under the key and asks no endpoint`, !wire.some(hit => hit.url.endsWith('/models')) && chat?.model === retired && (!picker.includes('CHOOSE A MODEL') || (picker.includes('Z.AI MODELS') && picker.includes('key present') && picker.includes('GLM-5.3') && (picker.includes('GLM-5.2') || /↓ \d+ more/.test(picker)) && !picker.includes(liveName) && !picker.includes(next))))
        check(`${tag}: Z.AI preserves the provider reason after the status`, words.includes('http-404') && words.includes('fixture refuses retired model') && words.indexOf('http-404') < words.indexOf('fixture refuses retired model'))
        continue
      }
      check(`${tag}: the provider list was fetched`, wire.some(hit => hit.url.endsWith('/models') && hit.status === 200), JSON.stringify(wire))
      check(`${tag}: the fresh default requests the newest served id`, chat?.model === next, JSON.stringify(chat))
      check(`${tag}: the first chat succeeds`, marks.get('chat')?.includes('fixture catalogue answer') === true)
      check(`${tag}: the picker includes the untyped live id`, picker.includes(next) || picker.includes(liveName), picker)
      check(`${tag}: the picker excludes the retired typed row`, !picker.includes(retired) && !picker.includes(family === 'zai' ? 'GLM-5.3' : 'Kimi K3'))
      check(`${tag}: catalogue and chat use the credential's own base`, wire.filter(hit => hit.url.endsWith('/models') || hit.url.endsWith('/chat/completions')).every(hit => hit.url.startsWith(family === 'zai' ? '/zai/' : family === 'kimi' ? '/coding/v1/' : '/platform/v1/')))
      if (cols === SIZES[0]?.[0] && rows === SIZES[0]?.[1]) await runPrintMatrix()
    } finally {
      fixture.closeAllConnections()
      await new Promise<void>(resolveClose => fixture.close(() => resolveClose()))
    }
  }
}
console.log(`${checks} checks, ${failures} failures; worlds kept at ${SCRATCH}`)
process.exit(failures === 0 ? 0 : 1)
