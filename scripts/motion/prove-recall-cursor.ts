#!/usr/bin/env bun

import { grabScreens, runArtifactArena } from '../streaming/artifactArena.ts'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

console.log('── recall-cursor law (shipped artifact) ──')

{
  const run = await runArtifactArena({
    turns: [{ kind: 'text', text: 'REPLY-A done.' }],
    sends: [
      'after:Type a prompt:800:alpha one',
      'after:Type a prompt:1800:\\r',
      'after:REPLY-A done.:1500:\\x1b[A',
      'after:REPLY-A done.:2500:ZZ',
    ],
    seconds: 14,
    keep: true,
  })
  const [snap] = grabScreens(run, 120, 40, [-1])
  const rows = snap!.rows
  check('recall-then-type APPENDS (alpha oneZZ)', rows.some(r => r.includes('alpha oneZZ')), rows.filter(r => r.includes('❯') && (r.includes('alpha') || r.includes('ZZ'))).join(' ↵ ').slice(0, 160))
  check('no prepend artifact (ZZalpha one absent)', !rows.some(r => r.includes('ZZalpha one')))
  run.cleanup()
}

{
  const run = await runArtifactArena({
    turns: [
      { kind: 'text', text: 'REPLY-B1 done.' },
      { kind: 'text', text: 'REPLY-B2 done.' },
    ],
    sends: [
      'after:Type a prompt:800:first entry',
      'after:Type a prompt:1800:\\r',
      'after:REPLY-B1 done.:1200:second entry',
      'after:REPLY-B1 done.:2200:\\r',
      'after:REPLY-B2 done.:1500:\\x1b[A',
      'after:REPLY-B2 done.:2300:\\x1b[A',
    ],
    seconds: 16,
    keep: true,
  })
  const [snap] = grabScreens(run, 120, 40, [-1])
  const rows = snap!.rows
  check(
    'the second Up WALKS to the older entry (composer shows it)',
    rows.some(r => r.startsWith('│❯ first entry')),
    rows.filter(r => r.startsWith('│❯')).join(' ↵ ').slice(0, 120),
  )
  run.cleanup()
}

{
  const wide = 'w'.repeat(130)
  const run = await runArtifactArena({
    turns: [{ kind: 'text', text: 'REPLY-C done.' }],
    sends: [
      `after:Type a prompt:800:${wide}`,
      'after:Type a prompt:2200:\\r',
      'after:REPLY-C done.:1500:\\x1b[A',
      'after:REPLY-C done.:2500:QQ',
    ],
    seconds: 14,
    keep: true,
  })
  const [snap] = grabScreens(run, 120, 40, [-1])
  const rows = snap!.rows
  check('a wrapped recall keeps cursor at start (QQwww…)', rows.some(r => r.includes('QQwww')))
  check('no append artifact on the wrapped recall (…wwwQQ absent)', !rows.some(r => r.includes('wwwQQ')))
  run.cleanup()
}

console.log(failures === 0 ? '✅ recall-cursor GREEN' : `❌ recall-cursor RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
