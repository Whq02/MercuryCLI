#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-foreign-harness-inversion.ts — foreign-harness
//  detection by OUR-fingerprint inversion (own-naming lane).
//
//  THE LAW: the health check detects ANY harness that touched a Mercury home
//  — detection never depends on knowing the foreigner's name. The signature
//  table only upgrades a report with a friendly name.
//
//  Fixtures (the brief's four, plus discipline):
//    (a) our own home                       → clean
//    (b) a claude-code-shaped daemon log    → foreign, NAMED, roster rows
//        attributed to the same writer
//    (c) an ALIEN unrecognized harness log  → reported foreign-unrecognized
//        (the poison this pin kills: the enumerating grep stayed SILENT here)
//    (d) an old-Mercury home                → OURS (version variance ≠
//        foreign; roster rows read ours-stale, never foreign)
//    · an empty log / unparseable roster proves nothing (no report)
//    · patterns stay tight: model names ('gpt-5.3-codex') and claude.ai URLs
//      in OUR logs never name a foreign writer
//    · healthReport's isolation row rides the classifier — the enumerating
//      package-name grep is gone from it
//
//  Run:  ~/.bun/bin/bun run scripts/health/prove-foreign-harness-inversion.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.5.9' }

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  KNOWN_AGENT_CLIS,
  AGENT_CLI_SESSION_ENV_VARS,
  AGENT_CLI_TOKEN_FD_ENV_VARS,
  classifyHarnessHome,
  recognizeAgentCli,
} = await import('../../src/utils/knownAgentClis.js')

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.log(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const EXPECTED = '1.5.9'
const root = mkdtempSync(join(tmpdir(), 'ownname-foreign-'))
function makeHome(name: string): string {
  const home = join(root, name)
  mkdirSync(join(home, 'daemon'), { recursive: true })
  return home
}

try {
  // --- (a) our own home ------------------------------------------------------
  const ours = makeHome('ours')
  writeFileSync(
    join(ours, 'daemon', 'daemon.log'),
    `[mercury-daemon] engaged v${EXPECTED} pid 4242 dir /work at 2026-08-27T10:00:00.000Z\n[daemon] scheduler tick\n`,
  )
  writeFileSync(join(ours, 'daemon', 'roster.json'), JSON.stringify({ workers: { w1: { cliVersion: EXPECTED } } }))
  writeFileSync(
    join(ours, 'daemon', 'supervisor.json'),
    JSON.stringify({ pid: 4242, version: EXPECTED, origin: 'transient', startedAt: 1, dir: '/work', controlSock: '/tmp/hermes-daemon-0a1b2c.sock' }),
  )
  const reportA = await classifyHarnessHome(ours, { expectedVersion: EXPECTED })
  check('(a) our own home is clean', reportA.foreign.length === 0, JSON.stringify(reportA.foreign))
  check('(a) no stale note for current-build records', reportA.oursStale.length === 0)

  // --- (b) claude-code-shaped log = NAMED foreign ---------------------------
  const cc = makeHome('cc')
  writeFileSync(
    join(cc, 'daemon', 'daemon.log'),
    `Restarting dead daemon: /Users/op/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js\n`,
  )
  writeFileSync(join(cc, 'daemon', 'roster.json'), JSON.stringify({ workers: { w1: { cliVersion: '2.0.13' } } }))
  const reportB = await classifyHarnessHome(cc, { expectedVersion: EXPECTED })
  const bLog = reportB.foreign.find(a => a.artifactClass === 'daemon-log')
  check('(b) the claude-code log reports foreign', bLog !== undefined)
  check('(b) the writer is NAMED from the table', bLog?.tool?.id === 'claude-code', JSON.stringify(bLog))
  check('(b) the evidence carries the line', (bLog?.evidence ?? '').includes('@anthropic-ai/claude-code'))
  const bRoster = reportB.foreign.find(a => a.artifactClass === 'daemon-roster')
  check('(b) alien roster rows attribute to the same writer', bRoster?.tool?.id === 'claude-code', JSON.stringify(bRoster))

  // --- (c) ALIEN unrecognized harness — the poison was silence --------------
  const alien = makeHome('alien')
  writeFileSync(join(alien, 'daemon', 'daemon.log'), `frobnicator-agentd 3.1 listening on :9750\nsession sweep ok\n`)
  const reportC = await classifyHarnessHome(alien, { expectedVersion: EXPECTED })
  check('(c) an unrecognized harness log is REPORTED', reportC.foreign.length === 1, JSON.stringify(reportC.artifacts))
  check('(c) it carries no table name', reportC.foreign[0]?.tool === undefined)
  check(
    '(c) the evidence says unrecognized and quotes the line',
    (reportC.foreign[0]?.evidence ?? '').includes('unrecognized') &&
      (reportC.foreign[0]?.evidence ?? '').includes('frobnicator-agentd'),
    reportC.foreign[0]?.evidence,
  )

  // --- (d) old-Mercury home = OURS ------------------------------------------
  const old = makeHome('old')
  writeFileSync(
    join(old, 'daemon', 'daemon.log'),
    `2026-05-01T00:00:00.000Z [INFO] [daemon] mercury scheduler engaged (build 1.2.0)\n`,
  )
  writeFileSync(join(old, 'daemon', 'roster.json'), JSON.stringify({ workers: { w1: { cliVersion: '1.2.0' } } }))
  writeFileSync(
    join(old, 'daemon', 'supervisor.json'),
    JSON.stringify({ pid: 7, version: '1.2.0', origin: 'transient', startedAt: 1, dir: '/w', controlSock: '/tmp/hermes-daemon-9f8e7d.sock' }),
  )
  const reportD = await classifyHarnessHome(old, { expectedVersion: EXPECTED })
  check('(d) an old-Mercury home is NOT foreign', reportD.foreign.length === 0, JSON.stringify(reportD.foreign))
  const dStale = reportD.oursStale.find(a => a.artifactClass === 'daemon-roster')
  check('(d) old roster rows read ours-stale (version variance, not foreignness)', dStale !== undefined && dStale.evidence.includes('version variance'), JSON.stringify(reportD.artifacts))

  // --- (d2) a PRE-STAMP build's log in a home whose PATH spells no 'mercury'
  // — the fielded reality (this scratch home included): those builds wrote
  // only `[daemon] …` stderr sentences, and the product token reached the
  // log only through the home path in the first line. The legacy grammar arm
  // keeps such an artifact OURS; without it, the inversion reported our own
  // log as an unrecognized foreign writer.
  const preStamp = makeHome('pre-stamp')
  writeFileSync(
    join(preStamp, 'daemon', 'daemon.log'),
    `[daemon] starting autonomous scheduler for ${preStamp} (loop-stop after 3 empty fires; per-run cap 30m; circuit-breaker trips at 3 consecutive failures, 60s cooldown; handoff-summary off; artifacts off; Ctrl-C to stop)\n[daemon] control socket up — RPC: list/has/status/dispatch/reply/kill/shutdown\n`,
  )
  const reportD2 = await classifyHarnessHome(preStamp, { expectedVersion: EXPECTED })
  check(
    "(d2) a pre-stamp build's log in a mercury-less home path stays OURS (the legacy grammar arm)",
    reportD2.foreign.length === 0 && reportD2.artifacts.some(a => a.artifactClass === 'daemon-log' && a.verdict === 'ours'),
    JSON.stringify(reportD2.artifacts),
  )

  // --- evidence-free artifacts prove nothing --------------------------------
  const empty = makeHome('empty')
  writeFileSync(join(empty, 'daemon', 'daemon.log'), '')
  writeFileSync(join(empty, 'daemon', 'roster.json'), '{"workers": tru')
  const reportE = await classifyHarnessHome(empty, { expectedVersion: EXPECTED })
  check('an empty log and an unparseable roster produce no report', reportE.artifacts.length === 0, JSON.stringify(reportE.artifacts))

  // --- pattern tightness -----------------------------------------------------
  check('a model name never names a foreign writer', recognizeAgentCli('router picked gpt-5.3-codex for the turn') === null)
  check('a claude.ai URL never names a foreign writer', recognizeAgentCli('open https://claude.ai/oauth to sign in') === null)
  check('the codex package path names Codex CLI', recognizeAgentCli('spawn /x/node_modules/@openai/codex/bin.js')?.id === 'codex-cli')

  // --- the signature table carries the interop spellings, one row per tool --
  const ccRow = KNOWN_AGENT_CLIS.find(tool => tool.id === 'claude-code')
  check(
    'the table row owns the jetbrains plugin dir spelling',
    ccRow?.jetbrainsPluginDir === 'claude-code-jetbrains-plugin',
  )
  check(
    'the table row owns the session env spellings',
    JSON.stringify(ccRow?.sessionEnvVars) ===
      JSON.stringify(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SUBSCRIPTION_TYPE', 'CLAUDE_CODE_RATE_LIMIT_TIER']) &&
      ccRow?.tokenFdEnvVar === 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  )
  const codexRow = KNOWN_AGENT_CLIS.find(tool => tool.id === 'codex-cli')
  check(
    'the codex row carries its verified session spellings (official env-var reference, 2026-08-29)',
    JSON.stringify(codexRow?.sessionEnvVars) === JSON.stringify(['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']),
  )
  const geminiRow = KNOWN_AGENT_CLIS.find(tool => tool.id === 'gemini-cli')
  check(
    'the gemini row is the honest empty row (no tool-namespaced session env is documented)',
    geminiRow !== undefined && geminiRow.sessionEnvVars === undefined && geminiRow.tokenFdEnvVar === undefined,
  )

  // --- the interop sites cite the table, never standalone literals ----------
  // The dead named-constant spelling is COMPOSED so this prover never carries
  // it as a bare literal (the zero-spelling ratchet greps src+scripts whole).
  const deadNamedConstant = ['CLAUDE_CODE', 'SIGNATURE'].join('_')
  const jetbrainsSource = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'jetbrains.ts'), 'utf8')
  check(
    'jetbrains probes the table row by id lookup (named constant + standalone literal dead)',
    jetbrainsSource.includes("tool.id === 'claude-code'") &&
      jetbrainsSource.includes('.jetbrainsPluginDir') &&
      !jetbrainsSource.includes(deadNamedConstant) &&
      !jetbrainsSource.includes("'claude-code-jetbrains-plugin'"),
  )
  // --- the scrub lists derive from the WHOLE table, by construction ---------
  // A table row whose sessionEnvVars miss the derived strip list = RED: a new
  // tool must be scrubbed by joining the table, never by editing a list.
  const { ALWAYS_STRIP_TOKEN_VARS } = await import('../../src/utils/subprocessEnv.js')
  check(
    'every row session spelling is in the child-env strip list (derived surface)',
    KNOWN_AGENT_CLIS.every(tool =>
      (tool.sessionEnvVars ?? []).every(v => (ALWAYS_STRIP_TOKEN_VARS as readonly string[]).includes(v)),
    ) && AGENT_CLI_SESSION_ENV_VARS.every(v => (ALWAYS_STRIP_TOKEN_VARS as readonly string[]).includes(v)),
  )
  check(
    'every row token-descriptor spelling reaches the daemon scrub surface',
    KNOWN_AGENT_CLIS.every(
      tool => tool.tokenFdEnvVar === undefined || AGENT_CLI_TOKEN_FD_ENV_VARS.includes(tool.tokenFdEnvVar),
    ),
  )
  const subprocessSource = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'subprocessEnv.ts'), 'utf8')
  check(
    'the CI list rides the same derived surface, and no per-tool literal survives there',
    subprocessSource.includes('...AGENT_CLI_SESSION_ENV_VARS') &&
      !subprocessSource.includes("'CLAUDE_CODE_OAUTH_TOKEN'"),
  )
  // Re-cut at FN-013 AUTH-07 (the neutrality ruling): the CI
  // scrub's provider keys are DERIVED from the route-law family table
  // (credentialEnvSpellings.ALL_PROVIDER_CREDENTIAL_ENV_VARS) — the
  // hand-kept four-literal list named four spellings while the router
  // resolved eleven. Same law, stronger surface: the four historical
  // spellings must sit in the derived set, the scrub must spread that set,
  // and the hand-kept literals are POISON in subprocessEnv.ts — a
  // per-provider literal returning there is the omission class reborn.
  const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.js')
  check(
    'provider API keys sit in the CI scrub symmetrically (no provider special-cased by omission)',
    ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'].every(v =>
      (ALL_PROVIDER_CREDENTIAL_ENV_VARS as readonly string[]).includes(v),
    ) &&
      subprocessSource.includes('...ALL_PROVIDER_CREDENTIAL_ENV_VARS') &&
      ["'ANTHROPIC_API_KEY'", "'OPENAI_API_KEY'", "'GEMINI_API_KEY'", "'GOOGLE_API_KEY'"].every(
        needle => !subprocessSource.includes(needle),
      ),
  )
  // Re-cut: the strip set hoisted to the ONE home
  // (subprocessEnv.STORED_TOKEN_SCRUB_VARS, shared by both daemon spawn
  // doors) — the law is unchanged: the token-descriptor scrub rides the
  // table-derived surface, now through the hoisted set.
  const ownedDaemonSource = readFileSync(join(import.meta.dir, '..', '..', 'src', 'daemon', 'ownedDaemon.ts'), 'utf8')
  const subprocessEnvSource = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'subprocessEnv.ts'), 'utf8')
  check(
    'the daemon token-descriptor scrub rides the derived surface (through the one-home set)',
    ownedDaemonSource.includes('STORED_TOKEN_SCRUB_VARS') &&
      /export const STORED_TOKEN_SCRUB_VARS[\s\S]{0,240}\.\.\.AGENT_CLI_TOKEN_FD_ENV_VARS/.test(subprocessEnvSource),
  )

  // --- healthReport rides the classifier, not an enumerating grep ------------
  const healthSource = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'healthReport.ts'), 'utf8')
  check('healthReport cites classifyHarnessHome', healthSource.includes('classifyHarnessHome'))
  check(
    'the enumerating package-name grep is gone from healthReport',
    !healthSource.includes('@anthropic-ai/claude-code'),
  )

  // --- the daemon stamps the fingerprint the classifier reads ----------------
  const daemonSource = readFileSync(join(import.meta.dir, '..', '..', 'src', 'daemon', 'main.ts'), 'utf8')
  check('daemonRun writes the unconditional [mercury-daemon] engage stamp', daemonSource.includes('[mercury-daemon] engaged v'))

  // --- verdict byte-stability: renames move no evidence byte -----------------
  check(
    'the named-foreign evidence line is byte-stable',
    bLog?.evidence ===
      'daemon/daemon.log: Claude Code daemon lines served this home — "Restarting dead daemon: /Users/op/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js"',
    bLog?.evidence,
  )
  check(
    'the unrecognized-foreign evidence line is byte-stable',
    reportC.foreign[0]?.evidence ===
      `daemon/daemon.log: an unrecognized tool's daemon served this home — no Mercury fingerprint in 2 line(s); first: "frobnicator-agentd 3.1 listening on :9750"`,
    reportC.foreign[0]?.evidence,
  )

  // --- the retired vocabulary stays retired (grepped-back, composed) ---------
  // No src or scripts constant names a single competitor as a signature, and
  // the ancestor sentence class stays dead — swept over BOTH trees, because
  // the vocabulary seal's md-only laws cannot see a TS docblock (that is how
  // the phrase survived until the operator's eye caught it).
  const deadAncestorPhrase = ['upstream', 'ancestor'].join(' ')
  const offenders: string[] = []
  for (const sweepRoot of ['src', 'scripts'].map(dir => join(import.meta.dir, '..', '..', dir))) {
    for (const rel of readdirSync(sweepRoot, { recursive: true }) as string[]) {
      const path = join(sweepRoot, String(rel))
      let text: string
      try {
        text = readFileSync(path, 'utf8') // a directory throws → skipped
      } catch {
        continue
      }
      if (text.includes(deadNamedConstant) || text.toLowerCase().includes(deadAncestorPhrase)) offenders.push(path)
    }
  }
  check(
    'the named-competitor signature spelling and the ancestor phrase are DEAD across src+scripts',
    offenders.length === 0,
    offenders.join(', '),
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`prove-foreign-harness-inversion: ${failures} RED`)
  process.exit(1)
}
console.log('prove-foreign-harness-inversion: all pins green')
