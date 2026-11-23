#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))


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
    `const { enableConfigs } = await import(${JSON.stringify(join(ROOT, 'src/platform/config/globalConfig.ts'))})`,
    'enableConfigs()',
    `const auth = await import(${JSON.stringify(join(ROOT, 'src/models/sign-in/credentials/auth.ts'))})`,
    'console.log(JSON.stringify({ key: auth.getApiKeyFromConfigOrMacOSKeychain() }))',
  ].join('\n')
  const child = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000 })
  const reached = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
  check('the child ran the managed-key read to completion', child.status === 0, `status ${child.status} · stderr ${JSON.stringify((child.stderr ?? '').slice(0, 200))} · fix getApiKeyFromConfigOrMacOSKeychain in src/models/sign-in/credentials/auth.ts so the read finishes without throwing on a keychain miss`)
  check('the lookup reached the keychain tool (the miss was real, not skipped)', reached.some(l => /find-generic-password/.test(l)), `${reached.join(' | ')} · the managed-key read must call readKeychainServiceSync in src/platform/secure-storage/macOsKeychainStorage.ts, which runs security find-generic-password`)
  check('the read answered config (no key)', /"key":null/.test(child.stdout ?? ''), `${(child.stdout ?? '').slice(0, 120)} · readManagedKey in src/models/sign-in/credentials/auth.ts must return null after a keychain miss when config holds no key`)
  check("the child's stderr is EMPTY — the tool's miss line never reached the process's stderr", (child.stderr ?? '').trim() === '', `${JSON.stringify((child.stderr ?? '').slice(0, 200))} · the security call in src/platform/secure-storage/macOsKeychainStorage.ts (runSecurity) must not let the tool's stderr through on exit 44`)

  section('§3 a keychain write that fails is reported as failed, so the key lands in config instead of nowhere (darwin)')
  writeFileSync(join(bin, 'security'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nif [ "$1" = "-i" ]; then cat >/dev/null; fi\nexit 1\n`)
  const saveScript = [
    "(globalThis).MACRO = { VERSION: '1.0.0' }",
    `const { enableConfigs, getGlobalConfig } = await import(${JSON.stringify(join(ROOT, 'src/platform/config/globalConfig.ts'))})`,
    'enableConfigs()',
    `const auth = await import(${JSON.stringify(join(ROOT, 'src/models/sign-in/credentials/auth.ts'))})`,
    "await auth.saveApiKey('fixture-key-shim-refused')",
    'console.log(JSON.stringify({ primaryApiKey: getGlobalConfig().primaryApiKey ?? null }))',
  ].join('\n')
  const saved = spawnSync(process.execPath, ['-e', saveScript], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000 })
  check('the save ran to completion', saved.status === 0, `status ${saved.status} · stderr ${JSON.stringify((saved.stderr ?? '').slice(0, 200))} · saveApiKey in src/models/sign-in/credentials/auth.ts must not throw when the keychain write is refused`)
  check('the write reached the keychain tool through its stdin road', (existsSync(log) ? readFileSync(log, 'utf8') : '').split('\n').some(l => l.trim() === '-i'), `${readFileSync(log, 'utf8')} · saveApiKey in src/models/sign-in/credentials/auth.ts must write through writeKeychainHexStdin, which runs security -i with the command on stdin`)
  check('a refused keychain write leaves the key in config (base: the write reported success and the key went nowhere)', /"primaryApiKey":"fixture-key-shim-refused"/.test(saved.stdout ?? ''), `${(saved.stdout ?? '').slice(0, 160)} · saveApiKey in src/models/sign-in/credentials/auth.ts must keep primaryApiKey in config when writeKeychainHexStdin returns false`)
}

section('§4 a blank credential file-descriptor variable is refused, never read as fd 0')
{
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  for (const k of ['MERCURY_HOME', 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CI', 'NODE_ENV']) delete env[k]
  env.MERCURY_API_KEY_FILE_DESCRIPTOR = ''
  const script = [
    `const fd = await import(${JSON.stringify(join(ROOT, 'src/models/sign-in/credentials/authFileDescriptor.ts'))})`,
    'const key = fd.getApiKeyFromFileDescriptor()',
    "const stdin = require('node:fs').readFileSync(0, 'utf8')",
    'console.log(JSON.stringify({ key, stdin }))',
  ].join('\n')
  const child = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, env, encoding: 'utf8', input: 'STDIN-PROMPT-TEXT', timeout: 120_000 })
  check('the child ran', child.status === 0, `status ${child.status} · stderr ${JSON.stringify((child.stderr ?? '').slice(0, 200))} · getApiKeyFromFileDescriptor in src/models/sign-in/credentials/authFileDescriptor.ts must not throw on a blank variable`)
  check('a blank variable yields no key and stdin is still whole for the prompt (base: stdin became the credential)', /"key":null,"stdin":"STDIN-PROMPT-TEXT"/.test(child.stdout ?? ''), `${(child.stdout ?? '').slice(0, 160)} · getApiKeyFromFileDescriptor in src/models/sign-in/credentials/authFileDescriptor.ts must return null for a blank MERCURY_API_KEY_FILE_DESCRIPTOR and leave stdin unread`)
}

console.log(failures === 0 ? '\n✅ prove-keychain-miss-is-quiet — all checks pass' : `\n❌ prove-keychain-miss-is-quiet — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
