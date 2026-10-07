#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')
const { checkAnchor, formatAnchorFailure, mintFileAnchor } = await import(join(ROOT, 'src/services/changeTransaction/snapshotAnchor.ts'))

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const content = 'line 1\nline 2\n'
const bare = mintFileAnchor(content)
const decorated = `(anchor: ${bare})`
const result = checkAnchor(decorated, content, '/tmp/f.txt')
check('the decorated form a Read result prints is refused as malformed', !result.ok && result.reason === 'malformed', JSON.stringify(result))
if (!result.ok) {
  const hint = result.rereadHint
  check('the reread hint names the bare fa:… or ra:… value', /bare fa:… or ra:…/.test(hint), hint)
  check('the reread hint tells the model to leave out the parentheses and the word anchor', /without the parentheses or the word anchor/.test(hint), hint)
  check("the reread hint no longer quotes the '(anchor: …) value' the model then copied", !/use the \(anchor: …\) value/.test(hint), hint)
  const message = formatAnchorFailure(result, decorated)
  check('the Edit refusal line says the anchor is the bare value, never the decoration', /bare fa:… or ra:… value, never the \(anchor: …\) decoration/.test(message), message)
}
check('the bare value is accepted', checkAnchor(bare, content, '/tmp/f.txt').ok === true)

const planSource = readFileSync(join(ROOT, 'src/services/changeTransaction/changeSetPlan.ts'), 'utf8')
check('the ChangeSet preflight refusal says the same: the bare value, never the decoration', planSource.includes("is not a valid anchor — pass the bare fa:… or ra:… value, never the (anchor: …) decoration around it"))

console.log(failures === 0 ? 'PASS: the malformed-anchor words name the bare value' : `FAIL: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
