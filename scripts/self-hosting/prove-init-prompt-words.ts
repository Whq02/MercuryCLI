#!/usr/bin/env bun
// gate-watch: src/commands/init.ts src/projectOnboardingState.ts
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const repo = join(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'init-words-')))
const project = join(scratch, 'project')
mkdirSync(project, { recursive: true })
writeFileSync(join(project, 'package.json'), '{"name":"fixture"}\n')
const driver = join(scratch, 'driver.ts')
writeFileSync(driver, `
import { writeFileSync } from 'node:fs'
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import(${JSON.stringify(join(repo, 'src/utils/config/globalConfig.ts'))})
enableConfigs()
const init = (await import(${JSON.stringify(join(repo, 'src/commands/init.ts'))})).default
const blocks = await init.getPromptForCommand('', {} as never)
writeFileSync(process.argv[2]!, JSON.stringify({ description: init.description, text: blocks.map((b: { text?: string }) => b.text ?? '').join('\\n') }))
`)

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

try {
  const home = mkdtempSync(join(scratch, 'home-'))
  seedFirstRun(home, [project])
  const result = join(home, 'result.json')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MERCURY_|CLAUDE_|ANTHROPIC_)/.test(key)))
  const run = spawnSync(process.execPath, ['run', driver, result], {
    cwd: project,
    env: { ...env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (run.error) throw run.error
  if (run.status !== 0) throw new Error(`driver exited ${run.status}: ${run.stderr}`)
  const { description, text } = JSON.parse(readFileSync(result, 'utf8')) as { description: string; text: string }

  check('the command still describes itself as the MERCURY.md writer', description === 'Analyze the codebase and create (or improve) MERCURY.md', description)
  check('the prompt writes MERCURY.md', /write MERCURY\.md/.test(text))
  check('the prompt states the loading rule: MERCURY.md first, AGENTS.md when there is none, MERCURY.md alone when both exist', /loads MERCURY\.md first; when a project has no MERCURY\.md it loads AGENTS\.md instead; when both\s+exist only MERCURY\.md loads/.test(text))
  check('with an AGENTS.md present, MERCURY.md opens with the one line @AGENTS.md', /If AGENTS\.md exists, open MERCURY\.md with the one line @AGENTS\.md/.test(text))
  check('what is Mercury-specific goes below the import, never a duplicate of the shared guide', /keep only what is Mercury-specific below it — never duplicate its content/.test(text))
  check('the README and the other agent instruction files the repository holds are read, in the guide\'s own words', /Read the README and any other agent instruction files the repository already holds/.test(text))
  check('another agent instruction file is previewed and imported only on a yes, never copied or loaded silently', /never copy its content into MERCURY\.md, and never load it silently/.test(text) && /OFFER a one-line explicit import \(@<file>\)/.test(text) && /only if the operator says yes/.test(text))
  check('never overwrite silently stays', /never overwrite silently/.test(text))
  check('say each thing once stays', /Say each thing once/.test(text))
  check('claim nothing unverified stays', /Claim nothing you did not verify/.test(text))
  const otherTools = [['CL', 'AUDE'].join(''), 'Cursor', 'Copilot', ['GEM', 'INI.md'].join(''), 'compatible-harness']
  const named = otherTools.filter(word => text.includes(word))
  check('the prompt names no other tool and no other tool\'s file', named.length === 0, named.join(', '))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`init-prompt-words: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
