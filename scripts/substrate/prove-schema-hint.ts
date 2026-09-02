#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-schema-hint.ts
//  PROOF: buildSchemaNotSentHint — the model-facing DEFERRED-TOOL recovery
//  affordance (services/tools/toolExecution.ts:581-600, wired into the
//  InputValidationError path at :696-707) — returns the `select:<name>` ToolSearch
//  hint for a deferred-but-undiscovered tool, and returns null in EACH suppression
//  case (standard mode / ToolSearch absent / non-deferred tool / already
//  discovered). This is the only recovery hint that turns a hard Zod failure
//  ("expected array, got string", from a schema the model never received) into a
//  one-line fix; it had zero coverage, so its gate grammar must not silently drift.
//
//  toolExecution.ts AND toolSearch.ts both import feature() from bun:bundle and
//  are UNLOADABLE under bun-run. We therefore (a) drive the REAL loadable
//  primitives isDeferredTool + TOOL_SEARCH_TOOL_NAME, (b) run a VERBATIM
//  reconstruction of the 5-gate composition from toolExecution.ts:590-599 over
//  faithful local copies of the two pure predicates it calls (the trivial
//  isToolSearchToolAvailable + the message-history extractDiscoveredToolNames),
//  and (c) dist-grep the BUILT product to prove the real wired hint + select:
//  query format actually ship. (a)+(c) anchor the replica to real code.
// ============================================================================

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { isDeferredTool, TOOL_SEARCH_TOOL_NAME } = await import(
  '../../src/tools/ToolSearchTool/prompt.js'
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

type Tool = Parameters<typeof isDeferredTool>[0]
type Msg = { type: string; message?: { content?: unknown } }

// Faithful copy of isToolSearchToolAvailable (toolSearch.ts:330-334): a tool whose
// name === TOOL_SEARCH_TOOL_NAME is present.
function toolSearchToolAvailable(tools: readonly { name: string }[]): boolean {
  return tools.some(t => t.name === TOOL_SEARCH_TOOL_NAME)
}

// Faithful copy of the discovered-set scan (toolSearch.ts:545-592, the slice
// buildSchemaNotSentHint relies on): tool_reference.tool_name inside a tool_result.
function extractDiscovered(messages: Msg[]): Set<string> {
  const out = new Set<string>()
  for (const msg of messages) {
    if (msg.type !== 'user') continue
    const content = msg.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const b = block as { type?: string; content?: unknown[] }
      if (b?.type === 'tool_result' && Array.isArray(b.content)) {
        for (const item of b.content) {
          const it = item as { type?: string; tool_name?: unknown }
          if (it?.type === 'tool_reference' && typeof it.tool_name === 'string') {
            out.add(it.tool_name)
          }
        }
      }
    }
  }
  return out
}

/**
 * VERBATIM reconstruction of buildSchemaNotSentHint (toolExecution.ts:590-599).
 * The single difference: isToolSearchEnabledOptimistic() — which the source
 * documents as optimistic and whose real value is env/provider-dependent — is
 * passed in as `optimisticEnabled` so we can exercise BOTH branches.
 */
function buildSchemaNotSentHint(
  tool: Tool,
  messages: Msg[],
  tools: readonly { name: string }[],
  optimisticEnabled: boolean,
): string | null {
  if (!optimisticEnabled) return null
  if (!toolSearchToolAvailable(tools)) return null
  if (!isDeferredTool(tool)) return null
  const discovered = extractDiscovered(messages)
  if (discovered.has(tool.name)) return null
  return (
    `\n\nThis tool's schema was not sent to the API — it was not in the discovered-tool set derived from message history. ` +
    `Without the schema in your prompt, typed parameters (arrays, numbers, booleans) get emitted as strings and the client-side parser rejects them. ` +
    `Load the tool first: call ${TOOL_SEARCH_TOOL_NAME} with query "select:${tool.name}", then retry this call.`
  )
}

