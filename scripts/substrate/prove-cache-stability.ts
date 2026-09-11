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

const uncachedCalls = (
  prompts.match(/DANGEROUS_uncachedSystemPromptSection\(/g) || []
).length
check(
  'exactly 1 volatile (DANGEROUS_uncached) system-prompt section',
  uncachedCalls === 1,
  `found ${uncachedCalls}; a new volatile cached section busts the prefix cache every turn — move volatile content to a TAIL attachment (utils/attachments.ts), not the cached prefix`,
)

check(
  'SYSTEM_PROMPT_DYNAMIC_BOUNDARY marker present',
  prompts.includes('SYSTEM_PROMPT_DYNAMIC_BOUNDARY'),
  'the static/dynamic cache boundary marker was removed',
)

check(
  'Mercury contract composed as a static (cacheable) section',
  /getMercuryContractSections\(\)/.test(prompts),
  'the contract seam changed — keep it a static section so the identity/doctrine prefix is cache-read, not re-prefilled per turn',
)

check(
  'toolPool partition-sorts the tool array for cache stability',
  /\.sort\(byName\)/.test(toolPool),
  'mergeAndFilterTools must emit a deterministically-ordered tool array (built-ins sorted, then mcp sorted); re-sorting per turn busts the cache',
)

console.log(
  fail === 0
    ? '✅ prompt-cache stability invariants hold'
    : '❌ cache-stability invariants FAILED',
)
process.exit(fail)
