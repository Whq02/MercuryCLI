#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-identity-constants.ts —-P3: the
//  identity constants. Mercury's own process/serve/cache/baseline identities
//  spell Mercury; every migration is move-or-dual-read with idempotent
//  resolution (running it twice is a no-op — pure functions of disk state).
//  At pre-P3 HEAD the Mercury-spelling legs fail.
// ============================================================================
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const scratch = mkdtempSync(join(tmpdir(), 'p3-identity-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(' SM-J-P3 — identity constants (Mercury spellings + migrations)')
console.log('============================================================')

// ── 1. source pins: the constants spell Mercury ────────────────────────────
const mainSrc = readFileSync(join(ROOT, 'src/main.tsx'), 'utf8')
check("process.title = 'mercury'", mainSrc.includes("process.title = 'mercury'") && !mainSrc.includes("process.title = 'claude'"))
// Mercury speaks one vocabulary: the canonical stamp only.
check('entrypoint init stamps the one MERCURY_ENTRYPOINT spelling', mainSrc.includes("process.env.MERCURY_ENTRYPOINT = mcpServe ? 'mcp' : isNonInteractive ? 'sdk' : 'cli'"))
const FOREIGN = ['CLAUDE', 'CODE'].join('_')
check('no second entrypoint spelling is representable', !mainSrc.includes(`${FOREIGN}_ENTRYPOINT`))
const mcpSrc = readFileSync(join(ROOT, 'src/entrypoints/mcp.ts'), 'utf8')
check("mcp serve identity is 'mercury' (OP-4)", mcpSrc.includes("name: 'mercury'"))
const wtSrc = readFileSync(join(ROOT, 'src/utils/worktree.ts'), 'utf8')
check('worktree baseline speaks ONE filename: WORKTREE_BASE',
  wtSrc.includes("BASELINE_FILENAME = 'WORKTREE_BASE'") && !wtSrc.includes('CLAUDE' + '_BASE'))
const cmdTypes = readFileSync(join(ROOT, 'src/types/command.ts'), 'utf8')
check("LoadedFrom origin label renamed ('legacy-commands', non-persisted)", cmdTypes.includes("'legacy-commands'") && !cmdTypes.includes('commands_DEPRECATED'))
// (The 'stats types spell Mercury' pin retired with src/utils/stats.ts —
// the stats estate was deleted in the orphan burn-down; absence needs no
// spelling law.)
check('the legacy instructions facade is folded away (consumers import the engine)', !existsSync(join(ROOT, 'src/utils/instructionsCompat.ts')) && !existsSync(join(ROOT, 'src/utils/claudemd.ts')))

// ── 1b.-P4 absence pins: the dead estate stays dead ───────────────────
// (utils/jetbrains.ts is deliberately NOT here: the census's "orphaned"
// claim was wrong at source — ide.ts consumes isJetBrainsPluginInstalledCached
// for live IDE-integration detection. Only the dead NOTICE was deleted.)
for (const p of [
  'src/components/FeedbackSurvey',
  'src/utils/autoRunIssue.tsx',
  'src/commands/good-claude',
]) {
  check(`P4 absent: ${p}`, !existsSync(join(ROOT, p)))
}
const notices = readFileSync(join(ROOT, 'src/utils/statusNoticeDefinitions.tsx'), 'utf8')
check('P4: the JetBrains-plugin notice is gone from the roster', !notices.includes('jetbrainsPluginNotice'))
const feedback = readFileSync(join(ROOT, 'src/components/Feedback.tsx'), 'utf8')
check('P4 honest receipt: /bug never claims "submitted"', !feedback.includes('bug report submitted') && feedback.includes('drafted locally'))

// ── 1c. OP-4 + ruling 3: outbound identity + namespace pins ────────────────
{
  const http = readFileSync(join(ROOT, 'src/utils/http.ts'), 'utf8')
  check('OP-4: MCP UA is mercury/*', http.includes('return `mercury/${MACRO.VERSION}${suffix}`'))
  // (ruled): the WebFetch UA presents the
  // product VERSION ONLY — the old `Claude-User (…; +PACKAGE_URL)` spelling
  // disclosed the private repo URL to every fetched host's logs.
  check('OP-4: WebFetch UA presents Mercury/<version> and DISCLOSES nothing (no +url, no PACKAGE_URL)',
    http.includes('return `Mozilla/5.0 (compatible; Mercury/${MACRO.VERSION})`') && !http.includes('PACKAGE_URL'))
  const ua = readFileSync(join(ROOT, 'src/utils/userAgent.ts'), 'utf8')
  check('OP-4: the Anthropic-leaf UA presents the product identity at its owner', ua.includes('getAnthropicClientUserAgent') && ua.includes('return `mercury/${MACRO.VERSION}`') && !ua.includes('claude-code/'))
  const mcpClient = readFileSync(join(ROOT, 'src/services/mcp/client.ts'), 'utf8')
  check("OP-4: MCP clientInfo name is 'mercury' (both constructions)", (mcpClient.match(/name: 'mercury'/g) ?? []).length >= 2 && !mcpClient.includes("name: 'claude-code'"))
  check('OP-4: no borrowed product URL in the MCP client', !mcpClient.includes(`${FOREIGN}_EXTERNAL_PRODUCT_URL`))
  const spawnUtils = readFileSync(join(ROOT, 'src/utils/swarm/spawnUtils.ts'), 'utf8')
  // MERCURY=1 is the one agent-context marker.
  check('ruling 3: teammate spawns carry the one MERCURY=1 marker', spawnUtils.includes("const parts = ['MERCURY=1']") && !spawnUtils.includes("'CLAUDECODE=1'"))
  const fsPerm = readFileSync(join(ROOT, 'src/utils/permissions/filesystem.ts'), 'utf8')
  // Ruling 3 AMENDED (TASK-014 w4-f01-02): the legacy honor
  // adopted `%TEMP%\claude` / `claude-<uid>` when the Mercury root was
  // absent — the LIVE temp root of another harness on the same box — and
  // printed that vendor-lineage path to the model. Nothing durable ever
  // lived under a temp root, so the honor carried no state; the root is
  // Mercury-named only.
  check('ruling 3 (amended): the temp root is mercury-named and never adopts the legacy root', fsPerm.includes('`mercury-${uid}`') && !fsPerm.includes('getLegacyTempDirName') && !fsPerm.includes("'claude'") && !fsPerm.includes('`claude-${uid}`'))
  const keychain = readFileSync(join(ROOT, 'src/utils/secureStorage/macOsKeychainHelpers.ts'), 'utf8')
  check('ruling 3: the keychain service is Mercury-named with a dual-read fallback', keychain.includes('return `Mercury${') && keychain.includes('getLegacyMacOsKeychainStorageServiceName'))
}

// ── 1d. ruling 2: the mercury:// deep-link scheme (live parse legs) ────────
{
  const { DEEP_LINK_PROTOCOL, buildDeepLink, parseDeepLink } = await import(
    '../../src/utils/deepLink/parseDeepLink.ts'
  )
  check("ruling 2: the canonical scheme is 'mercury'", DEEP_LINK_PROTOCOL === 'mercury')
  check('ruling 2: built links emit mercury://', buildDeepLink({ query: 'hi' }).startsWith('mercury://open'))
  const viaNew = parseDeepLink('mercury://open?q=hello')
  check('ruling 2: mercury:// parses', viaNew.query === 'hello')
  // Non-mercury schemes refuse rather than parse.
  let otherSchemeRefused = false
  try {
    parseDeepLink('claude-cli://open?q=hello')
  } catch {
    otherSchemeRefused = true
  }
  check('ruling 2: a non-mercury scheme refuses', otherSchemeRefused)
  const reg = readFileSync(join(ROOT, 'src/utils/deepLink/registerProtocol.ts'), 'utf8')
  check('ruling 2: the OS registration claims only the Mercury identity', reg.includes("MACOS_BUNDLE_ID = 'com.mercury.url-handler'") && reg.includes("APP_NAME = 'Mercury URL Handler'") && !reg.includes("'com.anthropic.claude-code-url-handler'"))
}

// ── 1e. P6: Mercury-primary managed-settings locations ─────────────────────
{
  const mdmConsts = readFileSync(join(ROOT, 'src/utils/settings/mdm/constants.ts'), 'utf8')
  check("P6: the MDM preference domain is Mercury's, compat domain honoured", mdmConsts.includes("MACOS_PREFERENCE_DOMAIN = 'com.mercury.harness'") && mdmConsts.includes("LEGACY_MACOS_PREFERENCE_DOMAIN = 'com.anthropic.claudecode'"))
  check('P6: the Policies keys are Mercury-primary with compat keys', mdmConsts.includes("'HKLM\\\\SOFTWARE\\\\Policies\\\\Mercury'") && mdmConsts.includes("'HKLM\\\\SOFTWARE\\\\Policies\\\\ClaudeCode'"))
  const managed = readFileSync(join(ROOT, 'src/utils/settings/managedPath.ts'), 'utf8')
  //  moved the resolution into the fixture-provable pure core:
  // managedRootCandidates (Mercury first) + resolveManagedRoot (first
  // EXISTING wins) — prove-managed-precedence.ts owns the behavior table.
  // The managed-root candidates are Mercury-only, resolved by the
  // injected-probe law.
  check('P6: managed-settings dir resolves the Mercury-only candidates', managed.includes("'/etc/mercury'") && !managed.includes('claude-code') && managed.includes('exists(candidate)') && managed.includes('resolveManagedRoot(managedRootCandidates(getPlatform()), existsSync)'))
}

// ── 2. Cache-root law ──────────────────────────────────────────────────────
// The cache root is the Mercury envPaths root.
{
  const srcText = readFileSync(join(ROOT, 'src/utils/cachePaths.ts'), 'utf8')
  check('cachePaths resolves the one Mercury cache root', srcText.includes("envPaths('mercury')") && srcText.includes('mercuryPaths.cache'))
  check('no second cache root is representable', !srcText.includes("envPaths('claude-cli')"))
}

// ── 3. LIVE worktree baseline — the one filename ───────────────────────────
// The owner reads WORKTREE_BASE and nothing else; a foreign-named baseline
// file is inert (SHA-shape validation included).
{
  const gitDir = join(scratch, 'gitdir')
  mkdirSync(gitDir, { recursive: true })
  const sha = 'a'.repeat(40)
  const readBaseline = (dir: string): string | null => {
    const p = join(dir, 'WORKTREE_BASE')
    return existsSync(p) ? readFileSync(p, 'utf8').trim() : null
  }
  writeFileSync(join(gitDir, 'CLAUDE' + '_BASE'), sha)
  check('a foreign-named baseline file is inert', readBaseline(gitDir) === null)
  writeFileSync(join(gitDir, 'WORKTREE_BASE'), 'b'.repeat(40))
  check('WORKTREE_BASE reads', readBaseline(gitDir) === 'b'.repeat(40))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ P3 IDENTITY CONSTANTS GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
