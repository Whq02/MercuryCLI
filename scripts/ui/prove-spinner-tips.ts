#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')

const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-tips-proof-'))
process.env.MERCURY_CONFIG_DIR = SCRATCH

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { getRelevantTips } = await import('../../src/services/tips/tipRegistry.ts')
const { selectTipWithLongestTimeSinceShown } = await import('../../src/services/tips/tipScheduler.ts')
const { stringWidth } = await import('../../src/ink/stringWidth.ts')
const { builtinCommands } = await import('../../src/commands.ts')
const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const BUDGET = 94

const tips = await getRelevantTips()
check('fresh-config read yields the catalogue (≥ 20 tips)', tips.length >= 20, String(tips.length))

const roster = new Set<string>()
for (const cmd of builtinCommands()) {
  if (cmd.isHidden === true || cmd.retired !== undefined) continue
  roster.add(cmd.name)
  for (const alias of cmd.aliases ?? []) roster.add(alias)
}
check('roster read is real (≥ 80 listed names)', roster.size >= 80, String(roster.size))

const bound = new Set<string>()
for (const block of DEFAULT_BINDINGS) for (const key of Object.keys(block.bindings)) bound.add(key.toLowerCase())

function chordsSpelled(line: string): string[] {
  const out: string[] = []
  for (const m of line.matchAll(/\b((?:ctrl|shift|alt|meta|opt|cmd|super)\+[a-z0-9_]+(?: (?=[a-z]\b)[a-z])?)/gi)) {
    out.push(m[1]!.toLowerCase().replace(/^opt\+/, 'meta+'))
  }
  return out
}

const ids = new Set<string>()
const seenCommands = new Set<string>()
const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u
for (const tip of tips) {
  check(`id unique: ${tip.id}`, !ids.has(tip.id))
  ids.add(tip.id)
  check(`cooldown ≥ 5: ${tip.id}`, tip.cooldownSessions >= 5, String(tip.cooldownSessions))

  for (const term of ['Apple_Terminal', 'xterm-program']) {
    const prev = process.env.TERM_PROGRAM
    process.env.TERM_PROGRAM = term
    let rendered = ''
    try {
      for (const theme of ['dark', 'true-black']) {
        rendered = await tip.content({ theme })
        const width = stringWidth(rendered)
        check(
          `width ≤ ${BUDGET} [${tip.id} · ${term === 'Apple_Terminal' ? 'apple' : 'rest'} · ${theme}]`,
          width <= BUDGET,
          `${width}: ${rendered}`,
        )
      }
    } finally {
      if (prev === undefined) delete process.env.TERM_PROGRAM
      else process.env.TERM_PROGRAM = prev
    }
    for (const m of rendered.matchAll(/(?:^|\s)\/([a-z][a-z0-9-]*)/g)) seenCommands.add(m[1]!)
    check(`no exclamation [${tip.id}]`, !/\S!/.test(rendered) && !/!$/.test(rendered), rendered)
    check(`no ellipsis flourish [${tip.id}]`, !rendered.includes('…') && !rendered.includes('...'), rendered)
    check(`no emoji [${tip.id}]`, !emojiRe.test(rendered), rendered)
    check(`no rhetorical question [${tip.id}]`, !rendered.includes('?') || / or /.test(rendered.slice(rendered.indexOf('?'))), rendered)
    const unbound = chordsSpelled(rendered).filter(c => !bound.has(c))
    check(`every chord spelled is a binding [${tip.id}]`, unbound.length === 0, unbound.join(', '))
  }
}
for (const cmd of seenCommands) {
  check(`advertised command is listed: /${cmd}`, roster.has(cmd))
}
check('the loyalty-pinned appearance tip id is present', ids.has('appearance-command'))
check(
  'the catalogue advertises the load-bearing surfaces (spot pins)',
  ['help', 'logins', 'concourse', 'plan', 'resume', 'diff', 'review', 'themis', 'caching', 'rewind', 'remember'].every(c => seenCommands.has(c)),
)
check('the chord parser reads the ctrl+x family whole and never eats the next word', chordsSpelled('ctrl+x s opens it; shift+tab cycles').join(',') === 'ctrl+x s,shift+tab')
check('the mode tip spells a chord the table carries', chordsSpelled(await tips.find(t => t.id === 'cycle-mode')!.content({ theme: 'dark' })).length === 1)

const order = tips.map(t => t.id)
check(
  "the first five tips are the first session's (the mode · /help · the queue · /sessions · the concourse)",
  order.slice(0, 5).join(',') === 'cycle-mode,help-browse,prompt-queue,sessions-switch,concourse-board',
  order.slice(0, 5).join(','),
)
check('on a fresh config the scheduler picks the first lesson', selectTipWithLongestTimeSinceShown(tips)?.id === 'cycle-mode')
check("the depth comes last (skills · powershell are the tail)", order[order.length - 1] === 'skills-location', order.slice(-2).join(','))

const registrySource = readFileSync(join(ROOT, 'src/services/tips/tipRegistry.ts'), 'utf8')
check("the '#'-note tip is retired (no owner in the tree handles a leading #)", !registrySource.includes("id: 'memory-note'"))
check(
  'the powershell tip advertises the product-native spelling',
  registrySource.includes('MERCURY_USE_POWERSHELL_TOOL=1'),
)
check('the newline tip reads the composer\'s own newline owner', registrySource.includes('getNewlineInstructions()'))

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ SPINNER TIPS: every law holds' : `\n❌ ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
