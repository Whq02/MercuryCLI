#!/usr/bin/env bun
// ============================================================================
//  scripts/permissions/prove-mode-alias.ts
//  PROOF: the bounded permission-mode spelling alias. The internal ids are Mercury's
//  own (strategy · implement · flow · sovereign); the compat
//  spellings (plan · acceptEdits · auto · bypassPermissions) exist on disk
//  (settings files, session records, teammate/agent records), in caller
//  muscle memory (--permission-mode acceptEdits, SDK options) and —
//  permanently — in the `.claude/` compatibility estate.
//
//  The law under proof (LANE M):
//    · ONE owner — RETIRED_PERMISSION_MODE_SPELLINGS +
//      decodePermissionModeSpelling in src/types/permissions.ts is the only
//      place a retired spelling may appear in src (boundedness scan, §7).
//    · Old-in → identical behaviour: every read boundary decodes a retired
//      spelling to its new id BEFORE validation, so an old settings file, a
//      resumed session, an SDK caller or an old agent file behaves exactly
//      as the new id (§2–§6).
//    · New-out: the vocabulary lists and every projection speak ONLY the new
//      ids (§1, §6).
//
//  Boundary coverage elsewhere (one proof home per seam):
//    · daemon env knob (MERCURY_DAEMON_PERMISSION_MODE=acceptEdits) —
//      scripts/daemon/prove-headless-permission-mode.ts
//    · agent-file frontmatter (permissionMode: acceptEdits) —
//      scripts/agent-definitions/prove-agent-codec.ts (the FULL fixture keeps the
//      retired spelling on purpose)
//    · extension agents drop privileged permissionMode entirely —
//      scripts/extensions/prove-trust-gate.ts
//
//  Run:  ~/.bun/bin/bun run scripts/permissions/prove-mode-alias.ts
// ============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const srcText = (...p: string[]): string => readFileSync(join(ROOT, 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Permission-mode bounded spelling alias — proof')
console.log('============================================================')

const RETIRED: Record<string, string> = {
  acceptEdits: 'implement',
  auto: 'flow',
  bypassPermissions: 'sovereign',
  plan: 'strategy',
}

// ── §1 the owner: the table + decode function ────────────────────────────────
section('§1 the ONE owner (types/permissions.ts): table exact, decode total')
const vocab = await import('../../src/types/permissions.js')
{
  const table = vocab.RETIRED_PERMISSION_MODE_SPELLINGS as Record<string, string>
  const keys = Object.keys(table).sort()
  check('table carries exactly the four retired spellings', JSON.stringify(keys) === JSON.stringify(['acceptEdits', 'auto', 'bypassPermissions', 'plan']), keys.join(','))
  for (const [old, now] of Object.entries(RETIRED)) {
    check(`'${old}' → '${now}'`, table[old] === now && vocab.decodePermissionModeSpelling(old) === now)
  }
  for (const id of vocab.PERMISSION_MODES) {
    check(`new id '${id}' passes through untouched`, vocab.decodePermissionModeSpelling(id) === id)
  }
  check('an unknown string passes through untouched (validation stays the caller’s)', vocab.decodePermissionModeSpelling('yolo') === 'yolo' && vocab.decodePermissionModeSpelling('') === '')
  // New-out: the vocabulary lists advertise ONLY new ids.
  const advertised = [...vocab.PERMISSION_MODES, ...vocab.EXTERNAL_PERMISSION_MODES, ...vocab.INTERNAL_PERMISSION_MODES]
  check('no retired spelling in any advertised mode list', advertised.every(m => !(m in RETIRED)))
  check('the external set is the five new external ids (alphabetical)', JSON.stringify(vocab.EXTERNAL_PERMISSION_MODES) === JSON.stringify(['default', 'dontAsk', 'implement', 'sovereign', 'strategy']))
  // apollo joined (the pre-flight interview station).
  check("the runtime set adds flow/autopilot/apollo (not bubble)", JSON.stringify(vocab.PERMISSION_MODES) === JSON.stringify(['default', 'dontAsk', 'implement', 'sovereign', 'strategy', 'flow', 'autopilot', 'apollo']))
}

