#!/usr/bin/env bun
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  probeScopeAuth,
  readScopeIdentity,
} from '../../src/utils/accounts/scopeScan.js'

let fail = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) fail++
}
const id = (uuid: string, email: string): string =>
  JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: email } })

console.log('prove-accounts-display — available accounts, deduped, honestly resolved')

const home = mkdtempSync(join(tmpdir(), 'accounts-display-'))
try {
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(home, '.claude-account-b'), { recursive: true })
  writeFileSync(join(home, '.claude', '.claude.json'), id('uuid-user-a', 'user-a@example.com'))
  writeFileSync(join(home, '.claude.json'), id('uuid-raverner', 'raverner.gaming@gmail.com'))
  writeFileSync(join(home, '.claude-account-b', '.claude.json'), id('uuid-raverner', 'raverner.gaming@gmail.com'))

  console.log('\n── probeScopeAuth: the dir-scoped snapshot is the ONE identity source')
  const foreign = probeScopeAuth(join(home, '.claude'))
  check('the scope dir resolves its DIR-SCOPED login', foreign.authed && foreign.uuid === 'uuid-user-a', JSON.stringify(foreign))
  check('email carried', foreign.email === 'user-a@example.com')

  console.log('\n── no top-level fallback: another harness\'s rewritable file never answers')
  rmSync(join(home, '.claude', '.claude.json'))
  const fell = probeScopeAuth(join(home, '.claude'))
  check('snapshot missing ⇒ signed-out (the top-level file is never consulted)', !fell.authed && fell.uuid === undefined, JSON.stringify(fell))
  writeFileSync(join(home, '.claude', '.claude.json'), '{not json')
  const malformed = probeScopeAuth(join(home, '.claude'))
  check('malformed snapshot ⇒ signed-out (a state, not a crash; never the top-level file)', !malformed.authed && malformed.uuid === undefined)
  writeFileSync(join(home, '.claude', '.claude.json'), id('uuid-user-a', 'user-a@example.com'))

  console.log('\n── credential-file arm (non-keychain platforms)')
  mkdirSync(join(home, '.claude-account-c'), { recursive: true })
  writeFileSync(join(home, '.claude-account-c', '.credentials.json'), '{}')
  const credOnly = probeScopeAuth(join(home, '.claude-account-c'))
  check('credfile-only scope reads authed (no uuid)', credOnly.authed && credOnly.uuid === undefined)

  check('readScopeIdentity: absent file ⇒ {}', readScopeIdentity(join(home, 'nope.json')).uuid === undefined)

  console.log('\n── structural: the single-scope universe + board wiring')
  const src = readFileSync(join(import.meta.dir, '../../src/components/mercury-ui/parity/AccountView.tsx'), 'utf8')
  const scanSrc = readFileSync(join(import.meta.dir, '../../src/utils/accounts/scopeScan.ts'), 'utf8')
  check('the scan universe is the resolved home only (no enumeration)',
    scanSrc.includes('const dir = resolve(getMercuryHome())') && !scanSrc.includes('readdirSync'))
  check('a Claude-family resolved home is marked, never billable',
    scanSrc.includes('claudeFamily: isClaudeFamilyDir(dir)') && src.includes("another tool's credential scope"))
  check('the board consumes the ONE scan owner (no second copy)',
    src.includes('deriveFamilySlotGroups()') && !src.includes('readdirSync(home'))
  check('no credential re-pointing arm survives on the board',
    !src.includes('slotScopeCredential') && !src.includes('writeSelectedAccount'))
  const slotsSrc = readFileSync(join(import.meta.dir, '../../src/services/providers/accountSlots.ts'), 'utf8')
  check('backspace signs out — the home dir is never deleted',
    slotsSrc.includes('The home dir itself is') && !slotsSrc.includes('rm -rf') && src.includes('executeSlotRemoval('))
  check('identity is live-verified (credential-derived, not snapshot-only)',
    src.includes('resolveLiveScopeIdentity') && src.includes('verified live'))
  check("'this session' is gated on isCurrent",
    src.includes("s.isCurrent ? 'this session' : ''"))
  const loginSrc = readFileSync(join(import.meta.dir, '../../src/commands/login/login.tsx'), 'utf8')
  const flowSrc = readFileSync(join(import.meta.dir, '../../src/components/ConsoleOAuthFlow.tsx'), 'utf8')
  check('/logins huggingface (and hf) pre-focus the Hugging Face row',
    loginSrc.includes("case 'huggingface':") && loginSrc.includes("case 'hf':"))
  const rowOwnerSrc = readFileSync(join(import.meta.dir, '../../src/components/loginFamilyRows.ts'), 'utf8')
  check('the flow accepts every family focus through ONE union (huggingface · moonshot · zai · deepseek), no silent drop',
    flowSrc.includes('initialFocus?: LoginFamilyFocus') &&
      flowSrc.includes('LoginFamilyFocus = LoginFamilyValue') &&
      ["| 'huggingface'", "| 'moonshot'", "| 'zai'", "| 'deepseek'"].every(member => rowOwnerSrc.includes(member)))
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(fail === 0 ? '\n✅ prove-accounts-display: ALL PASS' : `\n❌ prove-accounts-display: ${fail} FAILURE(S)`)
process.exit(fail === 0 ? 0 : 1)