console.log('============================================================')
console.log(' buildSchemaNotSentHint — deferred-tool recovery hint — proof')
console.log('============================================================')

const toolsWithSearch = [{ name: TOOL_SEARCH_TOOL_NAME }, { name: 'WebFetch' }]
// A genuinely-deferred tool: MCP tools are always deferred (isDeferredTool:74).
const deferredTool = { name: 'WebFetch', isMcp: true } as unknown as Tool
const noMessages: Msg[] = []

// ── the HAPPY path: deferred + undiscovered ⇒ select:<name> hint ─────────────
section('deferred-but-undiscovered tool ⇒ returns the select:<name> hint')
{
  const hint = buildSchemaNotSentHint(deferredTool, noMessages, toolsWithSearch, true)
  check('hint is non-null', hint !== null)
  check('hint names the exact select: query', hint?.includes(`query "select:WebFetch"`) === true, hint ? hint.trim().split('\n').pop() : '(null)')
  check('hint names ToolSearch by its real tool name', hint?.includes(TOOL_SEARCH_TOOL_NAME) === true)
  check('hint explains the typed-param→string failure', hint?.includes('emitted as strings') === true)
}

// ── suppression case 1: standard mode (optimistic gate off) ──────────────────
section('suppression: ToolSearch optimistically disabled (standard mode) ⇒ null')
{
  const hint = buildSchemaNotSentHint(deferredTool, noMessages, toolsWithSearch, false)
  check('null when tool search is off', hint === null)
}

// ── suppression case 2: ToolSearchTool absent from the pool ──────────────────
section('suppression: ToolSearchTool not in the tools pool ⇒ null')
{
  const toolsNoSearch = [{ name: 'WebFetch' }, { name: 'Bash' }]
  const hint = buildSchemaNotSentHint(deferredTool, noMessages, toolsNoSearch, true)
  check('null when ToolSearch is unavailable (cannot point at an uncallable tool)', hint === null)
}

// ── suppression case 3: a non-deferred tool ──────────────────────────────────
section('suppression: a non-deferred tool ⇒ null')
{
  const plainTool = { name: 'Bash', shouldDefer: false } as unknown as Tool
  check('control: isDeferredTool(plainTool) is false', isDeferredTool(plainTool) === false)
  const hint = buildSchemaNotSentHint(plainTool, noMessages, toolsWithSearch, true)
  check('null for a standard inline tool (its schema was always sent)', hint === null)
}

// ── suppression case 4: already-discovered (schema WAS loaded) ───────────────
section('suppression: tool already in the discovered set ⇒ null')
{
  const discoveredMsgs: Msg[] = [
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            content: [{ type: 'tool_reference', tool_name: 'WebFetch' }],
          },
        ],
      },
    },
  ]
  check('control: scan finds WebFetch', extractDiscovered(discoveredMsgs).has('WebFetch'))
  const hint = buildSchemaNotSentHint(deferredTool, discoveredMsgs, toolsWithSearch, true)
  check('null once the tool has been ToolSearch-loaded', hint === null)
}

// ── the REAL wired hint + select: format ship in the built product ───────────
section('dist-grep: the real hint + select:${name} format ship in dist/mercury.mjs')
{
  const dist = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
  if (!existsSync(dist)) {
    console.log('  [SKIP] dist/mercury.mjs not built — run `bun run build.ts` to include this check')
  } else {
    const src = readFileSync(dist, 'utf8')
    check('the recovery-hint sentence is in the build', src.includes("This tool's schema was not sent to the API"))
    // NOTE: the interpolated RECEIVER is a minifier-chosen identifier (it has
    // shipped as `tool.name`, `A.name`, and `$.name` across builds) — match any
    // identifier charset incl. `$`, anchoring on the stable `.name` property.
    check('the select:${...name} query format is in the build', /select:\$\{[$\w.]*name\}/.test(src))
  }
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL SCHEMA-HINT PROOFS PASS')
else console.log(`❌ ${failures} SCHEMA-HINT PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
