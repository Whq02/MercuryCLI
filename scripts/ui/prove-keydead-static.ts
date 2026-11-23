#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { doorUnits } from '../lib/doorUnits.ts'
import { mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.ts'

const ROOT = join(import.meta.dir, '..', '..')
const TREES = ['src']

const ALLOW: Record<string, string> = {
  'src/screen/concourse/session-mirror/sessionMirrorView.tsx :: enter': "the live pane's empty-state note for a ready-to-review newborn — its ↵ is the live box's empty-draft verb (the composer beside it, same region) entering the selected row",
  'src/screen/concourse/route/useConcourseDraftDispatch.ts :: letter:y':
    'the daemon-start offer (the operator\'s word): ConcourseScreen routes y/n while daemonOfferArmed → callbacks.answerDaemonOffer (out-of-file binder across the ConcourseCallbacks seam)',
  'src/screen/concourse/route/useConcourseDraftDispatch.ts :: letter:n':
    'the daemon-start offer: same ConcourseScreen y/n routing → callbacks.answerDaemonOffer (out-of-file binder)',
  'src/screen/concourse/route/useConcourseDraftDispatch.ts :: enter':
    'ConcourseScreen.tsx key.return → callbacks.submitSessionDraft (out-of-file binder across the ConcourseCallbacks seam)',
  'src/screen/concourse/route/receipts.ts :: enter':
    'ConcourseScreen.tsx key.return → callbacks.submitSessionDraft (out-of-file binder across the ConcourseCallbacks seam)',
  'src/screen/widgets/parity/accountRows.tsx :: enter':
    'AccountView.tsx hands its useInteractiveList the return action for the rows this file draws (out-of-file binder in the door)',
  'src/screen/agents/studio/AgentStudio.tsx :: letter:o':
    'agents/studio/agentStudioParts.tsx opens the row in the editor on o (out-of-file binder in the part)',
  'src/screen/agents/studio/AgentStudio.tsx :: tab':
    'agents/studio/agentStudioParts.tsx widens the scope on key.tab (out-of-file binder in the part)',
}

interface Site {
  file: string
  line: number
  token: string
  hint: string
}

const KEY_TOKEN_HINT = /esc|↵|↑↓|←|→|tab\b|pg(up|dn)|±/
const LETTER_VERB = /(?:^|· |\/)([a-z])(?= [a-z])/g

function hintStrings(text: string): Array<{ line: number; str: string }> {
  const out: Array<{ line: number; str: string }> = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const t = line.trimStart()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue
    for (const m of line.matchAll(/(?<![\\\w])'((?:[^'\\]|\\.){3,120})'/g)) {
      const s = m[1]!
      if (!s.includes(' · ')) continue
      if (!KEY_TOKEN_HINT.test(s) && !/(?:^|· )[a-z] [a-z]/.test(s)) continue
      out.push({ line: i + 1, str: s })
    }
  }
  return out
}

function extractTokens(hint: string): string[] {
  const tokens = new Set<string>()
  if (/\besc\b/.test(hint)) tokens.add('esc')
  if (hint.includes('↵')) tokens.add('enter')
  if (/\btab\b/.test(hint)) tokens.add('tab')
  if (hint.includes('←') || hint.includes('→')) tokens.add('arrows-lr')
  if (hint.includes('↑↓')) tokens.add('arrows-ud')
  if (/pg(up|dn)/i.test(hint)) tokens.add('paging')
  if (hint.includes('±') || / \+\/- /.test(hint)) tokens.add('plusminus')
  for (const m of hint.matchAll(LETTER_VERB)) {
    const ch = m[1]!
    tokens.add(`letter:${ch}`)
  }
  return [...tokens]
}

