#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ctm-r04-config-'))
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_MOCK_LIMITS
delete process.env.MERCURY_CAP_FAILOVER

const { decideCapAction, decideCapReturn, resolveCapPosture, deriveCapFailoverCandidates, CAP_FAILOVER_FAMILY_ORDER } = await import(
  '../../src/services/capFailover.ts'
)
const mock = await import('../../src/services/mockRateLimits.ts')
const { getFlagSpec } = await import('../../src/substrate/flagRegistry.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('§A the posture matrix — the default OFFERS; explicit off stays TOTAL')
{
  check("unset flag resolves 'offer' (the offer is reachable without pre-arming)", resolveCapPosture() === 'offer')
  process.env.MERCURY_CAP_FAILOVER = 'off'
  check("explicit 'off' selects the fully-inert posture", resolveCapPosture() === 'off')
  delete process.env.MERCURY_CAP_FAILOVER
  for (const q of ['allowed', 'allowed_warning', 'rejected'] as const) {
    check(`off × ${q} ⇒ none (never switches, never offers)`, decideCapAction('off', q).kind === 'none')
  }
  check('offer × allowed ⇒ none', decideCapAction('offer', 'allowed').kind === 'none')
  const warn = decideCapAction('offer', 'allowed_warning')
  check('offer × warning ⇒ preemptive OFFER', warn.kind === 'offer' && warn.kind === 'offer' && warn.trigger === 'warning')
  const rej = decideCapAction('offer', 'rejected')
  check('offer × rejected ⇒ OFFER (never silent)', rej.kind === 'offer' && rej.trigger === 'rejected')
  const autoWarn = decideCapAction('auto', 'allowed_warning')
  check('auto × warning ⇒ still a VISIBLE offer (never silent preemption)', autoWarn.kind === 'offer')
  const autoRej = decideCapAction('auto', 'rejected')
  check('auto × rejected ⇒ unattended handoff', autoRej.kind === 'auto-handoff' && autoRej.trigger === 'rejected')
  process.env.MERCURY_CAP_FAILOVER = 'auto'
  check("the registered flag arms the posture ('auto')", resolveCapPosture() === 'auto')
  process.env.MERCURY_CAP_FAILOVER = 'bogus'
  check("an unknown value degrades to 'offer' (asks — never a surprise unattended switch)", resolveCapPosture() === 'offer')
  delete process.env.MERCURY_CAP_FAILOVER
}

section('§B posture-symmetric return — home only on a TRUE reset')
{
  check('not on the failover lane ⇒ none', decideCapReturn('auto', 'allowed', false).kind === 'none')
  check('off never moved ⇒ nothing to return', decideCapReturn('off', 'allowed', true).kind === 'none')
  check('home still warning ⇒ stay (no thrash)', decideCapReturn('offer', 'allowed_warning', true).kind === 'none')
  const offerHome = decideCapReturn('offer', 'allowed', true)
  check("offer ⇒ the way home is OFFERED (trigger 'reset')", offerHome.kind === 'offer' && offerHome.trigger === 'reset')
  const autoHome = decideCapReturn('auto', 'allowed', true)
  check('auto ⇒ unattended return at the boundary', autoHome.kind === 'auto-handoff' && autoHome.trigger === 'reset')
}

section('§C the seam — folded shut unarmed, LIVE armed (the r04b revival)')
{
  check('unarmed: shouldProcessMockLimits stays false (byte-identical fold)', mock.shouldProcessMockLimits() === false)
  mock.setMockRateLimitScenario('approaching-weekly-limit' as never)
  check('unarmed: the setter is inert (the folded return)', mock.shouldProcessMockLimits() === false)

  process.env.MERCURY_MOCK_LIMITS = '1'
  check('armed: the seam opens only AFTER a scenario arms it', mock.shouldProcessMockLimits() === false)
  mock.setMockRateLimitScenario('approaching-weekly-limit' as never)
  check('armed: the REAL setter runs — the gate goes live', mock.shouldProcessMockLimits() === true)
  const warnHeaders = mock.getMockHeaders()
  check(
    'the deterministic journey speaks real header vocabulary (warning leg)',
    warnHeaders !== null && JSON.stringify(warnHeaders).includes('anthropic-ratelimit-unified'),
  )
  mock.setMockRateLimitScenario('weekly-limit-reached' as never)
  const rejHeaders = mock.getMockHeaders()
  check(
    'the rejected leg drives status=rejected',
    rejHeaders?.['anthropic-ratelimit-unified-status'] === 'rejected',
    JSON.stringify(rejHeaders ?? {}),
  )
  mock.setMockRateLimitScenario('clear' as never)
  check('the reset leg clears (the way-home trigger)', mock.shouldProcessMockLimits() === false)
  delete process.env.MERCURY_MOCK_LIMITS
}

section('§D registry truth')
{
  const seam = getFlagSpec('MERCURY_MOCK_LIMITS')
  const posture = getFlagSpec('MERCURY_CAP_FAILOVER')
  check('MERCURY_MOCK_LIMITS registered at the seam', seam?.consumer === 'src/services/mockRateLimits.ts')
  check('MERCURY_CAP_FAILOVER registered at the decision core', posture?.consumer === 'src/services/capFailover.ts')
}

section('§E the full journey, both postures — warning → offer/auto → continue → reset → return')
{
  process.env.MERCURY_MOCK_LIMITS = '1'
  const limits = await import('../../src/services/claudeAiLimits.ts')
  const { capHandoffState, noteCapHandoff, noteCapReturn } = await import(
    '../../src/services/capFailover.ts'
  )
  const ingest = (scenario: string) => {
    if (scenario === 'warning-7d') {
      mock.setMockRateLimitScenario('clear' as never)
      mock.setMockEarlyWarning('7d', 0.92)
    } else {
      mock.setMockRateLimitScenario(scenario as never)
    }
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    limits.extractQuotaStatusFromHeaders(new globalThis.Headers())
    return limits.currentLimits
  }

  for (const posture of ['offer', 'auto'] as const) {
    noteCapReturn()
    const warn = ingest('warning-7d')
    check(`[${posture}] warning ingests as allowed_warning`, warn.status === 'allowed_warning')
    const a1 = decideCapAction(posture, warn.status as never)
    check(`[${posture}] warning ⇒ visible offer`, a1.kind === 'offer' && a1.trigger === 'warning')
    const rej = ingest('weekly-limit-reached')
    check(`[${posture}] cap ingests as rejected with a reset time`, rej.status === 'rejected' && typeof rej.resetsAt === 'number')
    const a2 = decideCapAction(posture, rej.status as never)
    check(
      `[${posture}] cap ⇒ ${posture === 'auto' ? 'unattended handoff' : 'offer, never silent'}`,
      posture === 'auto' ? a2.kind === 'auto-handoff' : a2.kind === 'offer',
    )
    noteCapHandoff('claude-fable-5')
    check(`[${posture}] the handoff note carries the way home`, capHandoffState()?.homeModel === 'claude-fable-5')
    const stay = decideCapReturn(posture, rej.status as never, true)
    check(`[${posture}] home still capped ⇒ stay on the lane`, stay.kind === 'none')
    const reset = ingest('clear')
    check(`[${posture}] reset clears to allowed`, reset.status === 'allowed')
    const back = decideCapReturn(posture, reset.status as never, true)
    check(
      `[${posture}] reset ⇒ posture-symmetric return (trigger 'reset')`,
      posture === 'auto'
        ? back.kind === 'auto-handoff' && back.trigger === 'reset'
        : back.kind === 'offer' && back.trigger === 'reset',
    )
    noteCapReturn()
    check(`[${posture}] the way home clears the note`, capHandoffState() === null)
  }

  const rejOff = ingest('weekly-limit-reached')
  check('[off] the same capped truth decides none', decideCapAction('off', rejOff.status as never).kind === 'none')
  ingest('clear')
  delete process.env.MERCURY_MOCK_LIMITS
}

section('§F the arm surfaces — boot-menu posture row + the command opening')
{
  const { STARTUP_MENU, menuRowChoices } = await import('../../src/substrate/startupMenu.ts')
  const row = STARTUP_MENU.find(r => r.env === 'MERCURY_CAP_FAILOVER')
  check('the boot menu carries the cap posture row', row !== undefined)
  check("the row's default is offer (the reachable ask — nothing moves without the keypress)", row?.defaultLabel === 'offer')
  check(
    'the row cycles default(offer) → off → auto',
    JSON.stringify(menuRowChoices(row!).map(c => c.value)) === JSON.stringify([null, 'off', 'auto']),
  )
  const cmd = (await import('../../src/commands/mock-limits/index.ts')).default
  check('the /mock-limits opening exists behind the registered arm', cmd.name === 'mock-limits')
  delete process.env.MERCURY_MOCK_LIMITS
  check('unarmed builds carry no /mock-limits command', cmd.isEnabled() === false)
  process.env.MERCURY_MOCK_LIMITS = '1'
  check('the registered arm exposes it', cmd.isEnabled() === true)
  delete process.env.MERCURY_MOCK_LIMITS
}

section('§G the widened candidate law — the whole readiness-checked catalogue, fence intact')
{
  const lane = (usable: boolean, blockers: string[] = []) => ({ usable, blockers })
  const map: Record<string, { usable: boolean; blockers: string[] }> = {
    anthropic: lane(true),
    openai: lane(true),
    zai: lane(true),
    moonshot: lane(false, ['no Kimi sign-in or Moonshot API key — /logins moonshot (or MOONSHOT_API_KEY)']),
    deepseek: lane(true),
    'openai-compat': lane(false, ['no endpoint configured — MERCURY_COMPAT_BASE_URL']),
    openrouter: lane(false, ['no OpenRouter credential — /logins (or OPENROUTER_API_KEY)']),
    gemini: lane(true),
    huggingface: lane(false, ['no Hugging Face credential — /logins (or HF_TOKEN)']),
    local: lane(true),
  }
  const targets: Record<string, string | undefined> = {
    openai: 'gpt-5.6-sol',
    zai: 'glm-4.7',
    deepseek: 'deepseek-chat-v3.4',
    local: 'local/llama-3.3-70b',
    gemini: undefined,
  }
  const set = deriveCapFailoverCandidates(map, route => targets[route])
  check(
    'anthropic is NEVER a candidate (the home lane, even when usable)',
    !set.candidates.some(c => (c.route as string) === 'anthropic') && !(CAP_FAILOVER_FAMILY_ORDER as readonly string[]).includes('anthropic'),
  )
  check(
    'only readiness-checked lanes with a target fact enter, OpenAI FIRST',
    JSON.stringify(set.candidates) ===
      JSON.stringify([
        { route: 'openai', model: 'gpt-5.6-sol' },
        { route: 'zai', model: 'glm-4.7' },
        { route: 'deepseek', model: 'deepseek-chat-v3.4' },
        { route: 'local', model: 'local/llama-3.3-70b' },
      ]),
    JSON.stringify(set.candidates),
  )
  const gemini = set.excluded.find(e => e.route === 'gemini')
  check(
    'a usable lane with NO recorded target fact is excluded with the typed why (never a guessed id)',
    gemini !== undefined && gemini.why.includes('no recorded target model fact'),
    JSON.stringify(gemini),
  )
  const moonshot = set.excluded.find(e => e.route === 'moonshot')
  check(
    "an unusable lane is excluded carrying its OWN blockers verbatim",
    moonshot !== undefined && moonshot.why.includes('/logins moonshot'),
    JSON.stringify(moonshot),
  )
  check(
    'every non-candidate family is a TYPED exclusion (the set partitions the catalogue)',
    set.candidates.length + set.excluded.length === CAP_FAILOVER_FAMILY_ORDER.length,
    `${set.candidates.length}+${set.excluded.length} vs ${CAP_FAILOVER_FAMILY_ORDER.length}`,
  )
  const noOpenai = deriveCapFailoverCandidates({ ...map, openai: lane(false, ['no OpenAI account — /logins']) }, route => targets[route])
  check(
    'openai signed out ⇒ the next readiness-checked family leads (zai here)',
    JSON.stringify(noOpenai.candidates[0]) === JSON.stringify({ route: 'zai', model: 'glm-4.7' }),
    JSON.stringify(noOpenai.candidates[0]),
  )
  const none = deriveCapFailoverCandidates(
    Object.fromEntries(Object.keys(map).map(k => [k, lane(false, ['signed out'])])),
    () => undefined,
  )
  check('no usable lane ⇒ the empty candidate set (surfaces stay quiet)', none.candidates.length === 0)
  check('posture off never consumes a candidate (off × rejected ⇒ none)', decideCapAction('off', 'rejected').kind === 'none')
}

console.log(failures === 0 ? '\n ✅ SUBSTRATE — posture core + the revived journey seam + the widened candidate law' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
