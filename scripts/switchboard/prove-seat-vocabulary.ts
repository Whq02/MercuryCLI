#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
  check('V2 the board paints no crumb (the top panel is gone); FOCUSED CHAT still reads where the chat shows on the board — the split chat pane title', !existsSync(join(process.cwd(), 'src/components/concourse/ConcourseHeader.tsx')) && read('src/components/concourse/SplitChatPane.tsx').includes('        FOCUSED CHAT\n'))
}

{
  const manifest = read('src/components/concourse/controlManifest.ts')
  check("V3 the manifest's esc row reads 'focused chat'", manifest.includes("{ keys: 'esc', label: 'focused chat' }"))
  const route = read('src/components/concourse/ConcourseRoute.tsx')
  check("V3 the assembling shell's esc names the focused chat (both faces)", route.includes("const escLabel = chatPresent() ? 'esc focused chat' : 'esc boot face'") && route.includes("keyHintLabel('⌃r')} retry · ${escLabel}") && route.includes('{escLabel}</Text>'))
}

{
  const snap = read('src/services/concourse/concourseSnapshot.ts')
  check('V4 the board carries no own-session row (one kind of session; the boot chat is an ordinary row)', !snap.includes('the session you started at boot') && !snap.includes('ownSession'))
}

{
  const upper = ['MAIN', ['RE', 'PL'].join('')].join(' ')
  const hyphenProse = ['main-RE', 'PL'].join('')
  const spacedLower = ['main', 'repl'].join(' ')
  check('V5 poison: the uppercase crumb form trips the needle', retired.test(`<Text>${upper}</Text>`) || retiredSpaced.test(upper))
  check('V5 poison: the hyphen prose form trips it', retired.test(`the managed ${hyphenProse} row`))
  check('V5 poison: the spaced lowercase prose form trips it', retiredSpaced.test(`esc ${spacedLower}`))
  const id = "id: 'concourse:crumb:" + ['main-re', 'pl'].join('') + "'"
  check("V5 the contract id stays legal (no false fire on the lowercase hyphen id)", !retired.test(id) && !retiredSpaced.test(id))
}

console.log(failures === 0 ? '\nprove-seat-vocabulary: ALL LAWS HOLD' : `\nprove-seat-vocabulary: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
