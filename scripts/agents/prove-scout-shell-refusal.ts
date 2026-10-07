#!/usr/bin/env bun
// gate-watch: src/tools/AgentTool/scoutPolicy.ts src/tools/BashTool/BashTool.tsx src/tools/BashTool/readOnlyValidation.ts src/utils/config.ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'scout-shell-refusal-')))
const root = join(scratch, 'run')
mkdirSync(root)
mkdirSync(join(scratch, 'home'))
writeFileSync(join(root, 'b_big.py'), 'x = 1\n')
const previousCwd = process.cwd()
process.chdir(root)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
await import('../../src/services/providers/callModelRouter.js')
await import('../../src/utils/messages.js')
await import('../../src/Tool.js')
const { scoutRefusal } = await import('../../src/tools/AgentTool/scoutPolicy.js')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const refusal = (command: string, extra: Record<string, unknown> = {}): string | null => scoutRefusal(BashTool as never, { command, ...extra })
const bigPy = join(root, 'b_big.py')
const TAIL = 'Read-only commands do run here, with pipes, 2>&1 and input redirects (< file) — for example wc, grep, head, tail and sort — and Read, Grep and Glob read files.'
const PYTHON = `mercury-scout is read-only: \`python3\` is not a command Mercury can verify as read-only, so no form of it runs in this shell. ${TAIL}`

console.log('prove-scout-shell-refusal — the read-only scout names the command word it refuses')

console.log('\n1. a parse-only python3 -c is refused naming python3, not the pipe or the program')
{
  const got = refusal(`python3 -c "import ast,pathlib; ast.parse(pathlib.Path('${bigPy}').read_text())"`)
  check('the refusal is the not-on-list sentence for python3 plus the shared tail', got === PYTHON, JSON.stringify(got))
}

console.log("\n2. a multi-line program holding a `>` still names python3, not the screen's writing words")
{
  const got = refusal(`python3 -c "\nimport ast\np='${bigPy}'\nt=ast.parse(open(p).read())\nprint(len(t.body) > 0)\n"`)
  check('the refusal names python3', got === PYTHON, JSON.stringify(got))
  check('it does not carry the screen sentence', got !== null && !got.includes('A command writing to a file needs approval'), JSON.stringify(got))
}

console.log('\n3. a write names the file; a non-read-only form names the form and the word')
{
  const writes = refusal('grep x b_big.py > out.txt')
  check('grep x b_big.py > out.txt → the writes sentence naming out.txt', writes === `mercury-scout is read-only: the command writes to \`out.txt\`, so it does not run in this shell. ${TAIL}`, JSON.stringify(writes))
  const form = refusal("sed -i 's/a/b/' f.txt")
  check("sed -i 's/a/b/' f.txt → the form sentence", form === `mercury-scout is read-only: \`sed -i 's/a/b/' f.txt\` is not a read-only form of \`sed\`, so it does not run in this shell. ${TAIL}`, JSON.stringify(form))
  const sandbox = refusal('ls', { dangerouslyDisableSandbox: true })
  check('a call that leaves the sandbox → the sandbox sentence', sandbox === `mercury-scout is read-only: a shell call that leaves the sandbox or carries a simulated sed edit does not run here. ${TAIL}`, JSON.stringify(sandbox))
  const guard = refusal('cd .. && git log')
  check('cd .. && git log → the git guard sentence', guard === `mercury-scout is read-only: A cd combined with git is not auto-allowed. ${TAIL}`, JSON.stringify(guard))
  const loop = refusal('for f in a b; do cat -A "$f"; done')
  check('a for loop → `for` is not on a list', loop === `mercury-scout is read-only: \`for\` is not a command Mercury can verify as read-only, so no form of it runs in this shell. ${TAIL}`, JSON.stringify(loop))
  const exec = refusal('find . -type f -exec ls -la {} \\;')
  check('find -exec → the form sentence for find', exec === `mercury-scout is read-only: \`find . -type f -exec ls -la {} \\;\` is not a read-only form of \`find\`, so it does not run in this shell. ${TAIL}`, JSON.stringify(exec))
}

console.log('\n4. read-only commands run, with pipes, 2>&1 and the input redirect')
{
  check('wc -l b_big.py 2>&1 | tail -5 → null', refusal('wc -l b_big.py 2>&1 | tail -5') === null, JSON.stringify(refusal('wc -l b_big.py 2>&1 | tail -5')))
  check('wc -l < b_big.py → null', refusal('wc -l < b_big.py') === null, JSON.stringify(refusal('wc -l < b_big.py')))
  check('sort < b_big.py | head -n 3 → null', refusal('sort < b_big.py | head -n 3') === null, JSON.stringify(refusal('sort < b_big.py | head -n 3')))
}

process.chdir(previousCwd)
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-scout-shell-refusal: ALL LAWS HOLD' : `\nprove-scout-shell-refusal: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
