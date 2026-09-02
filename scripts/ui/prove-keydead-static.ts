#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-keydead-static.ts
//  RATCHET:
//  chrome that ADVERTISES a key must have a matching binding IN SCOPE.
//
//  Grammar: hint-rail string literals (contain ' · ' plus a key token) are
//  parsed for the closed token vocabulary — esc · ↵ · tab · ←→/←/→ · ↑↓ ·
//  pgup/pgdn · ± · single-letter verbs ("r respawn", "x kill"). Each advertised
//  token needs, in the SAME file, one of:
//    - an explicit binding tell (key.escape / key.return / key.leftArrow /
//      input === 'r' / ['y','n'].includes(input) / key: 'r' action descriptors)
//    - or coverage by a FRAMEWORK the file renders:
//        <CommandCenter …>   binds esc + ← → onClose (unless captureInput)
//        <NavigablePanes …>  binds ↑↓ ↵ → tab ← ± esc + advertises its own
//                            `key:`-declared action descriptors (label+key are
//                            co-declared, so they cannot drift apart)
//  This is deliberately CRUDER than the semantic audit (existence of a binding,
//  not its per-state gating — state-conditional honesty stays a workflow-audit
//  concern) but it kills the class that shipped: a key advertised with NO
//  handler anywhere (the 'ctrl+t+c' chip, dead-letter footers).
//
//  (introduction): ZERO offenders after the audit's fixes — a
//  zero-allowlist floor. ALLOW entries need a reason naming the real binder.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-keydead-static.ts
// ============================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const TREES = ['src/components', 'src/screens', 'src/commands']

// Per-file, per-token exceptions. Every entry names the OUT-OF-FILE binder.
const ALLOW: Record<string, string> = {
  // 'shift+tab' style modifiers and chord families are handled by the global
  // keybinding layer (defaultBindings.ts), not per-surface useInput — the
  // extractor below deliberately skips multi-key chords, so entries here are
  // only needed for single tokens bound globally:
  'src/components/MercuryFrame.tsx :: tab': 'statusbar hint for the global shift+tab mode carousel (keybindings layer)',
  'src/components/concourse/SessionMirror.tsx :: enter': "the live pane's empty-state note for a ready-to-review newborn — its ↵ is the live box's empty-draft verb (the composer beside it, same region) entering the selected row",
  // Control-note `next` hints ('the draft is kept · ↵ retries', 'edit the
  // task or seeds · ↵ retries') are CONSTRUCTED in ConcourseRoute but
  // rendered and BOUND in the child across the ConcourseCallbacks seam:
  // ConcourseScreen.tsx key.return → callbacks.submitSessionDraft →
  // ConcourseRoute submitDraft, which replays the held clientMessageId
  // (item-8 durable identity) or mints fresh after a terminal refusal.
  'src/components/concourse/ConcourseRoute.tsx :: letter:y':
    'the daemon-start offer (the operator's word): ConcourseScreen routes y/n while daemonOfferArmed → callbacks.answerDaemonOffer (out-of-file binder across the ConcourseCallbacks seam)',
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
// letter-verb: start-or-· boundary, single letter (optionally x/y alternation),
// then a space and a lowercase verb ("r respawn", "↵/i message" handled via ↵ + i).
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

/** Pull hint-rail string literals ('…esc…' + ' · ' separator grammar). */
function hintStrings(text: string): Array<{ line: number; str: string }> {
  const out: Array<{ line: number; str: string }> = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const t = line.trimStart()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue
    for (const m of line.matchAll(/'([^'\\]{3,120})'/g)) {
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
    // 'a'..'z' single-letter verbs; skip articles that read as verbs rarely —
    // the (?= [a-z]) lookahead already requires "letter word" shape.
    tokens.add(`letter:${ch}`)
  }
  return [...tokens]
}

/** A file with NO input mechanism at all is presentational (or a design
 *  specimen): its hint strings render under a PARENT's binder, so in-file
 *  judgment is impossible — the semantic workflow audit owns those. */
