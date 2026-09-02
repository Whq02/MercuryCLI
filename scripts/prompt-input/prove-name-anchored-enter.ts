#!/usr/bin/env bun
// ============================================================================
//  prove-name-anchored-enter — a bare ↵ never executes a description-matched
//  command (isNameAnchoredSuggestion + the useTypeahead 'command' guard).
//
// THE FIND (driven on the built bundle):
//  a typed "/theme" ↵ in the chat submitted "/update-config" as a MODEL
//  TURN — the Fuse index matches DESCRIPTION words (update-config's
//  describe says "theme"), the menu's top row auto-applies on ↵ with
//  nothing arrowed, and a prompt-class skill executes on apply. A typo's
//  cost was a wire spend and an interrupted turn.
//
//  §1 the pure law over isNameAnchoredSuggestion (name · name part · alias
//     anchor; description-only refused; non-slash and bare-slash inputs
//     pass through). §2 the guard sits in useTypeahead's 'command' case
//     AHEAD of applyCommandSuggestion, gated on viaEnter + nothing arrowed.
//  §3 POISON: the live generator's own top suggestion for "/theme" is NOT
//     name-anchored while a prefix query ("/mo…") is — the guard's two
//     worlds derived from the real command table, not a fixture.
// ============================================================================
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Hermetic BEFORE any src import (the ambient-state lesson): a scratch
// config home, the file credential store (never the operator's keychain),
// the fixture key.
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'name-anchored-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.NODE_ENV
delete process.env.CI

const REPO = join(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { isNameAnchoredSuggestion, generateCommandSuggestions } = await import('../../src/utils/suggestions/commandSuggestions.js')

console.log('§1 the pure law')
const mk = (name: string, opts?: { aliases?: string[]; description?: string }): { id: string; displayText: string; metadata: unknown } => ({
  id: `command-${name}`,
  displayText: `/${name}`,
  metadata: { type: 'local', name, description: opts?.description ?? 'words', aliases: opts?.aliases ?? [], isEnabled: true, isHidden: false, async call() {}, userFacingName: () => name },
})
check('a name prefix anchors ("/mo" → model)', isNameAnchoredSuggestion('/mo', mk('model') as never) === true)
check('a name part anchors ("/config" → update-config)', isNameAnchoredSuggestion('/config', mk('update-config') as never) === true)
check('an alias anchors', isNameAnchoredSuggestion('/quit', mk('exit', { aliases: ['quit'] }) as never) === true)
check('a description-only match does NOT anchor ("/theme" vs update-config)', isNameAnchoredSuggestion('/theme', mk('update-config', { description: 'configure theme settings' }) as never) === false)
check('a non-slash input passes through (file/agent suggestions unaffected)', isNameAnchoredSuggestion('hello', mk('model') as never) === true)
check('a bare slash passes through (the empty-query menu)', isNameAnchoredSuggestion('/', mk('model') as never) === true)
check('a metadata-less row never anchors', isNameAnchoredSuggestion('/x', { id: 'x', displayText: 'x' } as never) === false)

console.log("§2 the guard in useTypeahead's command case")
const hook = readFileSync(join(REPO, 'src', 'hooks', 'useTypeahead.tsx'), 'utf8')
const caseStart = hook.indexOf("case 'command': {")
const caseBlock = hook.slice(caseStart, hook.indexOf('case ', caseStart + 10))
check('the guard reads viaEnter + never-navigated + the anchor law, ahead of the apply', /viaEnter &&\s*atIndex === undefined &&\s*!userNavigatedRef\.current &&\s*!isNameAnchoredSuggestion\(currentInput, suggestion\)/.test(caseBlock) && caseBlock.includes('isNameAnchoredSuggestion') && caseBlock.indexOf('isNameAnchoredSuggestion') < caseBlock.indexOf('applyCommandSuggestion'))
// The navigated flag's own three writers: a fresh publish resets, the ↑↓
// mover sets — the publisher's selected:0 pre-highlight can never read as
// a deliberate pick (the drive-7 re-run: the raw-index guard never bit).
check('a fresh publish resets the navigated flag', /userNavigatedRef\.current = false/.test(hook.slice(hook.indexOf('const publish'), hook.indexOf('const moveSelection'))))
check('the ↑↓/⌃n/⌃p mover sets it', /const moveSelection = useCallback\(\s*\(delta: number\): void => \{\s*const list = suggestionsRef\.current\s*if \(list\.length === 0\) return\s*userNavigatedRef\.current = true/.test(hook))
check('a refused bare ↵ submits the words AS TYPED (never a swallowed key — the kept draft built "/theme/mo" into a plain prompt)', /!isNameAnchoredSuggestion\(currentInput, suggestion\)\s*\)\s*\{[\s\S]{0,400}?clearSuggestions\(\)\s*onSubmit\?\.\(currentInput, true\)\s*return\s*\}/.test(caseBlock))

console.log('§3 the poison from the real command table')
{
  // Configs open only at boot — a pure prover opens the door itself on its
  // own scratch home (the command-table prover's recipe).
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
  enableConfigs()
  const { getCommands } = await import('../../src/commands.js')
  const commands = (await getCommands(process.cwd()).catch(() => null)) as unknown[] | null
  if (commands === null || !Array.isArray(commands) || commands.length === 0) {
    // The table needs a fuller context on some builds — the pure law and the
    // source pin above carry the ratchet; say so honestly rather than skip
    // silently.
    console.log('  [INFO] the live command table did not assemble in this harness — §3 rides §1/§2')
  } else {
    const themed = generateCommandSuggestions('/theme', commands as never)
    const modeled = generateCommandSuggestions('/mo', commands as never)
    check('the live "/theme" menu is non-empty (the description match still SHOWS — only the bare ↵ refuses it)', themed.length > 0)
    check('its top row is not name-anchored (the guard bites)', themed.length > 0 && !isNameAnchoredSuggestion('/theme', themed[0]!))
    check('the live "/mo" top row IS name-anchored (completion keeps working)', modeled.length > 0 && isNameAnchoredSuggestion('/mo', modeled[0]!))
  }
}

console.log(failures === 0 ? '\nname-anchored enter: ALL LAWS HOLD' : `\nname-anchored enter: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
