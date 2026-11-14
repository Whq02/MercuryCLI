import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { gitFixture } from '../builtin-tools/gitFixture.ts'

if (!process.argv.includes('--child')) {
  const wrapper = gitFixture('ast-edit-batch-home-')
  try {
    const child = spawnSync(process.execPath, [import.meta.filename, '--child'], {
      env: {
        ...wrapper.env,
        AST_PROOF_HOME: wrapper.home,
        MERCURY_TREESITTER_VENDOR_DIR: resolve(import.meta.dirname, '../../dist/vendor/treesitter'),
        MERCURY_BARE: '1',
      },
      stdio: 'inherit',
    })
    process.exitCode = child.status ?? 1
  } finally {
    wrapper.dispose()
  }
} else {
  if (homedir() !== process.env.AST_PROOF_HOME) throw new Error('wrong proof home before product imports')
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const { AstEditTool } = await import('../../src/tools/AstEditTool/AstEditTool.ts')
  const { AstSearchTool } = await import('../../src/tools/AstSearchTool/AstSearchTool.ts')
  const { digestOf, rewritePlanToken } = await import('../../src/utils/astPatterns.ts')
  const { gateToolCall } = await import('../../src/services/providers/toolCallGate.ts')
  const { _setBeforeRenameHookForProofs } = await import('../../src/services/changeTransaction/changeSetCommit.ts')
  const { getToolUseSummary, renderToolUseMessage } = await import('../../src/tools/AstEditTool/UI.tsx')
  const { drive, enterRoot, makeContext } = await import('./lib/harness.ts')

  const world = gitFixture('ast-edit-batch-')
  const launch = process.cwd()
  let checks = 0
  let failures = 0
  const check = (label: string, ok: boolean, detail = ''): void => {
    checks++
    if (!ok) failures++
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  }

  const EXCLUSIVE =
    'Pass either pattern and rewrite for one rule, or a non-empty rules array of { pattern, rewrite } pairs, never both.'

  try {
    await enterRoot(world.root)
    const tools = [AstSearchTool, AstEditTool]

    {
      const prover = await makeContext(tools)
      for (const [label, bad] of [
        ['empty object', {}],
        ['pattern without rewrite', { pattern: 'foo($X)' }],
        ['rewrite without pattern', { rewrite: 'bar($X)' }],
        ['empty rules array', { rules: [] }],
        ['both pattern+rewrite and rules', { pattern: 'foo($X)', rewrite: 'bar($X)', rules: [{ pattern: 'a()', rewrite: 'b()' }] }],
        ['pattern alongside rules', { pattern: 'foo($X)', rules: [{ pattern: 'a()', rewrite: 'b()' }] }],
        ['non-empty rewrite alongside rules', { rewrite: 'bar($X)', rules: [{ pattern: 'a()', rewrite: 'b()' }] }],
      ] as Array<[string, Record<string, unknown>]>) {
        const res = await drive(AstEditTool, bad, prover)
        check(`form validation (${label}): exact exclusive-forms sentence`, res.isError && res.text.includes(EXCLUSIVE), res.text)
      }
    }

    {
      mkdirSync(join(world.root, 'single'))
      const srcA = 'export const a = oldCall(1)\n'
      const srcB = 'export const b = oldCall(2)\n'
      world.put('single/a.ts', srcA)
      world.put('single/b.ts', srcB)
      const prover = await makeContext(tools)
      const preview = await drive(AstEditTool, { pattern: 'oldCall($X)', rewrite: 'newCall($X)', path: 'single' }, prover)
      const expectedToken = rewritePlanToken('oldCall($X)', 'newCall($X)', [
        ['a.ts', digestOf(srcA), digestOf('export const a = newCall(1)\n')],
        ['b.ts', digestOf(srcB), digestOf('export const b = newCall(2)\n')],
      ])
      check(
        'Point 2: single-rule dry run header, diff and token are unchanged',
        !preview.isError &&
          preview.text.startsWith('Dry run — 2 matches in 2 files would change; nothing written.\n\n--- a/a.ts') &&
          !preview.text.includes('Rules:') &&
          !preview.text.includes('Rule attribution') &&
          preview.data?.plan === expectedToken,
        `${preview.data?.plan} vs ${expectedToken}\n${preview.text.slice(0, 300)}`,
      )
      const applied = await drive(
        AstEditTool,
        { pattern: 'oldCall($X)', rewrite: 'newCall($X)', path: 'single', apply: true, plan: preview.data?.plan },
        prover,
      )
      check(
        'Point 2: single-rule ask and applied receipt are unchanged',
        !applied.isError &&
          applied.asks[0]?.message === 'Rewrite 2 matches of "oldCall($X)" in 2 files (a.ts, b.ts)? One decision covers every file; a denied file means zero writes.' &&
          /^Applied 2 structural rewrites in 2 files \(re-read verified\):\n  a\.ts — 1 rewrite \(anchor: fa:[0-9a-f]{12}\)\n  b\.ts — 1 rewrite \(anchor: fa:[0-9a-f]{12}\)$/.test(applied.text),
        applied.text,
      )
      const gatedDelete = gateToolCall([AstEditTool] as never, {
        id: 'del-1',
        name: 'AstEdit',
        argumentsRaw: JSON.stringify({ pattern: 'export const a = newCall(1)', rewrite: '', rules: [], path: 'single/a.ts', glob: '', lang: '', apply: false, plan: '' }),
        malformed: false,
      })
      check('keepEmptyInputs keeps rewrite "" through the tool-call gate while dropping blank rules []', gatedDelete.ok && gatedDelete.input.rewrite === '' && !('rules' in gatedDelete.input))
    }

    {
      mkdirSync(join(world.root, 'sim'))
      const origOne = 'const a = alpha(1)\nconst b = beta(2)\nconst eq1 = x == x\nconst eq2 = x == y\nconst drop = removeMe(99)\n'
      const origTwo = 'const c = swapLeft(10, 20)\nconst d = swapRight(30)\nconst keep = keepWrap(7)\n'
      world.put('sim/one.ts', origOne)
      world.put('sim/two.ts', origTwo)

      const rulesForward = [
        { pattern: 'alpha($X)', rewrite: 'beta($X)' },
        { pattern: 'beta($X)', rewrite: 'gamma($X)' },
        { pattern: '$A == $A', rewrite: 'Object.is($A, $A)' },
        { pattern: 'const drop = removeMe($_)', rewrite: '' },
        { pattern: 'swapLeft($$$ARGS)', rewrite: 'swapRight($$$ARGS)' },
        { pattern: 'swapRight($Y)', rewrite: 'swapLeft($Y)' },
        { pattern: 'keepWrap($$$)', rewrite: 'kept()' },
        { pattern: 'neverAppears($Z)', rewrite: 'unused($Z)' },
      ]
      const prover = await makeContext(tools)
      const dryFwd = await drive(AstEditTool, { rules: rulesForward, path: 'sim' }, prover)
      check(
        'M01: batch dry run returns combined per-file preview with zero writes and zero asks',
        !dryFwd.isError &&
          dryFwd.data?.state === 'dry-run' &&
          dryFwd.asks.length === 0 &&
          dryFwd.text.includes('--- a/one.ts') &&
          dryFwd.text.includes('--- a/two.ts') &&
          world.get('sim/one.ts') === origOne &&
          world.get('sim/two.ts') === origTwo,
        dryFwd.text.slice(0, 400),
      )
      check(
        'B03: preview explains per-rule counts, rule attribution and unmatched rules',
        dryFwd.text.includes('Matched nothing: rule 7.') &&
          dryFwd.text.includes('Rule attribution for one.ts:') &&
          dryFwd.text.includes('[rule 0]') &&
          dryFwd.text.includes('[rule 1]') &&
          dryFwd.text.includes('Coalesced edits: none.'),
        dryFwd.text.slice(0, 500),
      )

      const rulesReversed = [...rulesForward].reverse()
      const dryRev = await drive(AstEditTool, { rules: rulesReversed, path: 'sim' }, prover)
      check(
        'M02 + B01: reversing nonconflicting rules produces identical diffs without pipelining, while minting a distinct plan token',
        !dryRev.isError &&
          dryRev.data?.plan !== dryFwd.data?.plan &&
          dryRev.text.includes('+const a = beta(1)\n+const b = gamma(2)') &&
          dryFwd.text.includes('+const a = beta(1)\n+const b = gamma(2)'),
        `${dryFwd.data?.plan} vs ${dryRev.data?.plan}`,
      )

      world.put('sim/two.ts', origTwo.replace('swapRight(30)', 'swapRight(99)'))
      const staleEqualCount = await drive(
        AstEditTool,
        { rules: rulesForward, path: 'sim', apply: true, plan: dryFwd.data?.plan },
        prover,
      )
      check(
        'B01: equal-match-count byte drift invalidates the batch plan and changes neither file',
        staleEqualCount.isError &&
          staleEqualCount.asks.length === 0 &&
          staleEqualCount.text.includes('does not match the current dry run') &&
          world.get('sim/one.ts') === origOne &&
          world.get('sim/two.ts').includes('swapRight(99)'),
        staleEqualCount.text.slice(0, 300),
      )
      world.put('sim/two.ts', origTwo)

      const staleRuleChange = await drive(
        AstEditTool,
        {
          rules: rulesForward.map((r, i) => (i === 7 ? { pattern: 'neverAppears($Z)', rewrite: 'differentUnused($Z)' } : r)),
          path: 'sim',
          apply: true,
          plan: dryFwd.data?.plan,
        },
        prover,
      )
      check(
        'B01: changing even an unmatched rule invalidates the old batch plan',
        staleRuleChange.isError && staleRuleChange.text.includes('does not match the current dry run'),
        staleRuleChange.text.slice(0, 240),
      )

      const staleScopeChange = await drive(
        AstEditTool,
        { rules: rulesForward, path: 'sim', glob: '*.ts', apply: true, plan: dryFwd.data?.plan },
        prover,
      )
      check(
        'B01: changing the selected scope invalidates the old batch plan even when the same files match',
        staleScopeChange.isError && staleScopeChange.text.includes('does not match the current dry run'),
        staleScopeChange.text.slice(0, 240),
      )

      const applied = await drive(
        AstEditTool,
        { rules: rulesForward, path: 'sim', apply: true, plan: dryFwd.data?.plan },
        prover,
      )
      check(
        'M03 + M06: applying the batch asks once and lands simultaneous captures, repeated captures, anonymous captures, deletions and swaps',
        !applied.isError &&
          applied.asks.length === 1 &&
          applied.data?.state === 'applied' &&
          applied.data?.matchCount === 7 &&
          world.get('sim/one.ts') === 'const a = beta(1)\nconst b = gamma(2)\nconst eq1 = Object.is(x, x)\nconst eq2 = x == y\n' &&
          world.get('sim/two.ts') === 'const c = swapRight(10, 20)\nconst d = swapLeft(30)\nconst keep = kept()\n',
        `${applied.text}\n---\n${world.get('sim/one.ts')}\n---\n${world.get('sim/two.ts')}`,
      )
      check(
        'M06 + B03: applied receipt reports aggregate and per-file counts, contributing rules and unmatched rules',
        applied.text.includes('Applied 7 structural rewrites in 2 files (re-read verified):') &&
          applied.text.includes('one.ts — 4 rewrites (rules 0, 1, 2, 3)') &&
          applied.text.includes('two.ts — 3 rewrites (rules 4, 5, 6)') &&
          applied.text.includes('Matched nothing: rule 7.'),
        applied.text,
      )
    }

    {
      mkdirSync(join(world.root, 'coalesce'))
      const src = 'const x = legacy(1)\nconst y = legacy(2)\n'
      world.put('coalesce/c.ts', src)
      const prover = await makeContext(tools, { allow: ['AstEdit'] })
      const coalesceRules = [
        { pattern: 'legacy(1)', rewrite: 'modern(1, true)' },
        { pattern: 'legacy($X)', rewrite: 'modern($X, true)' },
      ]
      const dry = await drive(AstEditTool, { rules: coalesceRules, path: 'coalesce' }, prover)
      check(
        'M04 + B03: equivalent computed edits from different rules coalesce, count once and name the coalesced span',
        !dry.isError &&
          dry.data?.matchCount === 2 &&
          dry.text.includes('Coalesced edits (1): c.ts:1:11 [rules 0, 1].') &&
          dry.text.includes('1:11 [rules 0+1]'),
        dry.text,
      )
      const app = await drive(AstEditTool, { rules: coalesceRules, path: 'coalesce', apply: true, plan: dry.data?.plan }, prover)
      check(
        'M04: coalesced apply writes the shared span once cleanly',
        !app.isError && world.get('coalesce/c.ts') === 'const x = modern(1, true)\nconst y = modern(2, true)\n',
        world.get('coalesce/c.ts'),
      )

      const divergentSameSpan = await drive(
        AstEditTool,
        {
          rules: [
            { pattern: 'modern(1, true)', rewrite: 'firstWay(1)' },
            { pattern: 'modern($X, true)', rewrite: 'secondWay($X)' },
          ],
          path: 'coalesce',
        },
        prover,
      )
      check(
        'M04: divergent same-span overlap is refused before preview naming file, both rule indices and locations',
        divergentSameSpan.isError &&
          divergentSameSpan.text.includes('Overlapping rewrites in c.ts: rule 0 ("modern(1, true)") at 1:11 and rule 1 ("modern($X, true)") at 1:11 touch the same source span with different replacements.'),
        divergentSameSpan.text,
      )

      world.put('coalesce/nested.ts', 'const z = outer(inner(1))\n')
      const nestedOverlap = await drive(
        AstEditTool,
        {
          rules: [
            { pattern: 'outer($X)', rewrite: 'OUTER($X)' },
            { pattern: 'inner($Y)', rewrite: 'INNER($Y)' },
          ],
          path: 'coalesce/nested.ts',
        },
        prover,
      )
      check(
        'M04: nested overlap across rules is refused before preview with both rule indices and coordinates',
        nestedOverlap.isError &&
          nestedOverlap.text.includes('Overlapping rewrites in nested.ts: rule 0 ("outer($X)") at 1:11 and rule 1 ("inner($Y)") at 1:17 touch the same source span with different replacements.') &&
          world.get('coalesce/nested.ts') === 'const z = outer(inner(1))\n',
        nestedOverlap.text,
      )
    }

    {
      mkdirSync(join(world.root, 'mixed'))
      world.put('mixed/code.ts', 'function greet(x: number) { return tap(x) }\n')
      world.put('mixed/script.py', 'def run():\n    print(1)\n')
      world.put('mixed/broken.ts', 'const bad = ;\nconst ok = tap(2);\n')
      const prover = await makeContext(tools, { allow: ['AstEdit'] })

      for (const [label, rules, expected] of [
        ['empty pattern in rule 1', [{ pattern: 'tap($X)', rewrite: 'hit($X)' }, { pattern: '   ', rewrite: 'x' }], 'Rule 1: pattern is empty'],
        ['anonymous metavar in rule 1 rewrite', [{ pattern: 'tap($X)', rewrite: 'hit($X)' }, { pattern: 'print($_)', rewrite: 'log($_)' }], 'Rule 1 ("print($_)"): The rewrite uses an anonymous meta-variable'],
        ['uncaptured metavar in rule 1 rewrite', [{ pattern: 'tap($X)', rewrite: 'hit($X)' }, { pattern: 'unmatched($A)', rewrite: 'out($A, $MISSING)' }], 'Rule 1 ("unmatched($A)" → "out($A, $MISSING)"): the rewrite references $MISSING'],
        ['syntax-invalid pattern in rule 1', [{ pattern: 'tap($X)', rewrite: 'hit($X)' }, { pattern: ')((broken', rewrite: 'x' }], 'Rule 1: The pattern ")((broken" did not parse'],
      ] as Array<[string, Array<{ pattern: string; rewrite: string }>, string]>) {
        const bad = await drive(AstEditTool, { rules, path: 'mixed' }, prover)
        check(`M05 (${label}): identifies the invalid rule`, bad.isError && bad.text.includes(expected), bad.text)
      }

      const crossLang = await drive(
        AstEditTool,
        {
          rules: [
            { pattern: 'tap($X)', rewrite: 'recorded($X)' },
            { pattern: 'def $NAME(): $$$BODY', rewrite: 'def $NAME():\n    $$$BODY' },
          ],
          path: 'mixed',
        },
        prover,
      )
      check(
        'M05 + P.60: mixed-language batch attributes language skips per rule and reports recovered trees honestly',
        !crossLang.isError &&
          crossLang.data?.matchCount === 2 &&
          crossLang.text.includes('Not searched: 2 typescript files (rule 1: the pattern does not parse as typescript') &&
          crossLang.text.includes('Searched recovered tree: broken.ts (typescript;'),
        crossLang.text,
      )
    }

    {
      mkdirSync(join(world.root, 'txn'))
      const origA = 'export const v = stepA(1)\n'
      const origB = 'export const w = stepB(2)\n'
      world.put('txn/a.ts', origA)
      world.put('txn/b.ts', origB)
      const prover = await makeContext(tools, { allow: ['AstEdit'] })
      const batchRules = [
        { pattern: 'stepA($X)', rewrite: 'doneA($X)' },
        { pattern: 'stepB($X)', rewrite: 'doneB($X)' },
      ]
      const dry = await drive(AstEditTool, { rules: batchRules, path: 'txn' }, prover)
      let injected = false
      _setBeforeRenameHookForProofs(file => {
        if (file === join(world.root, 'txn/b.ts')) {
          injected = true
          throw new Error('injected batch commit failure')
        }
      })
      const failed = await drive(AstEditTool, { rules: batchRules, path: 'txn', apply: true, plan: dry.data?.plan }, prover)
      _setBeforeRenameHookForProofs(null)
      check(
        'B02: failing member during batch commit restores every file to original bytes',
        injected &&
          failed.isError &&
          failed.text.includes('every touched file was restored to its original bytes and VERIFIED by reread') &&
          world.get('txn/a.ts') === origA &&
          world.get('txn/b.ts') === origB,
        failed.text,
      )

      const cancelled = await makeContext(tools, { allow: ['AstEdit'] })
      ;(cancelled.ctx.abortController as AbortController).abort()
      const cancelRes = await drive(AstEditTool, { rules: batchRules, path: 'txn', apply: true, plan: dry.data?.plan }, cancelled)
      check(
        'B02: cancellation before commit writes no prefix',
        cancelRes.isError && world.get('txn/a.ts') === origA && world.get('txn/b.ts') === origB,
        cancelRes.text,
      )
    }

    {
      mkdirSync(join(world.root, 'scale'))
      const manyCalls = Array.from({ length: 65 }, (_, i) => `const c${i} = fn${i}(${i});`).join('\n\n\n\n') + '\n'
      world.put('scale/big.ts', manyCalls)
      const sixtyRules = Array.from({ length: 60 }, (_, i) => ({ pattern: `fn${i}($X)`, rewrite: `renamed${i}($X)` }))
      const prover = await makeContext(tools, { allow: ['AstEdit'] })
      const bigDry = await drive(AstEditTool, { rules: sixtyRules, path: 'scale' }, prover)
      check(
        'B03: 60-rule batch plans without a rule-count cap and bounds large per-file diffs honestly',
        !bigDry.isError &&
          bigDry.data?.matchCount === 60 &&
          bigDry.text.includes('across 60 rules') &&
          bigDry.text.includes('more diff lines in big.ts)'),
        bigDry.text.slice(-300),
      )
      const summary = getToolUseSummary({ rules: sixtyRules, apply: false })
      const msg = renderToolUseMessage({ rules: sixtyRules, path: 'scale', apply: false }, { verbose: false })
      check('UI summary and card render batch rules cleanly', typeof summary === 'string' && summary.includes('60 rules') && msg !== null, String(summary))

      const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
      const { toOpenaiStrictToolSchema } = await import('../../src/utils/messages/toolSchemaDialect.ts')
      const { stripNullArgs } = await import('../../src/services/providers/openai/openaiWire.ts')
      const desc = await AstEditTool.description()
      const canonical = zodToJsonSchema(AstEditTool.inputSchema)
      const strictForm = toOpenaiStrictToolSchema(canonical)
      console.log(
        `AstEdit counts: desc=${desc.length} canonicalSchema=${JSON.stringify(canonical).length} strictSchema=${strictForm.strict ? JSON.stringify(strictForm.schema).length : -1}`,
      )
      check(
        'AstEdit stays strict on provider strict dialect and carries exact ruled description',
        strictForm.strict === true && desc.length === 451 && 'rules' in (canonical.properties as Record<string, unknown>),
        JSON.stringify(strictForm),
      )
      const stripped = stripNullArgs(
        { pattern: null, rewrite: null, rules: [{ pattern: 'a()', rewrite: 'b()' }], path: null, glob: null, lang: null, apply: null, plan: null },
        canonical,
      )
      check(
        'strict-wire null placeholders strip cleanly to the batch call',
        JSON.stringify(stripped) === JSON.stringify({ rules: [{ pattern: 'a()', rewrite: 'b()' }] }),
        JSON.stringify(stripped),
      )
    }
  } finally {
    _setBeforeRenameHookForProofs(null)
    process.chdir(launch)
    world.dispose()
  }

  console.log(`AstEdit batch rules: ${checks - failures}/${checks}`)
  process.exitCode = failures ? 1 : 0
}
