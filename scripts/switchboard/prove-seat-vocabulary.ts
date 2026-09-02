#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

const retired = new RegExp('[Mm]ain[- ]' + ['RE', 'PL'].join(''))
const retiredSpaced = new RegExp(['main', 'repl'].join('[ ]'), 'i')

const ESTATE = ['src/components/concourse', 'src/services/concourse'].flatMap(dir =>
  readdirSync(join(process.cwd(), dir))
    .filter(f => /\.(ts|tsx)$/.test(f))
    .map(f => `${dir}/${f}`),
)

{
  const hits: string[] = []
  for (const rel of ESTATE) {
    const lines = read(rel).split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (retired.test(lines[i]!) || retiredSpaced.test(lines[i]!)) hits.push(`${rel}:${i + 1}`)
    }
  }
  check('V1 the retired crumb phrase never returns to the concourse estate (screen text or comment)', hits.length === 0, hits.slice(0, 8).join(' · '))
}

{
  const header = read('src/components/concourse/ConcourseHeader.tsx')
  check('V2 the active crumb reads FOCUSED CHAT', header.includes('<Text bold color={t.info}>FOCUSED CHAT</Text>'))
  check("V2 the clickable crumb reads FOCUSED CHAT (the id 'main-repl' stays a contract key)", header.includes("dest('main-repl', 'FOCUSED CHAT', onMainRepl)"))
  check('V2 the narrow bypass crumb reads FOCUSED CHAT ›', header.includes('FOCUSED CHAT ›'))
}

{
  const manifest = read('src/components/concourse/controlManifest.ts')
  check("V3 the manifest's esc row reads 'focused chat'", manifest.includes("{ keys: 'esc', label: 'focused chat' }"))
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  check("V3 the too-small screen returns to 'the focused chat'", layout.includes('esc returns to the focused chat'))
  const route = read('src/components/concourse/ConcourseRoute.tsx')
  check("V3 the assembling shell's esc names the focused chat (both faces)", route.includes("const escLabel = chatPresent() ? 'esc focused chat' : 'esc boot face'") && route.includes("keyHintLabel('⌃r')} retry · ${escLabel}") && route.includes('{escLabel}</Text>'))
}

{
  const snap = read('src/services/concourse/concourseSnapshot.ts')
  check('V4 the board carries no own-session row (one kind of session; the boot chat is an ordinary row)', !snap.includes('the session you started at boot') && !snap.includes('ownSession'))
}

{
  const upper = ['MAIN', 'REPL'].join(' ')
  const hyphenProse = ['main-RE', 'PL'].join('')
  const spacedLower = ['main', 'repl'].join(' ')
  check('V5 poison: the uppercase crumb form trips the needle', retired.test(`<Text>${upper}</Text>`) || retiredSpaced.test(upper))
  check('V5 poison: the hyphen prose form (main-REPL) trips it', retired.test(`the managed ${hyphenProse} row`))
  check('V5 poison: the spaced lowercase prose form trips it', retiredSpaced.test(`esc ${spacedLower}`))
  const id = "id: 'concourse:crumb:" + ['main-re', 'pl'].join('') + "'"
  check("V5 the contract id stays legal (no false fire on the lowercase hyphen id)", !retired.test(id) && !retiredSpaced.test(id))
}

console.log(failures === 0 ? '\nprove-seat-vocabulary: ALL LAWS HOLD' : `\nprove-seat-vocabulary: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
