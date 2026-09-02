#!/usr/bin/env bun
// ============================================================================
//  prove-parity2-sandbox-bump — the @anthropic-ai/sandbox-runtime
//  0.0.54 → 0.0.73 → 0.0.74 bumps (sweep #2, RULED keep + track): the adapter
//  contract at the new version, LIVE where the platform supports it.
//
//   1. The adapter-side path-list bound (S2 B4.4): de-dupe + cap, logged
//      once, never silent.
//   2. The vendored runtime at 0.0.74 still honours the adapter's config
//      shape (schema parse of our converted config).
//   3. LIVE (macOS sandbox-exec / Linux bubblewrap when available): a
//      sandboxed command runs; a write outside allowWrite is refused; a
//      write inside allowWrite lands. Skipped honestly when the platform
//      cannot sandbox (the skip is reported, never a silent pass).
// ============================================================================
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'parity2-sandbox-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.MERCURY_HOME

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

// —— 1. the adapter-side bound ————————————————————————————————————————
{
  const { boundPathList, SANDBOX_PATH_LIST_CAP } = await import('../../src/utils/sandbox/sandbox-adapter.ts')
  const small = boundPathList('probe.small', ['/a', '/b', '/a', '', '/c'])
  t('a small list de-duplicates and drops empties, order kept', JSON.stringify(small) === JSON.stringify(['/a', '/b', '/c']))
  const big = boundPathList('probe.big', Array.from({ length: SANDBOX_PATH_LIST_CAP + 500 }, (_, i) => `/p/${i}`))
  t('an oversized list is capped at the argv ceiling', big.length === SANDBOX_PATH_LIST_CAP)
}

// —— 2. the runtime's config contract at 0.0.74 —————————————————————————
{
  const runtime = await import('@anthropic-ai/sandbox-runtime')
  const pkg = JSON.parse((await import('node:fs')).readFileSync('node_modules/@anthropic-ai/sandbox-runtime/package.json', 'utf8')) as { version: string }
  t('the vendored runtime is 0.0.74', pkg.version === '0.0.74', pkg.version)
  const { convertToSandboxRuntimeConfig } = await import('../../src/utils/sandbox/sandbox-adapter.ts')
  const config = convertToSandboxRuntimeConfig({
    sandbox: {
      enabled: true,
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { allowRead: [], denyRead: [], allowWrite: [] },
    },
  } as never)
  const parsed = runtime.SandboxRuntimeConfigSchema.safeParse(config)
  t('the adapter\'s converted config parses under the 0.0.74 schema', parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 2)))
  const surface = ['initialize', 'wrapWithSandbox', 'checkDependencies', 'reset', 'updateConfig', 'annotateStderrWithSandboxFailures', 'cleanupAfterCommand', 'getSandboxViolationStore', 'getFsReadConfig', 'getFsWriteConfig', 'getNetworkRestrictionConfig', 'waitForNetworkInitialization']
  const missing = surface.filter(name => typeof (runtime.SandboxManager as unknown as Record<string, unknown>)[name] !== 'function')
  t('every adapter-used static of SandboxManager still exists', missing.length === 0, missing.join(','))
  t('getWslVersion and SandboxViolationStore still export', typeof runtime.getWslVersion === 'function' && typeof runtime.SandboxViolationStore === 'function')
}

// —— 3. LIVE sandboxed command ——————————————————————————————————————————
{
  const runtime = await import('@anthropic-ai/sandbox-runtime')
  const deps = runtime.SandboxManager.checkDependencies() as { errors?: unknown[]; warnings?: unknown[] }
  const platformOk = process.platform === 'darwin' || process.platform === 'linux'
  const ready = platformOk && Array.isArray(deps.errors) && deps.errors.length === 0
  if (!ready) {
    console.log(`SKIP  live sandboxed command — platform/deps not ready: ${JSON.stringify(deps)}`)
  } else {
    const allowed = join(SCRATCH, 'allowed')
    mkdirSync(allowed, { recursive: true })
    const outside = join(SCRATCH, 'outside')
    mkdirSync(outside, { recursive: true })
    await runtime.SandboxManager.initialize(
      {
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: { allowWrite: [allowed], denyWrite: [], allowRead: [], denyRead: [] },
      } as never,
      undefined as never,
    )
    const run = async (command: string): Promise<{ code: number; out: string }> => {
      const wrapped = await runtime.SandboxManager.wrapWithSandbox(command, '/bin/sh')
      try {
        const out = execSync(wrapped, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 })
        return { code: 0, out }
      } catch (error) {
        const e = error as { status?: number; stdout?: string; stderr?: string }
        return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
      }
    }
    const echo = await run('echo sandboxed-ok')
    t('a sandboxed echo runs at 0.0.74', echo.code === 0 && /sandboxed-ok/.test(echo.out), echo.out.slice(0, 120))
    const inside = await run(`echo in > ${JSON.stringify(join(allowed, 'in.txt'))}`)
    t('a write inside allowWrite lands', inside.code === 0 && existsSync(join(allowed, 'in.txt')), inside.out.slice(0, 120))
    const blocked = await run(`echo out > ${JSON.stringify(join(outside, 'out.txt'))}`)
    t('a write outside allowWrite is refused by the sandbox', blocked.code !== 0 && !existsSync(join(outside, 'out.txt')), `code ${blocked.code}: ${blocked.out.slice(0, 120)}`)
    await runtime.SandboxManager.reset()
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures ? '\nFAILURES' : '\nALL GREEN')
process.exit(failures)