// ── §2 permissionModeFromString — the string funnel ──────────────────────────
// (settings defaultMode reads, session-metadata resume, teams roster, CLI resolve)
section('§2 permissionModeFromString: old-in → new id; junk → default')
const pm = await import('../../src/utils/permissions/PermissionMode.js')
{
  for (const [old, now] of Object.entries(RETIRED)) {
    check(`fromString('${old}') === '${now}'`, pm.permissionModeFromString(old) === now)
  }
  for (const id of vocab.PERMISSION_MODES) {
    check(`fromString('${id}') round-trips`, pm.permissionModeFromString(id) === id)
  }
  check("fromString('bubble') → 'default' (type-union-only, not user-addressable)", pm.permissionModeFromString('bubble') === 'default')
  check("fromString(junk) → 'default'", pm.permissionModeFromString('yolo') === 'default')
}

// ── §3 the canonical zod schemas decode before validating ────────────────────
section('§3 permissionModeSchema / externalPermissionModeSchema: alias-decoded')
{
  const s = pm.permissionModeSchema()
  const e = pm.externalPermissionModeSchema()
  for (const [old, now] of Object.entries(RETIRED)) {
    check(`schema.parse('${old}') === '${now}'`, s.parse(old) === now)
    if (now === 'flow') {
      // 'auto' decodes to the INTERNAL-only 'flow', which the external enum
      // then rejects — decode never widens the external contract.
      check("externalSchema rejects retired 'auto' (decodes to internal-only 'flow')", !e.safeParse(old).success)
    } else {
      check(`externalSchema.parse('${old}') === '${now}'`, e.parse(old) === now)
    }
  }
  check("schema still rejects junk ('yolo')", !s.safeParse('yolo').success)
  check("runtime schema accepts internal 'flow'; external schema rejects it", s.safeParse('flow').success && !e.safeParse('flow').success)
}

// ── §4 PermissionUpdateSchema setMode — SDK/hook-supplied updates ────────────
section('§4 permissionUpdateSchema setMode: retired mode in an update decodes')
{
  const { permissionUpdateSchema } = await import('../../src/utils/permissions/PermissionUpdateSchema.js')
  const schema = permissionUpdateSchema()
  const oldUpdate = schema.safeParse({ type: 'setMode', mode: 'acceptEdits', destination: 'session' })
  check("setMode 'acceptEdits' parses — to 'implement'", oldUpdate.success && (oldUpdate.data as { mode?: string }).mode === 'implement', JSON.stringify(oldUpdate.success ? oldUpdate.data : oldUpdate.error?.issues?.[0]))
  const newUpdate = schema.safeParse({ type: 'setMode', mode: 'strategy', destination: 'session' })
  check("setMode 'strategy' parses unchanged", newUpdate.success && (newUpdate.data as { mode?: string }).mode === 'strategy')
  check("setMode junk still rejected", !schema.safeParse({ type: 'setMode', mode: 'yolo', destination: 'session' }).success)
  check("setMode internal-only 'flow' still rejected (external set only)", !schema.safeParse({ type: 'setMode', mode: 'flow', destination: 'session' }).success)
}

// ── §5 the SDK wire enum (coreSchemas.PermissionModeSchema) ──────────────────
section('§5 SDK PermissionModeSchema: an SDK caller pinned to old ids keeps working')
try {
  const core = await import('../../src/entrypoints/sdk/coreSchemas.js')
  const s = core.PermissionModeSchema()
  for (const [old, now] of Object.entries(RETIRED)) {
    if (now === 'flow') continue // flow is internal-only; 'auto' decodes to it and is then rejected by the EXTERNAL wire enum — asserted below
    check(`SDK schema.parse('${old}') === '${now}'`, s.parse(old) === now)
  }
  check("SDK schema: retired 'auto' decodes to internal-only 'flow' and is rejected by the external wire enum", !s.safeParse('auto').success)
  check("SDK schema keeps rejecting junk", !s.safeParse('yolo').success)
} catch (err) {
  // coreSchemas drags wider imports; under bun-run breakage fall back to the
  // structural pin: the shared wire enum decodes through the bounded alias.
  const core = srcText('entrypoints', 'sdk', 'coreSchemas.ts')
  check('STRUCTURAL: the SDK wire enum preprocesses through decodePermissionModeSpelling', /externalPermissionModeWireEnum[\s\S]{0,400}decodePermissionModeSpelling/.test(core), String(err).split('\n')[0])
}

