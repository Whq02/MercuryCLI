#!/usr/bin/env bun
import { plugin } from 'bun'
import '../lib/hermetic.ts'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})

const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-output-filter-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'config')
process.env.MERCURY_TMPDIR = join(SCRATCH, 'tmp')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })
delete process.env.MERCURY_SHELL_ENGINE
delete process.env.MERCURY_SHELL_MAX_OUTPUT
if (!(process.env.SHELL ?? '').includes('bash') && existsSync('/bin/bash')) process.env.SHELL = '/bin/bash'

let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { filterShellOutput, isShellOutputFilterOn, outputFilterFooter, SHELL_OUTPUT_FILTER_SETTING } = await import('../../src/utils/shell/outputFilter.ts')
const settingsRoad = await import('../../src/utils/settings/settings.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')

function setFilterKey(value: boolean | null): void {
  const path = settingsRoad.getSettingsFilePathForSource('userSettings')!
  if (value === null) rmSync(path, { force: true })
  else {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ shell: { filterOutput: value } }, null, 2))
  }
  resetSettingsCache()
}

section('§1 the filter itself: progress redraws collapse to their last line, install chatter goes, repeated lines fold, errors and plain lines stay')
{
  const bar = 'Downloading [===>      ] 30%\rDownloading [======>   ] 60%\rDownloading [==========] 100%\nDone.\n'
  const progress = filterShellOutput(bar)
  check('a carriage-return progress bar keeps only its final state', progress.text === 'Downloading [==========] 100%\nDone.\n' && progress.leftOut.progress === 2, JSON.stringify(progress))
  const npm = ['npm WARN deprecated inflight@1.0.6: This module is not supported', 'npm WARN deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported', 'added 212 packages, and audited 213 packages in 4s', '31 packages are looking for funding', '  run `npm fund` for details', 'found 0 vulnerabilities', 'npm ERR! code ELIFECYCLE', 'Build finished in 3.2s'].join('\n')
  const npmOut = filterShellOutput(npm)
  check('npm install chatter is dropped, the error line and the build line stay', npmOut.text === 'npm ERR! code ELIFECYCLE\nBuild finished in 3.2s' && npmOut.leftOut.noise === 6, JSON.stringify(npmOut))
  const pip = ['Collecting requests', '  Downloading requests-2.32.3-py3-none-any.whl (64 kB)', 'Requirement already satisfied: idna<4,>=2.5 in ./venv/lib/python3.12/site-packages (from requests) (3.7)', 'Installing collected packages: requests', 'Successfully installed requests-2.32.3'].join('\n')
  const pipOut = filterShellOutput(pip)
  check('pip chatter is dropped and the success line stays', pipOut.text === 'Successfully installed requests-2.32.3' && pipOut.leftOut.noise === 4, JSON.stringify(pipOut))
  const cargo = ['    Updating crates.io index', '   Compiling serde v1.0.210', '   Compiling tokio v1.40.0', '    Finished `dev` profile [unoptimized + debuginfo] target(s) in 12.40s'].join('\n')
  const cargoOut = filterShellOutput(cargo)
  check('cargo compile lines are dropped and the finish line stays', cargoOut.text === '    Finished `dev` profile [unoptimized + debuginfo] target(s) in 12.40s' && cargoOut.leftOut.noise === 3, JSON.stringify(cargoOut))
  const apt = ['Get:1 http://deb.debian.org/debian bookworm InRelease [151 kB]', 'Reading package lists...', 'Building dependency tree...', 'Setting up curl (7.88.1-10+deb12u8) ...', 'E: Unable to locate package nothing-here'].join('\n')
  const aptOut = filterShellOutput(apt)
  check('apt chatter is dropped and the error line stays', aptOut.text === 'E: Unable to locate package nothing-here' && aptOut.leftOut.noise === 4, JSON.stringify(aptOut))
  const docker = ['latest: Pulling from library/alpine', 'da9db072f522: Pulling fs layer', 'da9db072f522: Downloading [=====>   ] 1.2MB/3.4MB', 'da9db072f522: Download complete', 'da9db072f522: Pull complete', 'Digest: sha256:abc', 'Status: Downloaded newer image for alpine:latest'].join('\n')
  const dockerOut = filterShellOutput(docker)
  check('a docker pull leaves its first line', dockerOut.text === 'latest: Pulling from library/alpine' && dockerOut.leftOut.noise === 6, JSON.stringify(dockerOut))
  const git = ['Cloning into \'repo\'...', 'remote: Enumerating objects: 120, done.', 'remote: Counting objects: 100% (120/120), done.', 'Receiving objects: 100% (120/120), 1.2 MiB | 4.0 MiB/s, done.', 'Resolving deltas: 100% (40/40), done.'].join('\n')
  const gitOut = filterShellOutput(git)
  check('a git clone leaves its first line (its percentage lines read as progress, the rest as chatter)', gitOut.text === 'Cloning into \'repo\'...' && gitOut.leftOut.progress + gitOut.leftOut.noise === 4, JSON.stringify(gitOut))
  const repeats = ['warning: unused import', 'warning: unused import', 'warning: unused import', 'warning: unused import', 'ok', 'ok', 'done'].join('\n')
  const repeated = filterShellOutput(repeats)
  check('a run of four identical lines folds to one with its count; a pair stays as it was', repeated.text === 'warning: unused import  [repeated 4 times]\nok\nok\ndone' && repeated.leftOut.repeats === 1, JSON.stringify(repeated))
  const clean = 'src/a.ts\nsrc/b.ts\nTests: 3 passed\n'
  const untouched = filterShellOutput(clean)
  check('an output with nothing to filter comes back unchanged, the same string', untouched.text === clean && untouched.changed === false && untouched.leftOut.progress + untouched.leftOut.noise + untouched.leftOut.repeats === 0)
  const failing = 'Compiling app v0.1.0\nerror[E0425]: cannot find value `x` in this scope\n  --> src/main.rs:2:5\nerror: could not compile `app`'
  const kept = filterShellOutput(failing)
  check('compiler errors are never dropped', kept.text.includes('error[E0425]') && kept.text.includes('could not compile'), kept.text)
  check('a percentage inside an error line is not a progress redraw', filterShellOutput('error: 50% of the tests failed\nerror: 60% of the tests failed').changed === false)
  const footer = outputFilterFooter({ progress: 2, noise: 6, repeats: 1 }, '/tmp/x/raw.output')
  check('the footer names the setting, what was left out and the raw file', footer === `[${SHELL_OUTPUT_FILTER_SETTING}: 2 progress redraws, 6 install lines and 1 run of repeated lines left out; the raw output is kept at /tmp/x/raw.output]`, footer)
  check('the footer without a file names only the counts', outputFilterFooter({ progress: 1, noise: 0, repeats: 0 }, undefined) === `[${SHELL_OUTPUT_FILTER_SETTING}: 1 progress redraw left out]`)
  check('the setting is spelled shell.filterOutput', SHELL_OUTPUT_FILTER_SETTING === 'shell.filterOutput')
}

