import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures++
}

const configHome = mkdtempSync(join(tmpdir(), 'realm-cfg-'))
const homeScratch = mkdtempSync(join(homedir(), '.realm-proof-'))
const realmA = join(homeScratch, 'projA')
const realmB = join(homeScratch, 'projB')
mkdirSync(realmA, { recursive: true })
mkdirSync(realmB, { recursive: true })

const prevEnv = process.env.MERCURY_CONFIG_DIR
process.env.MERCURY_CONFIG_DIR = configHome

const reg = (await import('../../src/utils/realmRegistry.js')) as typeof import('../../src/utils/realmRegistry.js')

try {
  const outside = mkdtempSync(join(tmpdir(), 'realm-outside-'))
  const rOutside = reg.addRealm(outside)
  check(!rOutside.ok && /blocked/.test(rOutside.ok ? '' : rOutside.reason), 'outside-home dir REFUSED (blocked)')
  const rHome = reg.addRealm(homedir())
  check(!rHome.ok, 'the home root itself refused')
  const rMissing = reg.addRealm(join(homeScratch, 'nope'))
  check(!rMissing.ok, 'non-existent folder refused')
  rmSync(outside, { recursive: true, force: true })

  const rA = reg.addRealm(realmA)
  check(rA.ok && rA.realm.name === 'projA' && rA.realm.dir === realmA, 'realm A trusted')
  const rB = reg.addRealm(realmB)
  check(rB.ok && rB.realm.name === 'projB', 'realm B trusted')
  const rDup = reg.addRealm(realmA)
  check(!rDup.ok && /already/.test(rDup.ok ? '' : rDup.reason), 'dedupe by resolved dir')
  const snap = reg.readRealmRegistry()
  check(snap.state === 'live' && snap.realms.length === 2, `registry live with 2 realms`)
  check(snap.ledger.length >= 2 && snap.ledger.some(l => /trusted/.test(l.note)), 'ledger records the trusts')

  const cmdA = reg.realmLaunchCommand(rA.ok ? rA.realm : (undefined as never))
  check(!cmdA.includes('MERCURY_CONFIG_DIR='), 'launch has NO env override (the account-pin mechanism is retired)')
  check(cmdA.startsWith(`cd `) && cmdA.includes(realmA.replace(homedir(), '~')), 'launch cd-s into the realm')
  const cmdB = reg.realmLaunchCommand(rB.ok ? rB.realm : (undefined as never))
  check(!cmdB.includes('MERCURY_CONFIG_DIR='), 'no realm ever derives a config-dir override')
  {
    const raw = JSON.parse(readFileSync(reg.realmRegistryPath(), 'utf8')) as { realms: Record<string, unknown>[] }
    raw.realms[1] = { ...raw.realms[1], accountId: 'account-b' }
    writeFileSync(reg.realmRegistryPath(), JSON.stringify(raw))
    const snapStale = reg.readRealmRegistry()
    check(snapStale.state === 'live' && snapStale.realms.length === 2, 'a stale accountId row still parses (ignored)')
    const cmdStale = reg.realmLaunchCommand(snapStale.realms.find(r => r.name === 'projB')!)
    check(!cmdStale.includes('MERCURY_CONFIG_DIR='), 'a stale accountId never resurrects the env override')
  }

  const issued = reg.recordRealmLaunchIssued('projB')
  check(issued.ok && issued.message === cmdB, 'issue returns the exact launch command')
  const snap2 = reg.readRealmRegistry()
  const bRow = snap2.realms.find(r => r.name === 'projB')!
  check(bRow.issuedCount === 1 && !!bRow.lastIssuedAt, 'issuedCount + lastIssuedAt stamped')
  check(snap2.ledger[0]!.note.startsWith('launch command issued'), `ledger says ISSUED, never 'ran' (${snap2.ledger[0]!.note})`)

  const rev = reg.revokeRealm('projA')
  check(rev.ok && /files stay on disk/.test(rev.ok ? rev.message : ''), 'revoke copy says files stay on disk')
  const snap3 = reg.readRealmRegistry()
  check(snap3.realms.length === 1 && existsSync(realmA), 'entry gone, folder SURVIVES on disk')
  check(snap3.ledger[0]!.note.includes('files stay on disk'), 'ledger records the revocation honestly')
  check(!reg.revokeRealm('projA').ok, 'double-revoke refused (no match)')

  mkdirSync(join(realmB, '.git'), { recursive: true })
  writeFileSync(join(realmB, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n')
  check(reg.realmGitBranch(realmB) === 'feature/x', 'branch parsed from .git/HEAD (no subprocess)')
  check(reg.realmGitBranch(realmA) === undefined, 'non-git dir ⇒ undefined (never fabricated)')

  writeFileSync(reg.realmRegistryPath(), '{ not json')
  const snapBad = reg.readRealmRegistry()
  check(snapBad.state === 'unavailable' && snapBad.realms.length === 0, 'corrupt file ⇒ unavailable (never a crash)')
  check(!reg.addRealm(realmA).ok, 'writes refuse while unreadable (no silent clobber of a corrupt registry)')

  check(reg.parseGitHubSource('https://github.com/o/r')?.name === 'r', 'https form parses')
  check(reg.parseGitHubSource('git@github.com:o/r.git')?.name === 'r', 'ssh form parses')
  check(reg.parseGitHubSource('o/r')?.url === 'https://github.com/o/r.git', 'shorthand canonicalizes')
  check(reg.parseGitHubSource('https://evil.com/o/r') === undefined, 'non-GitHub host refused')
  check(reg.parseGitHubSource('o/r; rm -rf /') === undefined, 'shell metacharacters refused')
} finally {
  if (prevEnv === undefined) delete process.env.MERCURY_CONFIG_DIR
  else process.env.MERCURY_CONFIG_DIR = prevEnv
  rmSync(configHome, { recursive: true, force: true })
  rmSync(homeScratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '✅ realm registry GREEN' : `❌ realm registry RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