function hasInputMechanism(text: string): boolean {
  return (
    /useInput\(/.test(text) ||
    /useSpecimenNav[<(]/.test(text) ||
    /useInteractiveList[<(]/.test(text) ||
    /useFlatList[<(]/.test(text) ||
    /useNavigablePanes[<(]/.test(text) ||
    /<CommandCenter[\s\n]/.test(text) ||
    /<NavigablePanes[\s\n<]/.test(text)
  )
}

function commandCenterBindsInput(text: string): boolean {
  let i = text.indexOf('<CommandCenter')
  while (i >= 0) {
    let depth = 0
    let j = i
    for (; j < text.length; j++) {
      const ch = text[j]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      else if (ch === '>' && depth === 0) break
    }
    const span = text.slice(i, j)
    if (!span.includes('captureInput={false}')) return true
    i = text.indexOf('<CommandCenter', j)
  }
  return false
}

function selectBindsCancel(text: string): boolean {
  for (const tag of ['<Select', '<SelectMulti']) {
    let i = text.indexOf(tag)
    while (i >= 0) {
      let depth = 0
      let j = i
      for (; j < text.length; j++) {
        const ch = text[j]
        if (ch === '{') depth++
        else if (ch === '}') depth--
        else if (ch === '>' && depth === 0) break
      }
      const span = text.slice(i, j)
      if (/^<Select(Multi)?[\s\n]/.test(span) && span.includes('onCancel={')) return true
      i = text.indexOf(tag, j)
    }
  }
  return false
}

function consoleOAuthBindsSkip(text: string): boolean {
  let i = text.indexOf('<ConsoleOAuthFlow')
  while (i >= 0) {
    let depth = 0
    let j = i
    for (; j < text.length; j++) {
      const ch = text[j]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      else if (ch === '>' && depth === 0) break
    }
    const span = text.slice(i, j)
    if (/^<ConsoleOAuthFlow[\s\n]/.test(span) && span.includes('onSkip={')) return true
    i = text.indexOf('<ConsoleOAuthFlow', j)
  }
  return false
}

function hasBinding(text: string, token: string, file: string): boolean {
  const rendersCommandCenter = commandCenterBindsInput(text)
  const rendersSelectWithCancel = selectBindsCancel(text)
  const rendersNavPanes = /<NavigablePanes[\s\n<]/.test(text)
  const usesFlatList = /useFlatList[<(]/.test(text)
  const usesSpecimenNav = /useSpecimenNav[<(]/.test(text) || /useInteractiveList[<(]/.test(text)
  const decodedNames = [...text.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*decodeNavKey\(/g)].map(match => match[1]!)
  const acts = (name: string): boolean =>
    decodedNames.some(variable => new RegExp(`\\b${variable.replaceAll('$', '\\$')}\\s*===\\s*['\"]${name}['\"]`).test(text))
  const isFrameworkSelf = /(components|NavigablePanes|useFlatList|popup-list)\.tsx?$/.test(file)
  const usesPopupListNavigation = /usePopupListNavigation\(/.test(text) || /popupListMotion\(/.test(text)
  const usesPopupListPaging = usesPopupListNavigation || /usePopupListPaging\(/.test(text)
  const rendersSelect = /<Select(Multi)?[\s\n]/.test(text)
  const hintsThroughSettingsShell = /[Ff]rame\??\.setHint\(/.test(text)
  const underTabHeader = /useTabHeaderFocus\(/.test(text)
  switch (token) {
    case 'esc':
      return (
        acts('cancel') ||
        /key\.escape/.test(text) ||
        /onEscape=\{/.test(text) ||
        rendersCommandCenter ||
        rendersSelectWithCancel ||
        rendersNavPanes ||
        usesFlatList ||
        usesSpecimenNav ||
        hintsThroughSettingsShell ||
        isFrameworkSelf
      )
    case 'enter':
      return (
        acts('activate') ||
        /key\.return/.test(text) ||
        text.includes("key: 'return'") ||
        /onSubmit=\{/.test(text) ||
        rendersNavPanes ||
        rendersSelect ||
        usesFlatList ||
        isFrameworkSelf
      )
    case 'tab':
      return /key\.tab/.test(text) || rendersNavPanes || isFrameworkSelf
    case 'arrows-lr':
      return (
        acts('moveLeft') || acts('moveRight') || acts('leaveChild') || acts('enterChild') ||
        /key\.(leftArrow|rightArrow)/.test(text) ||
        rendersCommandCenter ||
        rendersNavPanes ||
        usesFlatList ||
        underTabHeader ||
        isFrameworkSelf
      )
    case 'arrows-ud':
      return (
        acts('movePrevious') || acts('moveNext') ||
        /key\.(upArrow|downArrow)/.test(text) ||
        rendersNavPanes ||
        rendersSelect ||
        usesFlatList ||
        usesSpecimenNav ||
        usesPopupListNavigation ||
        isFrameworkSelf
      )
    case 'paging':
      return (
        acts('pagePrevious') || acts('pageNext') ||
        /key\.(pageUp|pageDown)/.test(text) ||
        rendersCommandCenter ||
        rendersSelect ||
        usesSpecimenNav ||
        usesPopupListPaging ||
        isFrameworkSelf
      )
    case 'plusminus':
      return /['"][+\-]['"]/.test(text) || rendersNavPanes || isFrameworkSelf
    default: {
      const ch = token.slice('letter:'.length)
      if (ch === 's' && consoleOAuthBindsSkip(text)) return true
      if (ch === 'r' && usesFlatList) return true
      const tells = [
        `input === '${ch}'`,
        `input === "${ch}"`,
        `key: '${ch}'`,
        `key: "${ch}"`,
        `case '${ch}'`,
        `'${ch}',`,
        `'${ch}']`,
        `input.toLowerCase() === '${ch}'`,
      ]
      if (tells.some(t => text.includes(t))) return true
      return false
    }
  }
}

let failures = 0
function check(label: string, cond: boolean, detail = '', fixHint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && fixHint ? ` — ${fixHint}` : ''}`)
}

console.log('============================================================')
console.log(' keydead-static — advertised keys must have a binder in scope')
console.log('============================================================')

check('semantic paging follows the decoded variable, not a fixed variable-name list', ['nav', 'navigation', 'pageAction'].every(name => hasBinding(`const ${name} = decodeNavKey(input, key, { pageKeys: true }); if (${name} === 'pageNext') scroll();`, 'paging', 'fixture.tsx')), '', 'change the acts and paging case of hasBinding in scripts/ui/prove-keydead-static.ts so the paging token follows the variable assigned from decodeNavKey')
check('a decoded navigation value without a paging arm does not bind paging', !hasBinding("const nav = decodeNavKey(input, key); if (nav === 'moveNext') move();", 'paging', 'fixture.tsx'), '', 'change the paging case of hasBinding in scripts/ui/prove-keydead-static.ts so a decoded value without a pageNext or pagePrevious arm does not bind paging')
check('a paging comparison on another value cannot borrow the decoder binding', !hasBinding("const nav = decodeNavKey(input, key); if (other === 'pageNext') scroll();", 'paging', 'fixture.tsx'), '', 'change the acts helper of hasBinding in scripts/ui/prove-keydead-static.ts so it matches only variables assigned from decodeNavKey')
{
  const scratchHome = pinScratchHome('keydead-console-oauth')
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  const React = await import('react')
  const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
  const { ConsoleOAuthFlow } = await import('../../src/models/sign-in/flow-cards/SignInFlow.js')
  let skipped = 0
  let done = 0
  const mounted = await mountOffscreen(
    React.createElement(
      AppStateProvider as never,
      {},
      React.createElement(ConsoleOAuthFlow as never, {
        onDone: () => {
          done++
        },
        onSkip: () => {
          skipped++
        },
      }),
    ),
    120,
    40,
  )
  try {
    const rendered = await waitFor(() => mounted.screen().includes('Sign in'), 4000)
    mounted.push('S')
    await settle(100)
    mounted.push('\x13')
    await settle(100)
    const ignoredModified = skipped === 0
    mounted.push('s')
    const fired = await waitFor(() => skipped === 1, 2000)
    check('ConsoleOAuthFlow binds plain s on its menu to the sign-in-later callback', rendered && ignoredModified && fired && skipped === 1 && done === 0, `rendered=${rendered} ignoredModified=${ignoredModified} skipped=${skipped} done=${done}`, 'change the plain s binding of the sign-in menu in src/models/sign-in/flow-cards/SignInFlow.tsx so it calls onSkip once, ignores a modified s, and never calls onDone')
  } finally {
    mounted.unmount()
    await releaseScratchHome(scratchHome)
  }
}
check('a ConsoleOAuthFlow onSkip callback binds the advertised s through the child', hasBinding('<ConsoleOAuthFlow onDone={() => done()} onSkip={advance} />', 'letter:s', 'fixture.tsx'), '', 'change consoleOAuthBindsSkip and the letter case of hasBinding in scripts/ui/prove-keydead-static.ts so an onSkip prop on ConsoleOAuthFlow binds s')
check('a ConsoleOAuthFlow without onSkip cannot claim the skip key', !hasBinding('<ConsoleOAuthFlow onDone={done} />', 'letter:s', 'fixture.tsx'), '', 'change consoleOAuthBindsSkip in scripts/ui/prove-keydead-static.ts so a ConsoleOAuthFlow tag without onSkip does not bind s')
check('another component cannot lend its onSkip callback to ConsoleOAuthFlow', !hasBinding('<ConsoleOAuthFlow onDone={done} /><Other onSkip={advance} />', 'letter:s', 'fixture.tsx'), '', 'change consoleOAuthBindsSkip in scripts/ui/prove-keydead-static.ts so it reads onSkip only inside the ConsoleOAuthFlow tag span')
check('a similarly named component cannot claim the ConsoleOAuthFlow binding', !hasBinding('<ConsoleOAuthFlowOther onSkip={advance} />', 'letter:s', 'fixture.tsx'), '', 'change consoleOAuthBindsSkip in scripts/ui/prove-keydead-static.ts so only the exact ConsoleOAuthFlow tag name counts')
check("an apostrophe inside a word opens no string: prose like Mercury's in a template literal is never read as a hint rail", hintStrings("  warning: `a local model for Mercury's own small jobs whatever the main model · ${choices.filter(choice => choice.size !== 'off')}`,").length === 0 && hintStrings("  hint: 'esc back · s skips',").length === 1, '', 'change the quote pattern in hintStrings in scripts/ui/prove-keydead-static.ts so an apostrophe inside a word opens no string while a quoted rail is still read')
const units = doorUnits(ROOT, 'src', TREES)

const offenders: Site[] = []
const allowed = new Set<string>()
let sites = 0
let presentationalSkipped = 0
let heads = 0
let parts = 0
for (const head of units.heads) {
  const members = [head, ...units.partsOf(head)]
  if (!members.some(member => member.endsWith('.tsx'))) continue
  heads++
  parts += members.length - 1
  const texts = members.map(member => readFileSync(join(ROOT, member), 'utf8'))
  const whole = texts.join('\n')
  const bindsInput = hasInputMechanism(whole)
  members.forEach((rel, at) => {
    for (const { line, str } of hintStrings(texts[at]!)) {
      if (!bindsInput) {
        presentationalSkipped++
        continue
      }
      for (const token of extractTokens(str)) {
        sites++
        const row = `${rel} :: ${token}`
        if (ALLOW[row]) {
          if (!hasBinding(whole, token, rel)) allowed.add(row)
          continue
        }
        if (!hasBinding(whole, token, rel)) {
          offenders.push({ file: rel, line, token, hint: str.slice(0, 60) })
        }
      }
    }
  })
}

check(
  `every advertised key token has a binder in scope, a door read with its parts (${sites} sites scanned in ${heads} files and ${parts} parts; ${presentationalSkipped} presentational hint-rails skipped — parent-bound, workflow-audit turf)`,
  offenders.length === 0,
  offenders.length
    ? `offenders:\n      - ${offenders.map(o => `${o.file}:${o.line} [${o.token}] "${o.hint}"`).join('\n      - ')}`
    : 'clean',
  'bind each listed key in the listed file (or its parts), or remove it from that hint string; add an ALLOW row in scripts/ui/prove-keydead-static.ts only when the binder lives out of file',
)

const unmet = Object.keys(ALLOW).filter(row => !allowed.has(row))
check('every allowed row stands for a hint the scan meets and finds no binder for', unmet.length === 0, unmet.length ? `rows to take out of ALLOW:\n      - ${unmet.join('\n      - ')}` : 'clean', 'delete the listed rows from ALLOW in scripts/ui/prove-keydead-static.ts, since the scan now finds a binder for them or no longer meets the hint')

console.log(failures === 0 ? '\nALL keydead-STATIC PROOFS PASS' : `\n${failures} PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
