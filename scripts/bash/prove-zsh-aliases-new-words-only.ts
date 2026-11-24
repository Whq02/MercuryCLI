#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

if (process.env.MERCURY_ZSH_ALIASES_CHILD !== '1') {
  if (process.platform === 'win32' || !existsSync('/bin/zsh')) {
    console.log('SKIP zsh aliases test requires /bin/zsh on POSIX')
    process.exit(0)
  }
  const scratch = mkdtempSync(join(tmpdir(), 'zsh-aliases-new-words-'))
  const home = join(scratch, 'home')
  const config = join(scratch, 'config')
  mkdirSync(home, { recursive: true })
  mkdirSync(config, { recursive: true })
  writeFileSync(join(home, '.zprofile'), "export FROM_ZPROFILE=carried\nalias hiya='echo hiya from the alias'\n")
  writeFileSync(
    join(home, '.zshrc'),
    [
      "alias hiya='echo hiya from the alias'",
      `alias quoted='echo "it'\\''s here"'`,
      "alias both='echo the zsh one'",
      "alias greet='echo the zsh alias of a bash function'",
      "alias rm='rm -i'",
      "alias ls='echo the alias of ls'",
      "alias cd='echo the alias of cd'",
      "alias time='echo the alias of time'",
      "alias -g G='| cat'",
      'alias -s txt=cat',
      "alias up2='cd ../..'",
      "alias -- -='cd -'",
      '',
    ].join('\n'),
  )
  writeFileSync(join(home, '.bashrc'), "alias bashy='echo from bashrc'\nalias both='echo the bash one'\ngreet() { echo the bash function; }\n")
  writeFileSync(join(home, 'delete-me.txt'), 'a file the agent deletes\n')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    MERCURY_CONFIG_DIR: config,
    SHELL: '/bin/zsh',
    MERCURY_ZSH_ALIASES_CHILD: '1',
    MERCURY_ZSH_ALIASES_SCRATCH: scratch,
  }
  delete env.ZDOTDIR
  delete env.MERCURY_HOME
  try {
    const child = spawnSync(process.execPath, [...process.execArgv, import.meta.path], { stdio: 'inherit', env })
    process.exit(child.status ?? 1)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const state = await import('../../src/boot/process-state/processState.ts')
state.setIsInteractive(false)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { exec } = await import('../../src/platform/shell/shellExec.ts')
const { getMercuryHome } = await import('../../src/platform/environment/envUtils.ts')

const HINT = 'zshLoginFilesRead and the appended alias lines of src/platform/shell/bash/shellSnapshot.ts define an alias only for a word the tool shell does not already know'
let failures = 0
const check = (label: string, good: boolean, detail = ''): void => {
  console.log(`${good ? 'PASS' : 'FAIL'} ${label}${good ? (detail ? ` — ${detail}` : '') : ` — ${[detail, HINT].filter(Boolean).join('; ')}`}`)
  if (!good) failures++
}
const run = async (command: string): Promise<{ out: string; code: number }> => {
  const ran = await exec(command, new AbortController().signal, 'bash', { timeout: 30_000 })
  const result = await ran.result
  ran.cleanup()
  return { out: `${result.stdout ?? ''}`.trim(), code: result.code }
}

const scratchBase = process.env.MERCURY_ZSH_ALIASES_SCRATCH ?? ''
const home = homedir()
check('the run reads a made home, never the real one', scratchBase.length > 0 && home.startsWith(scratchBase), home)

const hiya = await run('hiya')
check("a word of the person's own in the zsh login files runs in the shell tool", hiya.code === 0 && hiya.out === 'hiya from the alias', JSON.stringify(hiya))
const quoted = await run('quoted')
check('an alias whose text holds a quote is carried whole', quoted.code === 0 && quoted.out === "it's here", JSON.stringify(quoted))
const up = await run('alias up2')
check('an alias is carried as its own text', up.code === 0 && up.out.includes('cd ../..'), JSON.stringify(up))
const dash = await run('alias -- -')
check('a word with an odd name (-) is carried too', dash.code === 0 && dash.out.includes('cd -'), JSON.stringify(dash))
const bashy = await run('bashy')
check('an alias of the bash login files runs as before', bashy.code === 0 && bashy.out === 'from bashrc', JSON.stringify(bashy))

const both = await run('both')
check('a name both shells give keeps the bash text: the shell knew it already', both.code === 0 && both.out === 'the bash one', JSON.stringify(both))
const greet = await run('greet')
check('a function of the bash login files is not redefined by a zsh alias of its name', greet.code === 0 && greet.out === 'the bash function', JSON.stringify(greet))
const removed = await run('rm "$HOME/delete-me.txt"; echo status=$?')
check("the person's `alias rm='rm -i'` is not in force: the agent's delete asks nothing and deletes", removed.out === 'status=0' && !existsSync(join(home, 'delete-me.txt')), `${JSON.stringify(removed)} · file still there: ${existsSync(join(home, 'delete-me.txt'))}`)
const listed = await run('ls "$HOME/.zshrc"')
check("the person's alias of ls is not in force: ls lists", listed.code === 0 && listed.out === join(home, '.zshrc'), JSON.stringify(listed))
const known = await run('for n in rm ls cd time greet; do alias "$n" >/dev/null 2>&1 && echo "in force: $n"; done; echo checked')
check('no alias stands for a program (rm, ls), a builtin (cd), a keyword (time) or a function (greet) the shell knows', known.out === 'checked', JSON.stringify(known))

const globalAlias = await run('alias G')
check('a global alias, which bash has no word for, is not carried', globalAlias.code !== 0, JSON.stringify(globalAlias))
const suffix = await run('alias txt')
check('a suffix alias is not carried', suffix.code !== 0, JSON.stringify(suffix))
const exported = await run('echo "$FROM_ZPROFILE"')
check('what the zsh login files export is carried as before', exported.code === 0 && exported.out === 'carried', JSON.stringify(exported))
const rg = await run('command -v rg >/dev/null 2>&1 || type rg >/dev/null 2>&1; echo rg=$?')
check('the search tool answers as before', rg.out === 'rg=0', JSON.stringify(rg))

const dir = join(getMercuryHome(), 'shell-snapshots')
const newest = readdirSync(dir).filter(name => name.endsWith('.sh')).map(name => ({ name, at: statSync(join(dir, name)).mtimeMs })).sort((x, y) => y.at - x.at)[0]
const lines = readFileSync(join(dir, newest?.name ?? ''), 'utf8').split('\n')
const ofHiya = lines.filter(l => l.includes('alias -- hiya='))
check('the snapshot holds the word once, behind the test the running shell makes', ofHiya.length === 1 && (ofHiya[0] ?? '').startsWith("type -- 'hiya' >/dev/null 2>&1 || alias -- hiya="), ofHiya.join(' | ').slice(0, 200))
check("the search tools' guard stands once in the snapshot", lines.filter(l => l === '# Mercury search tools').length === 1, String(lines.filter(l => l === '# Mercury search tools').length))
check('no line of the snapshot names the global or the suffix alias', !lines.some(l => /\balias (-- )?(G|txt)=/.test(l) || /\balias -[gs]\b/.test(l)), '')

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
