import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const REPO = resolve(import.meta.dir, '../..')
export const MODEL = 'claude-opus-5'
export const ASK = 'authentication retry fixture'
export const KEY = 'proof-key-ci-gate-not-a-real-key'
export const argAfter = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag)
  return index < 0 ? undefined : process.argv[index + 1]
}
export const nodeFor = (dist: string): string => {
  const node = join(dist, '../vendor/node', ...(process.platform === 'win32' ? ['node.exe'] : ['bin/node']))
  return existsSync(node) ? node : 'node'
}
export type Arm = 'unavailable' | 'failed' | 'unchanged' | 'refreshed' | 'rejected' | 'revoked' | 'hint' | 'burst' | 'api-key' | 'env-bearer' | 'helper-unchanged' | 'helper-refreshed'
export type Wire = { kind: string; bearer?: string; status?: number; path?: string; at: number }

export async function authWorld(arm: Arm, retryAfter = '0.001') {
  const home = mkdtempSync(join(argAfter('--scratch') ?? tmpdir(), `authentication-${arm}-`))
  const cwd = join(home, 'project')
  mkdirSync(cwd)
  const wires: Wire[] = []
  let requests = 0
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://fixture.invalid').pathname
      const raw = Buffer.concat(chunks).toString('utf8')
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify(value))
      }
      if (path.endsWith('/v1/oauth/token')) {
        wires.push({ kind: 'refresh', at: Date.now() })
        if (arm === 'failed') return json(503, { error: 'temporarily_unavailable' })
        return json(200, {
          access_token: arm === 'refreshed' || arm === 'rejected' ? 'fixture-fresh' : 'fixture-stale',
          refresh_token: 'fixture-refresh', expires_in: 3600,
          scope: 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
        })
      }
      if (path.endsWith('/api/oauth/profile')) {
        return json(200, {
          account: { uuid: 'fixture-account', email: 'fixture@example.invalid', display_name: 'Fixture' },
          organization: { uuid: 'fixture-organization', name: 'Fixture', organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_5x', billing_type: 'stripe_subscription' },
        })
      }
      if (path.endsWith('/v1/messages')) {
        const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
        const target = raw.includes(ASK)
        if (target) requests++
        const succeeds = !target || ((arm === 'refreshed' || arm === 'helper-refreshed') && bearer === 'fixture-fresh') || (arm === 'burst' && requests > 1)
        const status = succeeds ? 200 : arm === 'revoked' ? 403 : arm === 'burst' ? 503 : 401
        wires.push({ kind: target ? 'request' : 'background', bearer, status, at: Date.now() })
        if (!succeeds) {
          return json(status, { type: 'error', error: { type: status === 503 ? 'overloaded_error' : 'authentication_error', message: arm === 'revoked' ? 'OAuth token has been revoked' : 'credential rejected by fixture' } }, {
            ...(retryAfter === '' ? {} : { 'retry-after': retryAfter }),
            ...(arm === 'hint' ? { 'x-should-retry': 'true' } : {}),
          })
        }
        const body = JSON.parse(raw) as { stream?: boolean }
        const usage = { input_tokens: 8, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        if (!body.stream) return json(200, { id: 'fixture-message', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: 'fixture accepted' }], stop_reason: 'end_turn', stop_sequence: null, usage })
        const sse = (type: string, payload: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end([
          sse('message_start', { message: { id: 'fixture-message', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage } }),
          sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
          sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'fixture accepted' } }),
          sse('content_block_stop', { index: 0 }),
          sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }),
          sse('message_stop', {}),
        ].join(''))
        return
      }
      wires.push({ kind: 'other', path, at: Date.now() })
      json(404, { error: 'no fixture route' })
    })
  })
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'))
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture has no port')
  const base = `http://127.0.0.1:${address.port}`
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home, USERPROFILE: home, TMPDIR: tmpdir(), TEMP: tmpdir(), TMP: tmpdir(),
    TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8',
    MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'), MERCURY_HOME: join(home, 'proof-home'),
    MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor'),
    MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_TURN_RECEIPT: '0', MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_LIVE_GLYPHS: '0', MERCURY_LIVE_CLOCK: '0', MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0', MERCURY_CRITTER_SLEEP: '0',
    MERCURY_TERMINAL_TITLE: '0', MERCURY_OPERATOR: 'fixture',
    BROWSER: '/usr/bin/true',
    NODE_OPTIONS: `--require ${JSON.stringify(join(REPO, 'scripts/api/authRetryNetworkFixture.cjs'))}`,
    AUTH_RETRY_FIXTURE_PORT: String(address.port),
    ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: base,
    HTTP_PROXY: base, HTTPS_PROXY: base, ALL_PROXY: base, NO_PROXY: '127.0.0.1,localhost',
    MERCURY_LOCAL_BASE_URL: base,
    MERCURY_MOONSHOT_API_BASE: `${base}/moonshot/v1`, MERCURY_MOONSHOT_OAUTH_BASE: `${base}/moonshot/oauth`,
    MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek`, MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
    MERCURY_OPENAI_API_BASE: `${base}/openai/v1`, MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`, MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
    MERCURY_COMPAT_BASE_URL: `${base}/v1`, MERCURY_OPENROUTER_API_BASE: `${base}/openrouter/v1`, MERCURY_OPENROUTER_AUTH_BASE: `${base}/openrouter/auth`,
    MERCURY_GEMINI_API_BASE: `${base}/gemini/v1beta`, MERCURY_GEMINI_OAUTH_AUTH_BASE: `${base}/gemini/auth`, MERCURY_GEMINI_OAUTH_TOKEN_BASE: `${base}/gemini/token`,
    MERCURY_HUGGINGFACE_API_BASE: `${base}/hf/v1`, MERCURY_HUGGINGFACE_HUB_BASE: `${base}/hf/hub`,
  }
  if (arm !== 'api-key' && arm !== 'env-bearer') delete env.ANTHROPIC_API_KEY
  if (arm === 'env-bearer') env.ANTHROPIC_AUTH_TOKEN = 'fixture-stale'
  writeFileSync(join(home, '.mercury.json'), JSON.stringify({
    hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', numStartups: 10, theme: 'dark',
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
    oauthAccount: { accountUuid: 'fixture-account', emailAddress: 'fixture@example.invalid', organizationUuid: 'fixture-organization' },
  }))
  writeFileSync(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
    accessToken: 'fixture-stale', refreshToken: arm === 'unavailable' ? null : 'fixture-refresh',
    expiresAt: Date.now() + 3_600_000, scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'],
    subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x',
  } }))
  const helperCount = join(home, 'helper-count')
  if (arm.startsWith('helper-')) {
    const helper = join(home, 'helper.cjs')
    writeFileSync(helper, `const fs = require('node:fs'); const p = ${JSON.stringify(helperCount)}; const n = fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8')) + 1 : 1; fs.writeFileSync(p, String(n)); process.stdout.write(${JSON.stringify(arm)} === 'helper-refreshed' && n > 1 ? 'fixture-fresh' : 'fixture-stale');\n`)
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ apiKeyHelper: `"${process.execPath}" "${helper}"` }))
  } else {
    writeFileSync(join(home, 'settings.json'), '{}')
  }
  return {
    home, cwd, env, wires,
    helperCalls: () => existsSync(helperCount) ? Number(readFileSync(helperCount, 'utf8')) : 0,
    close: () => { server.closeAllConnections(); server.close() },
  }
}

export async function runChild(argv: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number) {
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeout)
  const code = await new Promise<number | null>((done, reject) => {
    child.once('error', reject)
    child.once('close', done)
  }).finally(() => clearTimeout(timer))
  return { code, stdout, stderr, timedOut }
}

export function proofRoot(): string {
  const output = argAfter('--out')
  if (output) { mkdirSync(output, { recursive: true }); return resolve(output) }
  return mkdtempSync(join(tmpdir(), 'authentication-retry-'))
}
