#!/usr/bin/env bun


let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
    console.error('      to fix: the quoting of the resume argument is resumeHintArgument in src/screen/renderer/terminal-session/shutdownRestoration.ts, which calls quoteResumeTitleForShell in src/platform/host-os/words.ts')
  }
}


console.log('§3 SL-7 — resume-hint quoting: bash on POSIX, PS single-quote on win32')
{
  const { resumeHintArgument } = await import('../../src/screen/renderer/terminal-session/shutdownRestoration.ts')
  const title = `the "big" plan\\refit`
  check('POSIX keeps the exact bash-family escapes (byte-identical)', resumeHintArgument(title, 'sid', 'darwin') === `"the \\"big\\" plan\\\\refit"`)
  check("win32 speaks PowerShell's literal (single quotes, '' doubling)", resumeHintArgument(`it's here`, 'sid', 'win32') === `'it''s here'`)
  check('win32 never emits the bash escapes', !resumeHintArgument(title, 'sid', 'win32').includes('\\"'))
  check('no title ⇒ the session id, every host', resumeHintArgument(null, 'sid-9', 'win32') === 'sid-9' && resumeHintArgument('', 'sid-9', 'darwin') === 'sid-9')
  const { spawnSync } = await import('node:child_process')
  for (const live of ['Fix `whoami` lookup', 'Handle $HOME paths', 'Ship it!now', `it's $5 \\ "ok"`]) {
    const arg = resumeHintArgument(live, 'sid', 'darwin')
    const back = spawnSync('bash', ['-c', `printf '%s' ${arg}`], { encoding: 'utf8' })
    check(`POSIX: ${JSON.stringify(live)} reads back exactly, nothing expands`, back.status === 0 && back.stdout === live, JSON.stringify(back.stdout))
  }
}

process.exit(failures === 0 ? 0 : 1)