// ── §6 the settings schema (permissions.defaultMode) ─────────────────────────
section('§6 settings PermissionsSchema: an OLD settings file parses — to the new id')
try {
  const st = await import('../../src/utils/settings/types.js')
  const schema = st.PermissionsSchema()
  const oldFile = schema.safeParse({ defaultMode: 'bypassPermissions' })
  check("defaultMode 'bypassPermissions' (old file / .claude compat) parses to 'sovereign'", oldFile.success && (oldFile.data as { defaultMode?: string }).defaultMode === 'sovereign')
  const flowFile = schema.safeParse({ defaultMode: 'auto' })
  check("defaultMode 'auto' parses to 'flow' (flow IS user-addressable in settings)", flowFile.success && (flowFile.data as { defaultMode?: string }).defaultMode === 'flow')
  const newFile = schema.safeParse({ defaultMode: 'implement' })
  check("defaultMode 'implement' parses unchanged", newFile.success && (newFile.data as { defaultMode?: string }).defaultMode === 'implement')
  check('junk defaultMode still fails validation', !schema.safeParse({ defaultMode: 'yolo' }).success)
} catch (err) {
  const st = srcText('utils', 'settings', 'types.ts')
  check('STRUCTURAL: settings defaultMode preprocesses through decodePermissionModeSpelling', /defaultMode:[\s\S]{0,300}decodePermissionModeSpelling/.test(st), String(err).split('\n')[0])
}

// ── §7 old-in → IDENTICAL behaviour (the semantic seams) ─────────────────────
section('§7 behaviour identity: a decoded old id behaves exactly as its new id')
{
  const decode = vocab.decodePermissionModeSpelling
  check("bypass semantics: decode('bypassPermissions') bypasses", pm.modeBypassesPermissions(decode('bypassPermissions') as never) === true)
  check("bypass semantics: decode('acceptEdits') does NOT bypass", pm.modeBypassesPermissions(decode('acceptEdits') as never) === false)
  check("external projection: decode('auto') projects to 'default' (flow is internal)", pm.toExternalPermissionMode(decode('auto') as never) === 'default')
  check("external projection: decode('plan') projects to 'strategy'", pm.toExternalPermissionMode(decode('plan') as never) === 'strategy')
  check("display: decode('acceptEdits') titles 'Implement Mode'", pm.permissionModeTitle(decode('acceptEdits') as never) === 'Implement Mode')
  check("display: decode('auto') titles 'Flow'", pm.permissionModeTitle(decode('auto') as never) === 'Flow')
  const { getNextPermissionMode } = await import('../../src/utils/permissions/getNextPermissionMode.js')
  const ctx = (mode: string) => ({ mode, isBypassPermissionsModeAvailable: false, isAutoModeAvailable: false }) as never
  check("carousel: decode('plan') cycles exactly as 'strategy'", getNextPermissionMode(ctx(decode('plan'))) === getNextPermissionMode(ctx('strategy')))
  check("carousel: decode('acceptEdits') cycles exactly as 'implement'", getNextPermissionMode(ctx(decode('acceptEdits'))) === getNextPermissionMode(ctx('implement')))
}

// ── §8 boundedness: the retired spellings live in ONE src home ───────────────
section('§8 boundedness scan: quoted retired mode ids appear ONLY in the alias home')
{
  // Quoted-exact occurrences of the four retired spellings across src/
  // (identifier names like acceptEditsFastPath / isBypassPermissionsModeAvailable
  // are NOT mode ids and are exempt by construction — the scan is quote-exact).
  // 'plan'/'auto' are legitimately other vocabularies (git plan ops, ACP plan
  // docs, theme/tool_choice/counsel 'auto', …), so the boundedness law is
  // enforced on the two UNAMBIGUOUS spellings.
  const offenders: string[] = []
  const HOME = join('src', 'types', 'permissions.ts')
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) {
        walk(p)
        continue
      }
      if (!/\.(ts|tsx)$/.test(name) || /\.test\./.test(name)) continue
      const rel = p.slice(ROOT.length + 1)
      if (rel === HOME) continue
      const text = readFileSync(p, 'utf-8')
      if (/['"]acceptEdits['"]/.test(text) || /['"]bypassPermissions['"]/.test(text)) offenders.push(rel)
    }
  }
  walk(join(ROOT, 'src'))
  check('no quoted acceptEdits/bypassPermissions outside types/permissions.ts', offenders.length === 0, offenders.slice(0, 5).join(', '))
  // …and the home actually keys them (bare-key form).
  const home = srcText('types', 'permissions.ts')
  check('the home keys all four retired spellings', ['acceptEdits:', 'auto:', 'bypassPermissions:', 'plan:'].every(k => home.includes(k)))
}

