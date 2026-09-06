#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

section('§1 every keychain spawn in src captures the tool\'s stderr')
{
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.tsx?$/.test(name)) out.push(p)
    }
    return out
  }
  const files = walk(join(ROOT, 'src'))
  const spawnSites: string[] = []
  const inherited: string[] = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    if (!/['"]security['"]/.test(text)) continue
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      if (!/(execFileSync|execFile|spawnSync|spawn|execFileNoThrow)\(\s*['"]security['"]/.test(line)) return
      const rel = relative(ROOT, f)
      spawnSites.push(`${rel}:${i + 1}`)
      if (/execFileSync|execSync/.test(line)) {
        const window = lines.slice(i, i + 6).join('\n')
        if (!/stdio\s*:/.test(window)) inherited.push(`${rel}:${i + 1}`)
      }
    })
  }
  check('the tree spawns the keychain tool somewhere (the census is not vacuous)', spawnSites.length >= 3, spawnSites.join(' '))
  check('no keychain spawn hands its stderr to the process (no bare execFileSync)', inherited.length === 0, inherited.join(' '))
  const auth = readFileSync(join(ROOT, 'src/utils/auth.ts'), 'utf8')
  check('auth.ts spawns the keychain tool through no sync exec of its own', !/execFileSync\(/.test(auth))
  check('…the legacy managed-key service is read through the store\'s one reader', /readKeychainServiceSync\(getMacOsKeychainStorageServiceName\(\)\)/.test(auth))
  const store = readFileSync(join(ROOT, 'src/utils/secureStorage/macOsKeychainStorage.ts'), 'utf8')
  check('the store exports that one reader over the bounded runner', /export function readKeychainServiceSync\(/.test(store) && /runSecurity\(\['find-generic-password'/.test(store))
}

section('§2 a miss on a headless read prints nothing (darwin)')
if (process.platform !== 'darwin') {
  console.log('  · skipped: the keychain tool exists on macOS only (the structure law above stands everywhere)')
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'keychain-quiet-'))
  const bin = join(scratch, 'bin')
  const home = join(scratch, 'home')
  const log = join(scratch, 'security-invocations.log')
  mkdirSync(bin, { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(bin, 'security'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\necho "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2\nexit 44\n`,
  )
  chmodSync(join(bin, 'security'), 0o755)
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  env.PATH = `${bin}:${env.PATH ?? ''}`
  env.MERCURY_CONFIG_DIR = home
  for (const k of ['MERCURY_HOME', 'MERCURY_CREDENTIAL_STORE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR', 'MERCURY_API_KEY_FILE_DESCRIPTOR', 'MERCURY_BARE', 'CI', 'NODE_ENV']) delete env[k]
  const script = [
    "(globalThis).MACRO = { VERSION: '1.0.0' }",
    `const { enableConfigs } = await import(${JSON.stringify(join(ROOT, 'src/utils/config/globalConfig.ts'))})`,
    'enableConfigs()',
    `const auth = await import(${JSON.stringify(join(ROOT, 'src/utils/auth.ts'))})`,
    'console.log(JSON.stringify({ key: auth.getApiKeyFromConfigOrMacOSKeychain() }))',
  ].join('\n')
  const child = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000 })
  const reached = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
  check('the child ran the managed-key read to completion', child.status === 0, `status ${child.status} · stderr ${JSON.stringify((child.stderr ?? '').slice(0, 200))}`)
  check('the lookup reached the keychain tool (the miss was real, not skipped)', reached.some(l => /find-generic-password/.test(l)), reached.join(' | '))
  check('the read answered config (no key)', /"key":null/.test(child.stdout ?? ''), (child.stdout ?? '').slice(0, 120))
  check("the child's stderr is EMPTY — the tool's miss line never reached the process's stderr", (child.stderr ?? '').trim() === '', JSON.stringify((child.stderr ?? '').slice(0, 200)))
}

console.log(failures === 0 ? '\n✅ prove-keychain-miss-is-quiet — all checks pass' : `\n❌ prove-keychain-miss-is-quiet — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
