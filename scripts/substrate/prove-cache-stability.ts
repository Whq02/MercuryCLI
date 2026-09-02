// prove-cache-stability — guards the "Don't Break the Cache" prompt-prefix
// invariants.
//
// getSystemPrompt (src/constants/prompts.ts) is meticulously cache-engineered: a
// stable STATIC prefix + exactly ONE known-volatile uncached section (MCP
// connect/disconnect between turns), and the fork additions (the identity floor,
// mode packs, anti-syc, identity reconcile) all compose as STATIC sections — so
// the cached system-prompt prefix is byte-identical turn-to-turn (no per-turn
// cache bust). The Issue-1 audit verified this is already at the 2026 cache-aware
// state of the art (TokenPilot arXiv:2606.17016 / "Don't Break the Cache"
// arXiv:2601.06007): the "hermes is slower per-turn because the substrate injects
// more context" framing was a MISDIAGNOSIS — the substrate adds ~0 per-turn on
// the main loop and nothing volatile to the cached prefix. This proof LOCKS the
// property so a future fork edit can't silently (a) add a volatile cached section
// — the classic every-turn cache-buster — or (b) re-sort the tool pool per turn.
import { readFileSync } from 'fs'
import { join } from 'path'

const root = join(import.meta.dir, '../..')
let fail = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : '  — ' + detail}`)
  if (!cond) fail = 1
}

const prompts = readFileSync(join(root, 'src/constants/prompts.ts'), 'utf8')
const toolPool = readFileSync(join(root, 'src/utils/toolPool.ts'), 'utf8')

console.log('── prompt-cache stability invariants (Don\'t Break the Cache) ──')

// 1. Exactly ONE uncached (volatile) system-prompt section. A NEW
//    DANGEROUS_uncached section is the single most-likely cache-stability
//    regression: anything volatile in the cached prefix re-prefills the whole
//    prompt every turn it varies.
const uncachedCalls = (
  prompts.match(/DANGEROUS_uncachedSystemPromptSection\(/g) || []
).length
check(
  'exactly 1 volatile (DANGEROUS_uncached) system-prompt section',
  uncachedCalls === 1,
  `found ${uncachedCalls}; a new volatile cached section busts the prefix cache every turn — move volatile content to a TAIL attachment (utils/attachments.ts), not the cached prefix`,
)

// 2. The static/dynamic cache-scope boundary marker is intact.
check(
  'SYSTEM_PROMPT_DYNAMIC_BOUNDARY marker present',
  prompts.includes('SYSTEM_PROMPT_DYNAMIC_BOUNDARY'),
  'the static/dynamic cache boundary marker was removed',
)

// 3. The Mercury contract block stays a STATIC section — composed after the
//    static prefix, never wrapped in a volatile uncached call (#1 == 1 already
//    proves no extra uncached section exists).
check(
  'Mercury contract composed as a static (cacheable) section',
  /getMercuryContractSections\(\)/.test(prompts),
  'the contract seam changed — keep it a static section so the identity/doctrine prefix is cache-read, not re-prefilled per turn',
)

// 4. Tool-pool order is deterministic (partition-sort) for prompt-cache
//    stability — tool REORDERING is one of the four named cache-breakers.
check(
  'toolPool partition-sorts the tool array for cache stability',
  /\.sort\(byName\)/.test(toolPool),
  'mergeAndFilterTools must emit a deterministically-ordered tool array (built-ins sorted, then mcp sorted); re-sorting per turn busts the cache',
)
check(
  'toolPool documents the cache-stability rationale',
  /cache stability/i.test(toolPool),
  'the partition-sort cache-stability comment/rationale was removed',
)

console.log(
  fail === 0
    ? '✅ prompt-cache stability invariants hold'
    : '❌ cache-stability invariants FAILED',
)
process.exit(fail)
