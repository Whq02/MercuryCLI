#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const repo = join(import.meta.dir, '..', '..')

let failures = 0
const check = (cond: boolean, msg: string, detail = ''): void => {
  if (cond) console.log(`  [PASS] ${msg}`)
  else {
    failures++
    console.error(`  [FAIL] ${msg}${detail ? ` — ${detail}` : ''}`)
  }
}

const driverSrc = `
import { enableConfigs } from '${repo}/src/utils/config/globalConfig.js'
enableConfigs()
const { getSystemPrompt } = await import('${repo}/src/constants/prompts.js')
const withTools = process.argv[process.argv.length - 1] === 'with-tools'
const tools = withTools
  ? [{ name: 'RecordConvention' }, { name: 'RememberLesson' }, { name: 'Bash' }]
  : [{ name: 'Bash' }]
const sections = await getSystemPrompt(tools, 'claude-fable-5')
console.log(JSON.stringify({ prompt: sections.join('\\n\\n') }))
`
const driverDir = mkdtempSync(join(tmpdir(), 'doctrine-drv-'))
const driverPath = join(driverDir, 'drv.ts')
writeFileSync(driverPath, driverSrc)

function drive(variant: 'with-tools' | 'bare'): string {
  const home = mkdtempSync(join(tmpdir(), 'doctrine-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'doctrine-cwd-'))
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(MERCURY_|CLAUDE_)/.test(k)) continue
    env[k] = v
  }
  env.MERCURY_CONFIG_DIR = home
  env.MERCURY_EVOLUTION_LEDGER = '0'
  const run = spawnSync(process.execPath, ['run', driverPath, variant], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  })
  rmSync(home, { recursive: true, force: true })
  if (run.status !== 0) {
    console.error(`  [FAIL] driver exited ${run.status}: ${String(run.stderr).slice(0, 800)}`)
    process.exit(1)
  }
  const lines = String(run.stdout).trim().split('\n')
  return (JSON.parse(lines[lines.length - 1]!) as { prompt: string }).prompt
}

console.log('assembled prompt — tools on the roster')
const prompt = drive('with-tools')
check(prompt.includes('# The project instruction estate'), 'the estate section is present')
check(
  prompt.includes(
    'record it in the instruction estate with the RecordConvention tool and say you did',
  ),
  'the capture sentence, tool-spelled, announcement included',
)
check(
  prompt.includes('No magic word arms this — the statement itself does'),
  'no magic word — organic capture',
)
check(
  prompt.includes('One-off task details are never enshrined'),
  'one-off details never enshrined',
)
check(
  prompt.includes(
    'a new convention lands in the pointed guide, never stacked into the pointer file',
  ),
  'the pointer law is stated',
)
check(
  prompt.includes('lives in `.mercury/`, created organically on first use, never on a bare boot'),
  'the .mercury working-state line (first use, never bare boot)',
)
check(
  prompt.includes("checked in or gitignored is the user's call"),
  'gitignore stays the user\'s call',
)
check(
  prompt.includes('Merge, never duplicate'),
  'merge-never-duplicate stated',
)
check(prompt.includes('Name the choice when you record'), 'scope naming stated')
check(
  prompt.includes('curated context, not a log: say each thing once, fold related rules together, and delete stale lines'),
  'the curation doctrine',
)
check(prompt.includes('(RememberLesson)'), 'the private-memory spelling rides when present')

console.log('assembled prompt — narration: one rule, once; the old sentences gone')
const once = (needle: string): boolean => prompt.split(needle).length === 2
check(
  once(
    'Skip preambles for quick tasks. For substantial work, including read-only investigations, briefly explain the approach and report important findings, blockers or changes of direction',
  ),
  'the narration rule rides exactly once',
)
check(
  !prompt.includes('Announce your intent before the first tool call') &&
    !prompt.includes('only when it helps the operator follow') &&
    !prompt.includes('on short or read-only work'),
  'no announce-always, no introduce-only-when-it-helps, no read-only exemption',
)

console.log('assembled prompt — security: fixes stay within the authorised scope')
check(
  once(
    'Fix security issues within the authorised implementation scope. During read-only work, or for issues outside that scope, report the issue and obtain permission before editing.',
  ) && prompt.includes('Avoid introducing security vulnerabilities'),
  'the scoped security rule rides exactly once, beside the avoid-vulnerabilities half',
)
check(!prompt.includes('Fix insecure code immediately when you see it'), 'no fix-on-sight sentence')

console.log('assembled prompt — evidence: reuse while it applies, recheck on change')
check(
  once(
    'Reuse recorded evidence while it still applies to the current state. Recheck when relevant state changed, evidence is missing or stale, or new evidence contradicts it. Memory alone is not verification.',
  ),
  'the evidence rule rides exactly once',
)
check(
  prompt.includes('no re-verifying what was already checked while its evidence still applies to the current state') &&
    !prompt.includes('no re-verifying what was already checked.') &&
    !prompt.includes('verify recalled or remembered facts against the live files'),
  'the report line carries the condition in place of the blanket; no verify-memory-always sentence',
)

console.log('assembled prompt — bare roster (laws hold without tool spellings)')
const bare = drive('bare')
check(bare.includes('# The project instruction estate'), 'section present without the tools')
check(
  bare.includes('record it in the instruction estate and say you did'),
  'capture sentence intact, no tool spelling',
)
check(!bare.includes('RecordConvention'), 'no phantom tool name on a bare roster')
check(
  bare.includes('a new convention lands in the pointed guide, never stacked into the pointer file.'),
  'pointer law intact without the follow-note',
)

console.log(failures === 0 ? '\nDOCTRINE PINNED' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
