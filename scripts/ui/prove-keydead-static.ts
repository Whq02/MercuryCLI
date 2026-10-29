#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const TREES = ['src/components', 'src/screens', 'src/commands']

const ALLOW: Record<string, string> = {

  'src/components/MercuryFrame.tsx :: tab': 'statusbar hint for the global shift+tab mode carousel (keybindings layer)',
  'src/components/concourse/SessionMirror.tsx :: enter': "the live pane's empty-state note for a ready-to-review newborn — its ↵ is the live box's empty-draft verb (the composer beside it, same region) entering the selected row",

  'src/components/concourse/ConcourseRoute.tsx :: letter:y':
    'the daemon-start offer (the operator\'s word): ConcourseScreen routes y/n while daemonOfferArmed → callbacks.answerDaemonOffer (out-of-file binder across the ConcourseCallbacks seam)',
  'src/components/concourse/ConcourseRoute.tsx :: letter:n':
    'the daemon-start offer: same ConcourseScreen y/n routing → callbacks.answerDaemonOffer (out-of-file binder)',
  'src/components/concourse/ConcourseRoute.tsx :: enter':
    'ConcourseScreen.tsx key.return → callbacks.submitSessionDraft (out-of-file binder across the ConcourseCallbacks seam)',
  'src/components/concourse/ConcourseRoute.tsx :: arrows-lr':
    'the enter-while-attached refusal names ⇧← — bound in the attached session\'s tag bar (SwitchboardTagBar.tsx requestLeave), the surface the note sends the operator to',
}

interface Site {
  file: string
  line: number
  token: string
  hint: string
}

const KEY_TOKEN_HINT = /esc|↵|↑↓|←|→|tab\b|pg(up|dn)|±/

const LETTER_VERB = /(?:^|· |\/)([a-z])(?= [a-z])/g

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const s = statSync(p)
    if (s.isDirectory()) {
      if (e === 'node_modules' || e === '__snapshots__') continue
      walk(p, out)
    } else if (p.endsWith('.tsx')) {
      out.push(p)
    }
  }
}

function hintStrings(text: string): Array<{ line: number; str: string }> {
  const out: Array<{ line: number; str: string }> = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const t = line.trimStart()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue
    for (const m of line.matchAll(/(?<!\\)'((?:[^'\\]|\\.){3,120})'/g)) {
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
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' keydead-static — advertised keys must have a binder in scope')
console.log('============================================================')

check('semantic paging follows the decoded variable, not a fixed variable-name list', ['nav', 'navigation', 'pageAction'].every(name => hasBinding(`const ${name} = decodeNavKey(input, key, { pageKeys: true }); if (${name} === 'pageNext') scroll();`, 'paging', 'fixture.tsx')))
check('a decoded navigation value without a paging arm does not bind paging', !hasBinding("const nav = decodeNavKey(input, key); if (nav === 'moveNext') move();", 'paging', 'fixture.tsx'))
check('a paging comparison on another value cannot borrow the decoder binding', !hasBinding("const nav = decodeNavKey(input, key); if (other === 'pageNext') scroll();", 'paging', 'fixture.tsx'))
const consoleOAuth = readFileSync(join(ROOT, 'src/components/ConsoleOAuthFlow.tsx'), 'utf8')
check('ConsoleOAuthFlow binds plain s on its menu to the sign-in-later callback', consoleOAuth.includes("if (input === 's' && !key.ctrl && !key.meta && !key.shift) {\n        event.stopImmediatePropagation()\n        startFamily(SIGN_IN_LATER_ROW.value)") && consoleOAuth.includes('{ isActive: menuUp && onSkip !== undefined }') && /if \(value === SIGN_IN_LATER_ROW\.value\) \{[^}]*onSkip\?\.\(\)/.test(consoleOAuth))
check('a ConsoleOAuthFlow onSkip callback binds the advertised s through the child', hasBinding('<ConsoleOAuthFlow onDone={() => done()} onSkip={advance} />', 'letter:s', 'fixture.tsx'))
check('a ConsoleOAuthFlow without onSkip cannot claim the skip key', !hasBinding('<ConsoleOAuthFlow onDone={done} />', 'letter:s', 'fixture.tsx'))
check('another component cannot lend its onSkip callback to ConsoleOAuthFlow', !hasBinding('<ConsoleOAuthFlow onDone={done} /><Other onSkip={advance} />', 'letter:s', 'fixture.tsx'))
check('a similarly named component cannot claim the ConsoleOAuthFlow binding', !hasBinding('<ConsoleOAuthFlowOther onSkip={advance} />', 'letter:s', 'fixture.tsx'))
const files: string[] = []
for (const t of TREES) walk(join(ROOT, t), files)

const offenders: Site[] = []
let sites = 0
let presentationalSkipped = 0
for (const abs of files) {
  const rel = relative(ROOT, abs).split('\\').join('/')
  const text = readFileSync(abs, 'utf8')
  const bindsInput = hasInputMechanism(text)
  for (const { line, str } of hintStrings(text)) {
    if (!bindsInput) {
      presentationalSkipped++
      continue
    }
    for (const token of extractTokens(str)) {
      sites++
      if (ALLOW[`${rel} :: ${token === 'tab' ? 'tab' : token}`]) continue
      if (!hasBinding(text, token, rel)) {
        offenders.push({ file: rel, line, token, hint: str.slice(0, 60) })
      }
    }
  }
}

check(
  `every advertised key token has a binder in scope (${sites} sites scanned; ${presentationalSkipped} presentational hint-rails skipped — parent-bound, workflow-audit turf)`,
  offenders.length === 0,
  offenders.length
    ? `offenders:\n      - ${offenders.map(o => `${o.file}:${o.line} [${o.token}] "${o.hint}"`).join('\n      - ')}`
    : 'clean',
)

console.log(failures === 0 ? '\nALL keydead-STATIC PROOFS PASS' : `\n${failures} PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