const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { formatError } = await import('../../src/utils/toolErrors.ts')
let appState = getDefaultAppState()
const toolContext = {
  options: { engineModel: 'claude-sonnet-5', tools: [], commands: [], mcpClients: [], mcpResources: {} },
  readFileState: new Map(),
  getAppState: () => appState,
  setAppState: (update: (state: typeof appState) => typeof appState) => { appState = update(appState) },
  abortController: new AbortController(),
  toolUseId: 'output-filter-call',
} as never

const NOISY = `printf 'Downloading [===>      ] 30%%\\rDownloading [======>   ] 60%%\\rDownloading [==========] 100%%\\n'; printf 'npm WARN deprecated left-pad@1.0.0: use String.prototype.padStart\\n'; printf 'added 3 packages in 1s\\n'; for i in 1 2 3 4; do printf 'same line\\n'; done; printf 'Build finished\\n'`
const CLEAN = `printf 'src/a.ts\\nsrc/b.ts\\nTests: 3 passed\\n'`
async function run(command: string): Promise<string> {
  const result = await BashTool.call({ command }, toolContext)
  return String(BashTool.mapToolResultToToolResultBlockParam(result.data, 'x').content)
}

section('§2 off by default: with no setting the model reads the output whole — the raw lines, no footer')
{
  setFilterKey(null)
  check('the setting reads off with no settings file', isShellOutputFilterOn() === false)
  const text = await run(NOISY)
  check('the progress redraws, the npm chatter and the repeated lines all reach the model', text.includes('30%') && text.includes('60%') && text.includes('npm WARN deprecated') && text.split('\n').filter(line => line === 'same line').length === 4, text)
  check('no footer rides the result', !text.includes(SHELL_OUTPUT_FILTER_SETTING))
}

section('§3 opted in: the same command reads filtered, the footer names the raw file, the raw file holds every byte, and a clean command is unchanged')
{
  setFilterKey(true)
  check('the setting reads on', isShellOutputFilterOn() === true)
  const text = await run(NOISY)
  const lines = text.split('\n')
  check('the progress bar keeps only its final state', !text.includes('30%') && !text.includes('60%') && text.includes('Downloading [==========] 100%'), text)
  check('the npm chatter is gone and the build line stays', !text.includes('npm WARN') && !text.includes('added 3 packages') && text.includes('Build finished'), text)
  check('the repeated line folds to one with its count', lines.filter(line => line.startsWith('same line')).length === 1 && text.includes('same line  [repeated 4 times]'), text)
  const footer = lines.find(line => line.startsWith(`[${SHELL_OUTPUT_FILTER_SETTING}:`)) ?? ''
  check('the footer names what was left out', footer.includes('2 progress redraws') && footer.includes('2 install lines') && footer.includes('1 run of repeated lines'), footer)
  const rawPath = /kept at (\S+)\]$/.exec(footer)?.[1]
  check('the footer names the raw file and it exists', rawPath !== undefined && existsSync(rawPath), footer)
  const raw = rawPath ? readFileSync(rawPath, 'utf8') : ''
  check('the raw file holds the whole unfiltered output', raw.includes('30%') && raw.includes('60%') && raw.includes('npm WARN deprecated') && raw.split('\n').filter(line => line === 'same line').length === 4 && raw.includes('Build finished'), raw.slice(0, 300))
  const cleanOn = await run(CLEAN)
  setFilterKey(null)
  const cleanOff = await run(CLEAN)
  check('a clean command reads byte-identical with the setting on and off', cleanOn === cleanOff && !cleanOn.includes(SHELL_OUTPUT_FILTER_SETTING), `${JSON.stringify(cleanOn)} vs ${JSON.stringify(cleanOff)}`)
}

