import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const ROOT = resolve(process.env.PROOF_SUBJECT_ROOT ?? join(import.meta.dir, '..', '..'))
const PROOF_ROOT = resolve(join(import.meta.dir, '..', '..'))
const SCRATCH_HOME = mkdtempSync(join(tmpdir(), 'mercury-browser-proof-'))
const SCRATCH_BROWSERS = join(SCRATCH_HOME, 'browsers')
mkdirSync(SCRATCH_BROWSERS, { recursive: true })

const inheritedCache = process.env.MERCURY_BROWSER_CACHE_DIR
const ambientCache = process.env.MERCURY_CONFIG_DIR ? join(process.env.MERCURY_CONFIG_DIR, 'browsers') : null
const seedCache =
  inheritedCache && existsSync(join(inheritedCache, 'chrome'))
    ? inheritedCache
    : ambientCache && existsSync(join(ambientCache, 'chrome'))
      ? ambientCache
      : null
if (seedCache) symlinkSync(join(seedCache, 'chrome'), join(SCRATCH_BROWSERS, 'chrome'))

process.env.MERCURY_CONFIG_DIR = SCRATCH_HOME
process.env.MERCURY_HOME = SCRATCH_HOME
process.env.MERCURY_BROWSER_CACHE_DIR = SCRATCH_BROWSERS
process.env.MERCURY_BROWSER_NO_DISCOVERY = '1'
process.env.MERCURY_BROWSER = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_BROWSER_PATH
delete process.env.MERCURY_BROWSER_MAX_SESSIONS
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let checks = 0
let failures = 0
export function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
export function section(title: string): void {
  console.log(`\n${title}`)
}

export const sessions = await import(join(ROOT, 'src/services/browser/browserSession.ts'))
export const { BrowserTool } = await import(join(ROOT, 'src/tools/BrowserTool/BrowserTool.ts'))
const { resolveBrowser } = await import(join(ROOT, 'src/services/browser/browserResolver.ts'))
const { processOwnerForLane } = await import(join(ROOT, 'src/services/run/resolveOwner.ts'))

type ToolInput = Record<string, unknown> & { op: string }
type ToolContext = { agentId?: string; abortController?: AbortController; getAppState?: () => unknown }
interface Answer {
  result: string
  outcome: string
  imagePath?: string
  ms: number
}

export const lead: ToolContext = {}
export const ownerOf = (ctx: ToolContext): string => processOwnerForLane(ctx.agentId ?? null)

export async function run(input: ToolInput, ctx: ToolContext = lead): Promise<Answer> {
  const t0 = Date.now()
  try {
    const { data } = await BrowserTool.call(input as never, ctx as never)
    return { result: String(data.result), outcome: data.outcome, imagePath: data.imagePath, ms: Date.now() - t0 }
  } catch (err) {
    return { result: `THREW ${(err as Error).message}`, outcome: 'threw', ms: Date.now() - t0 }
  }
}

export async function validate(input: ToolInput): Promise<{ ok: boolean; message: string }> {
  const verdict = (await BrowserTool.validateInput!(input as never, lead as never)) as { result: boolean; message?: string }
  return { ok: verdict.result, message: verdict.message ?? '' }
}

export function pageOf(ctx: ToolContext = lead): import('puppeteer-core').Page {
  const live = sessions.activeSession(ownerOf(ctx))
  if (!live) throw new Error('no live session where one was expected')
  return live.page
}

export async function requireBrowser(): Promise<void> {
  let resolved = resolveBrowser()
  if (resolved.state !== 'ok') {
    const { resolveExecutionProfile } = await import(join(PROOF_ROOT, 'scripts/lib/executionProfile.ts'))
    if (resolveExecutionProfile(PROOF_ROOT).kind === 'hosted-gate') {
      const { provisionManagedBrowserForTheGate } = await import(join(PROOF_ROOT, 'scripts/lib/provisionManagedBrowser.ts'))
      const provisioned = await provisionManagedBrowserForTheGate(line => console.log(line))
      if (provisioned.ok) resolved = resolveBrowser()
      if (resolved.state !== 'ok') {
        console.error(`  [FAIL] hosted gate has no drivable browser — ${resolved.note}`)
        process.exit(1)
      }
    } else {
      console.log(`__SUITE_SKIPPED browser: ${resolved.note}`)
      console.log('  – no drivable browser on this machine — SKIP (point MERCURY_BROWSER_CACHE_DIR at a managed Chrome-for-Testing cache to run)')
      rmSync(SCRATCH_HOME, { recursive: true, force: true })
      process.exit(0)
    }
  }
  console.log(`  driving: ${resolved.source} — ${resolved.executablePath}`)
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, hits: http.IncomingMessage[]) => void
interface Fixture {
  origin: string
  port: number
  hits: http.IncomingMessage[]
  close: () => Promise<void>
}
const fixtures: Fixture[] = []

export async function serve(port: number, handler: Handler): Promise<Fixture> {
  const hits: http.IncomingMessage[] = []
  const server = http.createServer((req, res) => {
    hits.push(req)
    handler(req, res, hits)
  })
  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(port, '127.0.0.1', () => done())
  })
  const fixture: Fixture = {
    origin: `http://127.0.0.1:${port}`,
    port,
    hits,
    close: () =>
      new Promise<void>(done => {
        server.closeAllConnections()
        server.close(() => done())
      }),
  }
  fixtures.push(fixture)
  return fixture
}

const stealthSource = readFileSync(join(PROOF_ROOT, 'scripts/browser/prove-browser-stealth.ts'), 'utf8')
const from = stealthSource.indexOf('function detectionHtml(')
const to = stealthSource.indexOf('\nfunction startServer()')
if (from < 0 || to < from) throw new Error('prove-browser-stealth.ts no longer carries detectionHtml before startServer')
const detectionJs = new Bun.Transpiler({ loader: 'ts' }).transformSync(`${stealthSource.slice(from, to)}\nglobalThis.__detectionHtml = detectionHtml`)
new Function(detectionJs)()
export const detectionHtml = (globalThis as unknown as { __detectionHtml: (headers: http.IncomingHttpHeaders, expectedTz: string) => string }).__detectionHtml

export const NINE = ['webdriver', 'headless', 'plugins', 'chromeObject', 'permissions', 'webgl', 'clientHints', 'uaConsistency', 'automationBannerFlag'] as const
interface Detection {
  passed: number
  total: number
  checks: Record<(typeof NINE)[number], boolean>
  details: Record<string, unknown>
}

export async function detect(ctx: ToolContext = lead): Promise<Detection> {
  const live = sessions.activeSession(ownerOf(ctx))
  const flags: string[] = live?.browser.process()?.spawnargs ?? []
  return (await live.page.evaluate(
    (spawnFlags: string[]) => (window as unknown as { __runDetection: (f: string[]) => Promise<unknown> }).__runDetection(spawnFlags),
    flags,
  )) as Detection
}

export async function finish(name: string, owners: ToolContext[] = [lead]): Promise<never> {
  for (const ctx of owners) await sessions.closeBrowserSession(ownerOf(ctx)).catch(() => undefined)
  for (const ctx of owners) await sessions.disposeBrowserOwner(ownerOf(ctx)).catch(() => undefined)
  await Promise.all(fixtures.map(fixture => fixture.close()))
  rmSync(SCRATCH_HOME, { recursive: true, force: true })
  console.log(`\n${checks} checks, ${failures} failures`)
  if (failures > 0) console.error(`${name}: ${failures} FAILURE(S)`)
  else console.log(`${name}: ALL HOLD`)
  process.exit(failures === 0 ? 0 : 1)
}