export function hasInputMechanism(text: string): boolean {
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

/** True iff SOME `<CommandCenter …>` usage in the file actually binds input
 *  (no literal captureInput={false} in ITS OWN attribute span). Per-surface
 * a whole-file count credited mixed-usage files
 *  whose only LIVE surface was the captureInput-false one — the capturing
 *  usages being empty-state/loading variants. The span walk is brace-aware
 *  so an inline arrow's `=>` can't truncate the tag. Non-literal
 *  captureInput={expr} stays credited: statically undecidable. */
export function commandCenterBindsInput(text: string): boolean {
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

/** True iff SOME `<Select …>` / `<SelectMulti …>` usage in the file passes
 *  an onCancel — the CustomSelect family routes escape through the
 *  rebindable layer to exactly that callback, so the tag span IS the esc
 *  binder (the same per-surface span walk as CommandCenter). */
export function selectBindsCancel(text: string): boolean {
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

function hasBinding(text: string, token: string, file: string): boolean {
  // CommandCenter binds esc + ← ONLY while captureInput (default true) —
  // credited PER SURFACE, never per file (the /keys atlas
  // shipped a dead advertised esc through the whole-file hole).
  const rendersCommandCenter = commandCenterBindsInput(text)
  const rendersSelectWithCancel = selectBindsCancel(text)
  const rendersNavPanes = /<NavigablePanes[\s\n<]/.test(text)
  // useFlatList binds esc/← · ↑↓ · ↵ (+primaryChar) · r-reload inside the hook.
  const usesFlatList = /useFlatList[<(]/.test(text)
  // useSpecimenNav bound esc/← · ↑↓ inside the hook; useInteractiveList (its
  // replacement) binds the same set — actions stay `key:`
  // descriptors ('return' / letters), caught by the descriptor tells below.
  const usesSpecimenNav = /useSpecimenNav[<(]/.test(text) || /useInteractiveList[<(]/.test(text)
  // a surface that decodes through the ONE vocabulary
  // (navSemantics decodeNavKey) binds keys via SEMANTIC actions — the
  // acted-on action name is the binder tell.
  const decodes = /decodeNavKey\(/.test(text)
  const acts = (name: string): boolean =>
    decodes && new RegExp(`(action|rowAxis|effortAxis|tabAxis|scrollAxis|a) === '${name}'`).test(text)
  const isFrameworkSelf = /(components|NavigablePanes|useFlatList)\.tsx?$/.test(file)
  switch (token) {
    case 'esc':
      return (
        acts('cancel') ||
        /key\.escape/.test(text) ||
        // a TextInput onEscape IS an esc binder (the owner gives escape its
        // meaning — a comment composer discards its draft).
        /onEscape=\{/.test(text) ||
        rendersCommandCenter ||
        rendersSelectWithCancel ||
        rendersNavPanes ||
        usesFlatList ||
        usesSpecimenNav ||
        isFrameworkSelf
      )
    case 'enter':
      return (
        acts('activate') ||
        /key\.return/.test(text) ||
        text.includes("key: 'return'") ||
        // a TextInput onSubmit IS an enter binder (TextInput
        // submits on return) — the quick-open/search surfaces bind ↵ this
        // way; their footers became single-quoted (scanned) when the hints
        // went live-composed under the hints-fire law.
        /onSubmit=\{/.test(text) ||
        rendersNavPanes ||
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
        isFrameworkSelf
      )
    case 'arrows-ud':
      return (
        acts('movePrevious') || acts('moveNext') ||
        /key\.(upArrow|downArrow)/.test(text) ||
        rendersNavPanes ||
        usesFlatList ||
        usesSpecimenNav ||
        isFrameworkSelf
      )
    case 'paging':
      return acts('pagePrevious') || acts('pageNext') || /key\.(pageUp|pageDown)/.test(text) || isFrameworkSelf
    case 'plusminus':
      return /['"][+\-]['"]/.test(text) || rendersNavPanes || isFrameworkSelf
    default: {
      const ch = token.slice('letter:'.length)
      if (ch === 'r' && usesFlatList) return true // the hook's built-in reload key
      // input === 'r' | 'r' in an includes-list | key: 'r' action descriptor |
      // a switch case; single OR double quotes.
      const tells = [
        `input === '${ch}'`,
        `input === "${ch}"`,
        `key: '${ch}'`,
        `key: "${ch}"`,
        `case '${ch}'`,
        `'${ch}',`, // includes-array member ('y', 'n')
        `'${ch}']`,
        `input.toLowerCase() === '${ch}'`,
      ]
      if (tells.some(t => text.includes(t))) return true
      // NavigablePanes action descriptors may live in the same file as `key: 'x'`
      // (covered above); a letter with no in-file tell is a defect.
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