section('§4 a failing command is filtered the same way: the error text the model reads carries the exit and the verdict, not the chatter')
{
  setFilterKey(true)
  let failureText = ''
  try {
    await BashTool.call({ command: `${NOISY}; printf 'error: the step failed\\n'; exit 2` }, toolContext)
  } catch (error) {
    failureText = formatError(error)
  }
  check('the failure names the exit and the error line', failureText.includes('error: the step failed') && /\b2\b/.test(failureText), failureText)
  check('the chatter is gone from the failure text and the footer rides it', !failureText.includes('npm WARN') && !failureText.includes('30%') && failureText.includes(SHELL_OUTPUT_FILTER_SETTING), failureText)
  setFilterKey(null)
}

section('§5 one law, two shells, one schema row')
{
  const bash = readFileSync(join(ROOT, 'src/tools/BashTool/BashTool.tsx'), 'utf8')
  const ps = readFileSync(join(ROOT, 'src/tools/PowerShellTool/PowerShellTool.tsx'), 'utf8')
  const CALL = 'out = await applyShellOutputFilter(out, { taskId: shellCommand.taskOutput.taskId, spilledPath: result.outputFilePath })'
  const BASH_CALL = 'let out = await applyShellOutputFilter(accumulator.toString(), { taskId: shellCommand.taskOutput.taskId, spilledPath: result.outputFilePath })'
  const CUT = 'const budget = resolveOutputBudget'
  check('the Bash tool applies the filter before the budget cut', bash.includes(BASH_CALL) && bash.includes(CUT) && bash.indexOf(BASH_CALL) < bash.indexOf(CUT))
  check('the PowerShell tool applies the same call at the same place', ps.includes(CALL) && ps.includes(CUT) && ps.indexOf(CALL) < ps.indexOf(CUT))
  const schema = JSON.parse(readFileSync(join(ROOT, 'scripts/settings/settings-schema.json'), 'utf8')) as { properties?: { shell?: { properties?: Record<string, { type?: string }> } } }
  check('the settings schema carries shell.filterOutput as a boolean', schema.properties?.shell?.properties?.filterOutput?.type === 'boolean')
  const docs = readFileSync(join(ROOT, 'docs/SETTINGS.md'), 'utf8')
  check('docs/SETTINGS.md names the key and says it is off by default', /\| `shell\.filterOutput` \|[^\n]*Off by default\./.test(docs))
}

section('refusals — real output that resembles progress or chatter is never dropped, and image output bypasses the filter')
{
  const { applyShellOutputFilter } = await import('../../src/tools/BashTool/utils.ts')
  const singlePct = 'Coverage summary: 85.4% of statements covered\nAll suites passed.\n'
  const singleOut = filterShellOutput(singlePct)
  check('a single percentage line in real output is never dropped (a run of one has 0 redraws)', singleOut.text === singlePct && singleOut.changed === false, JSON.stringify(singleOut))
  const trace = 'Traceback (most recent call last):\n  File "app.py", line 10, in <module>\n    raise RuntimeError("failed at 50% step")\nRuntimeError: failed at 90% completion\n'
  const traceOut = filterShellOutput(trace)
  check('traceback and failure lines with percentages stay whole', traceOut.text === trace && traceOut.changed === false, JSON.stringify(traceOut))
  const blankRepeats = 'alpha\n\n\n\n\nbeta\n'
  const blankOut = filterShellOutput(blankRepeats)
  check('blank lines are never folded into [repeated N times]', blankOut.text === blankRepeats && blankOut.changed === false, JSON.stringify(blankOut))
  setFilterKey(true)
  const imageUri = 'data:image/png;base64,' + 'A'.repeat(200)
  const imageResult = await applyShellOutputFilter(imageUri, { taskId: 'img-task', spilledPath: undefined })
  check('an image data-URI output bypasses the filter untouched', imageResult === imageUri)
  setFilterKey(null)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
if (failures > 0) {
  console.log(`SHELL-OUTPUT-FILTER: ${failures} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`SHELL-OUTPUT-FILTER: all ${checks} checks passed`)
process.exit(0)