// ── §9 the CLI argument boundary (structural — commander wiring) ─────────────
section('§9 CLI --permission-mode: decodes old spellings, advertises only new ids')
{
  const main = srcText('main.tsx')
  check('argParser routes through decodePermissionModeSpelling before validating', /--permission-mode <mode>[\s\S]{0,600}decodePermissionModeSpelling/.test(main))
  check('choices come from PERMISSION_MODES (new ids only in help)', /--permission-mode <mode>[\s\S]{0,400}\.choices\(PERMISSION_MODES\)/.test(main))
  const setup = srcText('utils', 'permissions', 'permissionSetup.ts')
  check('the CLI resolve + settings defaultMode funnel through permissionModeFromString', (setup.match(/permissionModeFromString\(/g) || []).length >= 2)
}

// ── §10 conversation recovery: a resumed OLD session adopts, never loses ─────
section('§10 conversation recovery: persisted per-message modes adopt the new id')
{
  // scrubPermissionMode decodes a retired spelling BEFORE the clear-if-unknown
  // arm — an old transcript resumes with the new id instead of losing its
  // mode. Structural pin (the module drags cwd/session deps under bun-run).
  const rec = srcText('utils', 'conversationRecovery.ts')
  check('scrubPermissionMode consults the bounded alias before clearing', /scrubPermissionMode[\s\S]{0,700}decodePermissionModeSpelling/.test(rec))
  check('the adopt arm rewrites to the decoded id (not undefined)', /permissionMode: decoded/.test(rec))
}

// ── §11 a RETIRED mode id (no alias row) degrades to the default with ONE notice
section('§11 a retired mode id (no alias row) degrades to the default with ONE notice, never a crash')
{
  // The two-seat coordination mode left the roster whole; its spelling has
  // no alias row (it was retired, not renamed), so every read boundary
  // treats it as an unknown string: the pure funnels answer the default, the
  // schema refuses without throwing, and the persisted-session arm clears
  // the mode with one screen-receipt row saying so.
  const retiredMode = 'scri' + 'be'
  check('the alias table carries no row for it', !(retiredMode in (vocab.RETIRED_PERMISSION_MODE_SPELLINGS as Record<string, string>)))
  check('decode passes it through untouched', vocab.decodePermissionModeSpelling(retiredMode) === retiredMode)
  check('it is in no vocabulary list', !([...vocab.PERMISSION_MODES, ...vocab.INTERNAL_PERMISSION_MODES] as readonly string[]).includes(retiredMode))
  check("fromString → 'default'", pm.permissionModeFromString(retiredMode) === 'default')
  check('the mode schema REJECTS it (safeParse, no throw)', pm.permissionModeSchema().safeParse(retiredMode).success === false)
  check('the external schema REJECTS it too (safeParse, no throw)', pm.externalPermissionModeSchema().safeParse(retiredMode).success === false)
  // The persisted-session arm (conversationRecovery.scrubPermissionMode) —
  // structural pins, the module drags cwd/session deps under bun-run (§10).
  const rec = srcText('utils', 'conversationRecovery.ts')
  check('an unknown persisted mode is CLEARED (the session resumes in its default mode)', /return \{ \.\.\.message, permissionMode: undefined \} as Message/.test(rec))
  check(
    '…and the operator hears it as ONE warning screen-receipt naming the spelling',
    /mintImmediateReceipt\(\s*`▲ the saved permission mode '\$\{mode\}' is not one this build knows — resuming in the default mode`,\s*'warning',?\s*\)/.test(rec),
  )
  check('…once per spelling (a latch, never a row per message)', /noticedPermissionModes\.has\(mode\)/.test(rec) && /noticedPermissionModes\.add\(mode\)/.test(rec))
  // The settings arm: the preprocess decodes, the enum refuses, and the
  // validation tip advertises the live modes only.
  const tips = srcText('utils', 'settings', 'validationTips.ts')
  check('the defaultMode validation tip names no retired mode', !tips.includes(`"${retiredMode}"`))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL MODE-ALIAS PROOFS PASS')
else console.log(`❌ ${failures} MODE-ALIAS PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
