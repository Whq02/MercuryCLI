#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..', '..')
process.chdir(REPO)

const SCRATCH = mkdtempSync(join(tmpdir(), 'feedback-road-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_DOCTOR_STATE_DIR = join(SCRATCH, 'doctor-state')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.MERCURY_DOCTOR_STATE_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.MERCURY_ISSUES_REPO_URL
delete process.env.MERCURY_GH_CMD
delete process.env.GH_SHIM_LOG
delete process.env.GH_SHIM_AUTH
delete process.env.GH_SHIM_REPO_ACCESS
delete process.env.GH_SHIM_BODY_OUT
delete process.env.GH_SHIM_ISSUE_URL

const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
  version: string
  repository?: { url?: string }
}
;(globalThis as Record<string, unknown>).MACRO = { VERSION: pkg.version, PACKAGE_URL: pkg.repository?.url ?? '' }

const PUBLIC_HOME = 'Whq02/MercuryCLI'
const FAKE_GH = join(REPO, 'scripts', 'command-catalogue', 'fake-gh.mjs')
const fakeGhCmd = JSON.stringify(['node', FAKE_GH])

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}

const forms = await import('../../src/commands/feedback/issueForms.ts')
const ghIssue = await import('../../src/services/repoHost/ghIssue.ts')
const doctor = await import('../../src/commands/feedback/doctorSection.ts')
const feedback = await import('../../src/components/Feedback.tsx')
const { lastCertPath } = await import('../../src/utils/healthReport.ts')
const { repoSlugFromUrl } = await import('../../src/services/privateChannel/channelCore.ts')

section('B2 the body follows the form: the table equals the yml files')

type YmlForm = { name: string; description: string; title: string; fields: Array<{ id: string; label: string }> }
function parseTemplate(file: string): YmlForm {
  const text = readFileSync(join(REPO, '.github', 'ISSUE_TEMPLATE', file), 'utf8')
  const top = (key: string): string => new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, 'm').exec(text)?.[1] ?? ''
  const fields: YmlForm['fields'] = []
  for (const item of text.split(/^  - type: /m).slice(1)) {
    const type = (item.split('\n')[0] ?? '').trim()
    if (type === 'markdown') continue
    const id = /^\s+id:\s*(\S+)/m.exec(item)?.[1] ?? ''
    const label = /^\s+label:\s*(.+?)\s*$/m.exec(item)?.[1] ?? ''
    fields.push({ id, label })
  }
  return { name: top('name'), description: top('description'), title: top('title'), fields }
}

for (const kind of forms.ISSUE_KINDS) {
  const form = forms.ISSUE_FORMS[kind]
  const templatePath = join(REPO, '.github', 'ISSUE_TEMPLATE', form.template)
  check(`${kind}: the template file exists (${form.template})`, existsSync(templatePath))
  if (!existsSync(templatePath)) continue
  const yml = parseTemplate(form.template)
  check(`${kind}: the chooser name and line are the yml's`, form.name === yml.name && form.description === yml.description, `${form.name} / ${yml.name}`)
  check(`${kind}: the title prefix is the yml title (${JSON.stringify(yml.title)})`, form.titlePrefix === yml.title, JSON.stringify(form.titlePrefix))
  const ids = form.fields.map(f => f.id).join(' · ')
  const ymlIds = yml.fields.map(f => f.id).join(' · ')
  check(`${kind}: the field ids match the yml in order`, ids === ymlIds, `${ids} vs ${ymlIds}`)
  const labels = form.fields.map(f => f.label).join(' · ')
  const ymlLabels = yml.fields.map(f => f.label).join(' · ')
  check(`${kind}: the field labels match the yml in order`, labels === ymlLabels, `${labels} vs ${ymlLabels}`)
  check(`${kind}: exactly one 'words' field (the command's argument)`, form.fields.filter(f => f.source === 'words').length === 1)

  const values: Record<string, string> = {}
  for (const f of form.fields) if (f.id !== 'expected' && f.id !== 'today') values[f.id] = `words for ${f.id}`
  const body = forms.composeIssueBody(form, {
    values,
    recentErrors: [{ error: 'Error: seeded', timestamp: '2020-01-01T00:00:00.000Z' }],
  })
  check(`${kind}: the body headings equal the yml labels in order`, forms.issueSectionLabels(body).join(' · ') === ymlLabels, forms.issueSectionLabels(body).join(' · '))
  const blank = form.fields.find(f => f.id === 'expected' || f.id === 'today')
  if (blank) {
    check(`${kind}: a blank section reads ${forms.NOT_STATED}`, body.includes(`${forms.SECTION_HEADING}${blank.label}\n${forms.NOT_STATED}`))
  }
  check(`${kind}: the recent errors ride collapsed`, body.includes('<details>') && body.includes('Recent errors (redacted)') && body.includes('Error: seeded'))
  check(`${kind}: no transcript rides the body`, !body.includes('raw_transcript') && !body.includes('subagent_transcripts') && body.includes('was not sent'))
}
{
  const bug = forms.ISSUE_FORMS.bug
  const many = Array.from({ length: forms.RECENT_ERRORS_MAX + 5 }, (_, i) => ({ error: `e${i} ${'x'.repeat(forms.RECENT_ERROR_CHARS + 50)}`, timestamp: 't' }))
  const body = forms.composeIssueBody(bug, { values: {}, recentErrors: many })
  check('the recent-errors block is bounded (count and length)', body.includes('(5 earlier errors omitted)') && !body.includes('x'.repeat(forms.RECENT_ERROR_CHARS + 1)))
  const doctorBody = forms.composeIssueBody(bug, { values: { doctor: 'verdict ok\n- row' }, recentErrors: [] })
  check('the doctor section is fenced', doctorBody.includes('```text\nverdict ok\n- row\n```'))
  check('the prompted fields: the words field first, then every ask, in form order', forms.promptedFields(bug).map(f => f.id).join(',') === 'steps,expected,actual' && forms.promptedFields(forms.ISSUE_FORMS.feature).map(f => f.id).join(',') === 'task,today,proposal,steps')
  check('the title carries the form prefix and drops a model marker', forms.fullIssueTitle(bug, '[Bug] Scroll resets') === '[bug] Scroll resets')
  check('an empty title falls to the form name', forms.fullIssueTitle(forms.ISSUE_FORMS.feature, '  ') === '[feature] Feature request from Mercury')
  check('a runaway title is capped', forms.fullIssueTitle(bug, 'y'.repeat(400)).length <= 210)
}

section('B1 the signed-in road files through the one gh transport')
{
  const packaged = repoSlugFromUrl(pkg.repository?.url ?? '')
  check(`the default slug is the packaged repository (${packaged})`, ghIssue.issueRepoSlug() === packaged && packaged === PUBLIC_HOME, ghIssue.issueRepoSlug())
  process.env.MERCURY_ISSUES_REPO_URL = 'https://github.com/someone/fork.git'
  check('MERCURY_ISSUES_REPO_URL as a URL overrides the slug (a fork)', ghIssue.issueRepoSlug() === 'someone/fork', ghIssue.issueRepoSlug())
  process.env.MERCURY_ISSUES_REPO_URL = 'someone/fork'
  check('MERCURY_ISSUES_REPO_URL as a slug overrides the slug', ghIssue.issueRepoSlug() === 'someone/fork', ghIssue.issueRepoSlug())
  process.env.MERCURY_ISSUES_REPO_URL = 'not a repository'
  check('an unreadable override falls back to the packaged repository', ghIssue.issueRepoSlug() === PUBLIC_HOME, ghIssue.issueRepoSlug())
  delete process.env.MERCURY_ISSUES_REPO_URL
  check('the issues page is the repository\'s', ghIssue.issuesPageUrl(PUBLIC_HOME) === `https://github.com/${PUBLIC_HOME}/issues`)

  const argv = ghIssue.fileIssueArgv({ slug: PUBLIC_HOME, title: '[bug] T', bodyFile: '/tmp/b.md' })
  check('the argv is exactly issue create --repo --title --body-file', argv.join(' ') === `issue create --repo ${PUBLIC_HOME} --title [bug] T --body-file /tmp/b.md`, argv.join(' '))
  check('no --label rides (a non-collaborator cannot set one)', !argv.includes('--label'))

  const log = join(SCRATCH, 'gh-file.log')
  const bodyFile = join(SCRATCH, 'body-unit.md')
  const bodyOut = join(SCRATCH, 'body-unit-received.md')
  writeFileSync(bodyFile, '### Version\nMercury 1.0.0\n')
  process.env.MERCURY_GH_CMD = fakeGhCmd
  process.env.GH_SHIM_LOG = log
  process.env.GH_SHIM_BODY_OUT = bodyOut
  process.env.GH_SHIM_ISSUE_URL = `https://github.com/${PUBLIC_HOME}/issues/424`
  const filed = await ghIssue.fileIssue({ slug: PUBLIC_HOME, title: '[bug] Unit title', bodyFile })
  check('the fake gh files and the URL comes back', filed.state === 'filed' && filed.url === `https://github.com/${PUBLIC_HOME}/issues/424`, JSON.stringify(filed))
  const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
  check('exactly one gh spawn, the exact argv', lines.length === 1 && lines[0] === `gh issue create --repo ${PUBLIC_HOME} --title [bug] Unit title --body-file ${bodyFile}`, lines.join(' | '))
  check('the body gh received is the body file, byte for byte', existsSync(bodyOut) && readFileSync(bodyOut, 'utf8') === readFileSync(bodyFile, 'utf8'))
  delete process.env.GH_SHIM_BODY_OUT
  delete process.env.GH_SHIM_ISSUE_URL
}

section('B5 no gh = the honest fallback (three exact arms)')
{
  const log = join(SCRATCH, 'gh-access.log')
  process.env.GH_SHIM_LOG = log
  process.env.MERCURY_GH_CMD = JSON.stringify([join(SCRATCH, 'absent', 'gh')])
  const missing = await ghIssue.checkIssueAccess(PUBLIC_HOME)
  check('gh missing ⇒ gh-missing with the install + login remedy', missing.state === 'gh-missing' && missing.remedy.includes('https://cli.github.com') && missing.remedy.includes('gh auth login'), JSON.stringify(missing))

  process.env.MERCURY_GH_CMD = fakeGhCmd
  process.env.GH_SHIM_AUTH = 'fail'
  const signedOut = await ghIssue.checkIssueAccess(PUBLIC_HOME)
  check('not signed in ⇒ not-signed-in with `gh auth login`', signedOut.state === 'not-signed-in' && signedOut.remedy.includes('gh auth login'), JSON.stringify(signedOut))
  delete process.env.GH_SHIM_AUTH

  process.env.GH_SHIM_REPO_ACCESS = 'deny'
  const denied = await ghIssue.checkIssueAccess(PUBLIC_HOME)
  check('cannot see the repository ⇒ no-repo-access naming the slug', denied.state === 'no-repo-access' && denied.note.includes(PUBLIC_HOME) && !denied.note.includes('private'), JSON.stringify(denied))
  delete process.env.GH_SHIM_REPO_ACCESS

  rmSync(log, { force: true })
  const ok = await ghIssue.checkIssueAccess(PUBLIC_HOME)
  const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
  check('signed in and able ⇒ ok after exactly auth status + repo view', ok.state === 'ok' && lines.join(' | ') === `gh auth status | gh repo view ${PUBLIC_HOME} --json name`, lines.join(' | '))

  const para = forms.noGhParagraph({ note: 'gh is installed but not signed in', remedy: 'run `gh auth login`', slug: PUBLIC_HOME, draftPath: '/d/bug-1.json', bodyPath: '/d/bug-1.md' })
  check('the fallback is ONE paragraph: the note, the remedy, both paths, the issues page', !para.includes('\n') && para.includes('not signed in') && para.includes('gh auth login') && para.includes('/d/bug-1.json') && para.includes('/d/bug-1.md') && para.includes(`https://github.com/${PUBLIC_HOME}/issues`), para)
  const noFiles = forms.noGhParagraph({ note: 'n', remedy: 'r', slug: PUBLIC_HOME, draftPath: null, bodyPath: null })
  check('a refused draft write is said, still one paragraph', !noFiles.includes('\n') && noFiles.includes('could not be written'))
  delete process.env.MERCURY_GH_CMD
  delete process.env.GH_SHIM_LOG
}

section('B6 privacy: the `~` spelling, the bounded doctor, the gates')
{
  const home = homedir()
  const spelled = feedback.redactSensitiveInfo(`at ${home}/.mercury/feedback/bug-1.json and ${home}`)
  check('the home directory reads `~` (a path and the bare home)', spelled === 'at ~/.mercury/feedback/bug-1.json and ~', spelled)
  check('a longer name sharing the prefix is untouched', feedback.redactSensitiveInfo(`${home}xyz/file`) === `${home}xyz/file`)
  check('the secret classes still redact', feedback.redactSensitiveInfo('key sk-ant-abcdefghijklmnop end').includes('[REDACTED_API_KEY]'))
  const spellings = await import('../../src/services/providers/credentialEnvSpellings.ts')
  check('the value-shape table covers every family the env-spelling table covers (one key set)', JSON.stringify(Object.keys(spellings.PROVIDER_CREDENTIAL_VALUE_SHAPES).sort()) === JSON.stringify(Object.keys(spellings.PROVIDER_CREDENTIAL_ENV_VARS).sort()))
  const bare: Array<[string, string, string]> = [
    ['openai', 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', '[REDACTED_OPENAI_KEY]'],
    ['openai (a plain sk- key)', 'sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd', '[REDACTED_OPENAI_KEY]'],
    ['openrouter', 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef', '[REDACTED_OPENROUTER_KEY]'],
    ['huggingface', 'hf_AbCdEfGhIjKlMnOpQrStUvWxYz0123', '[REDACTED_HUGGINGFACE_TOKEN]'],
    ['gemini', 'AIzaSyA1234567890abcdefghijklmnopqrstuv', '[REDACTED_GCP_KEY]'],
    ['anthropic', 'sk-ant-api03-0123456789abcdefghij', '[REDACTED_API_KEY]'],
    ['the repository host (ghp_)', 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB', '[REDACTED_GITHUB_TOKEN]'],
    ['the repository host (github_pat_)', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789', '[REDACTED_GITHUB_TOKEN]'],
  ]
  for (const [family, value, marker] of bare) {
    const out = feedback.redactSensitiveInfo(`pasted: ${value} — see the log`)
    check(`a bare ${family} value reads as ${marker}`, out.includes(marker) && !out.includes(value), out.slice(0, 120))
  }
  check('a family without a distinctive prefix declares none (the assignment pass stays its owner)', spellings.PROVIDER_CREDENTIAL_VALUE_SHAPES.zai === null && spellings.PROVIDER_CREDENTIAL_VALUE_SHAPES.moonshot === null && spellings.PROVIDER_CREDENTIAL_VALUE_SHAPES.deepseek === null && spellings.PROVIDER_CREDENTIAL_VALUE_SHAPES.local === null && spellings.PROVIDER_CREDENTIAL_VALUE_SHAPES['openai-compat'] === null)
  check('the assignment pass still redacts a prefix-less family\'s value', feedback.redactSensitiveInfo('ZAI_API_KEY=abcdef0123456789.secret').includes('[REDACTED_TOKEN]'))

  const notRun = await doctor.runDoctorBounded(1)
  check('a passed deadline reads "doctor: not run — …deadline"', notRun.startsWith('doctor: not run — ') && notRun.includes('deadline'), notRun)
  const aborted = new AbortController()
  aborted.abort(new Error('the report was cancelled'))
  const cancelled = await doctor.runDoctorBounded(60_000, aborted.signal)
  check('an aborted report never starts a run', cancelled === 'doctor: not run — the report was cancelled', cancelled)

  const certPath = lastCertPath()
  mkdirSync(join(certPath, '..'), { recursive: true })
  const ranAt = new Date().toISOString()
  writeFileSync(
    certPath,
    JSON.stringify({
      verdict: 'caution',
      ranAt,
      head: { sha: null, branch: null, dirty: null },
      version: '1.0.0',
      counts: { ok: 40, warn: 1, fail: 0, stale: 0, unknown: 0, off: 0, info: 0 },
      attention: [{ id: 'bundle', label: 'Bundle freshness', status: 'warn', evidence: `dist older than src at ${home}/x` }],
      _v: 1,
    }),
  )
  const fresh = await doctor.gatherDoctorSection({ deadlineMs: 1 })
  check('a fresh certificate summary is read as-is: the summary line + the warning row', fresh.startsWith('verdict caution · ok 40 · warn 1 · fail 0') && fresh.includes('certificate recorded') && fresh.includes('- Bundle freshness: warn — dist older than src'), fresh)
  const stale = await doctor.gatherDoctorSection({ deadlineMs: 1, nowMs: Date.now() + doctor.FRESH_CERT_MS + 60_000 })
  check('a stale summary is not read: the bounded run (here past its deadline) answers', stale.startsWith('doctor: not run — '), stale)
  rmSync(certPath, { force: true })

  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const { builtinCommands } = await import('../../src/commands.ts')
  const cmd = [...builtinCommands()].find(c => c.name === 'feedback')
  check('/feedback is registered with the bug alias', cmd !== undefined && (cmd.aliases ?? []).includes('bug'))
  check('the description says the road (the GitHub CLI; a local draft without it)', (cmd?.description ?? '').includes('GitHub CLI') && (cmd?.description ?? '').includes('local draft'), cmd?.description)
  const enabled = (): boolean => (cmd?.isEnabled ? cmd.isEnabled() : true)
  check('enabled by default', enabled())
  process.env.MERCURY_FEEDBACK_COMMAND = '0'
  check('MERCURY_FEEDBACK_COMMAND disables the whole command', !enabled())
  delete process.env.MERCURY_FEEDBACK_COMMAND
  process.env.MERCURY_BUG_COMMAND = '0'
  check('MERCURY_BUG_COMMAND disables the whole command', !enabled())
  delete process.env.MERCURY_BUG_COMMAND
  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  check('essential-traffic-only disables the whole command', !enabled())
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
  check('…and it is enabled again', enabled())
}

section('B3/B4 the real bundle: the chooser, the review frame, the filing')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const { resolveCaptureDriver, vshotBudgetMs } = await import('../lib/captureDriver.ts')
const driver = resolveCaptureDriver()
if (!existsSync(BIN)) {
  check('dist/mercury.mjs exists (run the build first)', false)
} else if (driver.kind !== 'posix-pty') {
  console.log(`  (skipped: capture driver ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind})`)
} else {
  const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
  const { startFixtureApi } = await import('../lib/fixtureApi.ts')
  function seedProject(id: string): string {
    const dir = join(SCRATCH, `proj-${id}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'README.md'), '# proj\n')
    const git = (args: string[]): number => spawnSync('git', ['-c', 'user.email=proof@example.invalid', '-c', 'user.name=proof', ...args], { cwd: dir, stdio: 'ignore' }).status ?? 1
    git(['init', '-q'])
    git(['add', '.'])
    git(['commit', '-q', '-m', 'seed'])
    return dir
  }

  const CAPTURE_DIR = process.env.MERCURY_FEEDBACK_ROAD_CAPTURE_DIR ?? null
  if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true })

  const WARM_TICKS = 25

  type Capture = { status: number; marks: Record<string, string>; final: string; tail: string }
  async function capture(id: string, home: string, sends: Array<Record<string, unknown>>, total: number, extraEnv: Record<string, string>): Promise<Capture> {
    mkdirSync(home, { recursive: true })
    const PROJ = seedProject(id)
    seedFirstRun(home, [PROJ])
    const api = await startFixtureApi([
      { kind: 'text', text: 'Composer drops the second /model' },
      { kind: 'text', text: 'Composer drops the second /model' },
      { kind: 'text', text: 'Composer drops the second /model' },
    ])
    const cfgPath = join(SCRATCH, `cfg-${id}.json`)
    const outPath = join(SCRATCH, `grid-${id}.json`)
    writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN, '--model', 'claude-sonnet-5'], cwd: PROJ, cols: 120, rows: 40, sends, total, out: outPath }))
    const env: Record<string, string | undefined> = {
      ...process.env,
      MERCURY_CONFIG_DIR: home,
      MERCURY_DOCTOR_STATE_DIR: join(SCRATCH, `doctor-${id}`),
      MERCURY_CRITTER_IDLE: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_CRITTER_SLEEP: '0',
      MERCURY_LIVE_CLOCK: '0',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_OPERATOR: 'sam',
      MERCURY_SKIP_PROMPT_HISTORY: '1',
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: api.url,
      ...extraEnv,
    }
    delete env.MERCURY_ISSUES_REPO_URL
    const child = spawn(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const result = await new Promise<Capture>(resolvePromise => {
      let tail = ''
      const guard = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(total * 200 + 30_000))
      child.stdout.on('data', () => {})
      child.stderr.on('data', d => (tail = (tail + String(d)).slice(-600)))
      child.on('close', status => {
        clearTimeout(guard)
        const marks: Record<string, string> = {}
        let final = ''
        try {
          const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Array<Array<{ c: string }>>; marks?: Array<{ label: string; grid: Array<Array<{ c: string }>> }> }
          const text = (grid: Array<Array<{ c: string }>>): string => grid.map(row => row.map(c => c.c).join('').replace(/\s+$/, '')).join('\n')
          final = text(payload.grid)
          for (const m of payload.marks ?? []) marks[m.label] = text(m.grid)
          if (CAPTURE_DIR) {
            writeFileSync(join(CAPTURE_DIR, `${id}-final.txt`), `${final}\n`)
            for (const [label, frame] of Object.entries(marks)) writeFileSync(join(CAPTURE_DIR, `${id}--${label}.txt`), `${frame}\n`)
          }
        } catch {
        }
        resolvePromise({ status: status ?? 1, marks, final, tail })
      })
    })
    await api.close().catch(() => {})
    return result
  }

  const HOME_BUG = join(SCRATCH, 'home-bug')
  const ghLog = join(SCRATCH, 'gh-pty.log')
  const bodyOut = join(SCRATCH, 'body-pty.md')
  const issueUrl = `https://github.com/${PUBLIC_HOME}/issues/424`
  const bug = await capture(
    'bug',
    HOME_BUG,
    [
      { atTick: 60, awaitText: '↑↓ choose', minTick: WARM_TICKS, awaitSettleTicks: 2, data: '\r' },
      { atTick: 90, data: '/bug the composer ate my second /model', awaitText: 'Type a prompt', minTick: 5 },
      { afterPrevTicks: 4, data: '\r' },
      { atTick: 150, requireAwait: true, awaitText: 'Steps to reproduce', awaitStableTicks: 3, awaitSettleTicks: 2, mark: 'words', data: '\r' },
      { atTick: 170, requireAwait: true, awaitText: 'What you expected', awaitStableTicks: 3, awaitSettleTicks: 2, data: '\r' },
      { atTick: 190, requireAwait: true, awaitText: 'What happened instead', awaitStableTicks: 3, awaitSettleTicks: 2, data: 'it opened the model picker twice' },
      { afterPrevTicks: 3, data: '\r' },
      { atTick: 400, requireAwait: true, awaitText: 'enter to file it', awaitStableTicks: 3, mark: 'review', data: '' },
      { afterPrevTicks: 2, data: '\u001b[6~' },
      { afterPrevTicks: 3, mark: 'paged', data: '\u001b[A' },
      { afterPrevTicks: 3, mark: 'lined', data: '\r' },
      { atTick: 450, requireAwait: true, awaitText: 'Filed: ', awaitStableTicks: 3, mark: 'done', data: '' },
      { afterPrevTicks: 2, data: 'x' },
    ],
    480,
    { MERCURY_GH_CMD: fakeGhCmd, GH_SHIM_LOG: ghLog, GH_SHIM_BODY_OUT: bodyOut, GH_SHIM_ISSUE_URL: issueUrl },
  )
  check('the /bug journey delivered every send', bug.status === 0, `exit ${bug.status}: ${bug.tail.trim().slice(-300)}`)
  const words = bug.marks.words ?? ''
  check('B3 /bug is the bug form: the words field carries the argument under the form label', words.includes('Report a bug') && words.includes('Steps to reproduce') && words.includes('the composer ate my second /model'))
  const review = bug.marks.review ?? ''
  const reviewFlat = review.split('\n').map(l => l.replace(/^[│ ]+|[│ ]+$/g, '')).join(' ')
  check('B4 the review frame names the repository, the road and the one yes', review.includes(`will be filed as a new issue in ${PUBLIC_HOME} through your own gh`) && review.includes('enter to file it · esc to keep the draft only'))
  check('B4 the review frame shows the body itself (the form headings)', review.includes('### Version') && review.includes('### Steps to reproduce'))
  check('B4 the review frame says the transcript stays local', review.includes('is not sent'))
  const windowOf = (frame: string): number | null => {
    const m = /lines (\d+)–(\d+) of (\d+)/.exec(frame)
    return m ? Number(m[1]) : null
  }
  const atTop = windowOf(review)
  const paged = windowOf(bug.marks.paged ?? '')
  const lined = windowOf(bug.marks.lined ?? '')
  check('B4 the body scrolls: PageDown pages the box (the review owns the page keys)', atTop === 1 && paged !== null && paged > 1, `top ${atTop} → paged ${paged}`)
  check('B4 the body scrolls: ↑ walks one line back', paged !== null && lined === paged - 1, `paged ${paged} → lined ${lined}`)
  const shown = /\((\d+) bytes\)/.exec(reviewFlat)?.[1]
  const received = existsSync(bodyOut) ? readFileSync(bodyOut, 'utf8') : ''
  check('B4 the byte count shown equals the file gh received', shown !== undefined && received !== '' && Number(shown) === Buffer.byteLength(received, 'utf8'), `shown ${shown} vs received ${Buffer.byteLength(received, 'utf8')}`)
  const done = bug.marks.done ?? ''
  check('B4 the filed URL is printed', done.includes(`Filed: ${issueUrl}`))

  const lines = existsSync(ghLog) ? readFileSync(ghLog, 'utf8').trim().split('\n') : []
  const creates = lines.filter(l => l.startsWith('gh issue create '))
  check('B1 exactly one gh issue create, after the access triage', creates.length === 1 && lines.includes('gh auth status') && lines.includes(`gh repo view ${PUBLIC_HOME} --json name`), lines.join(' | '))
  const create = creates[0] ?? ''
  const argvMatch = /^gh issue create --repo (\S+) --title (\[bug\] .+?) --body-file (\S+)$/.exec(create)
  check('B1 the argv: --repo the public home · --title with the [bug] prefix · --body-file under the config home', argvMatch !== null && argvMatch[1] === PUBLIC_HOME && argvMatch[3]!.startsWith(join(HOME_BUG, 'feedback')) && argvMatch[3]!.endsWith('.md'), create)
  check('B1 no --label rides', !create.includes('--label'))
  check('B1 the title is the drafted title under the prefix', argvMatch !== null && argvMatch[2] === '[bug] Composer drops the second /model', argvMatch?.[2])

  const bugLabels = forms.ISSUE_FORMS.bug.fields.map(f => f.label).join(' · ')
  check('B2 the body gh received carries the bug form headings in order', forms.issueSectionLabels(received).join(' · ') === bugLabels, forms.issueSectionLabels(received).join(' · '))
  check('B2 the words sit under Steps to reproduce; the skipped prompt reads (not stated); the answered one carries its words', received.includes('### Steps to reproduce\nthe composer ate my second /model') && received.includes(`### What you expected\n${forms.NOT_STATED}`) && received.includes('### What happened instead\nit opened the model picker twice'))
  check('B2 the version and install sections are gathered', received.includes(`### Version\nMercury ${pkg.version}`) && /### How Mercury was installed\n\S/.test(received))
  check('B2 the doctor section is the rows and the summary line, or its honest absence', /### doctor --json\n```text\n(verdict (certified|caution|fault) · ok \d+|doctor: not run — )/.test(received))
  check('B6 the body never spells the home directory', !received.includes(homedir()))
  check('B2 no transcript rides the body', !received.includes('raw_transcript') && !received.includes('"transcript"'))

  const feedbackDir = join(HOME_BUG, 'feedback')
  const drafts = existsSync(feedbackDir) ? readdirSync(feedbackDir).filter(f => f.startsWith('bug-') && f.endsWith('.json')) : []
  const draft = drafts.length === 1 ? (JSON.parse(readFileSync(join(feedbackDir, drafts[0]!), 'utf8')) as Record<string, unknown>) : null
  check('B4 the local draft exists once, keeps the transcript, and records the filed URL and the body path', draft !== null && draft.issue_url === issueUrl && typeof draft.body_path === 'string' && 'transcript' in draft && draft.issue_repo === PUBLIC_HOME, drafts.join(','))
  const bodies = existsSync(feedbackDir) ? readdirSync(feedbackDir).filter(f => f.startsWith('bug-') && f.endsWith('.md')) : []
  check('B4 the body that left the box sits beside the draft, byte-identical to what gh received', bodies.length === 1 && readFileSync(join(feedbackDir, bodies[0]!), 'utf8') === received)

  const HOME_ESC = join(SCRATCH, 'home-esc')
  const escLog = join(SCRATCH, 'gh-esc.log')
  const esc = await capture(
    'esc',
    HOME_ESC,
    [
      { atTick: 60, awaitText: '↑↓ choose', minTick: WARM_TICKS, awaitSettleTicks: 2, data: '\r' },
      { atTick: 90, data: '/bug it froze on the second model switch', awaitText: 'Type a prompt', minTick: 5 },
      { afterPrevTicks: 4, data: '\r' },
      { atTick: 150, requireAwait: true, awaitText: 'Steps to reproduce', awaitStableTicks: 3, awaitSettleTicks: 2, data: '\r' },
      { atTick: 170, requireAwait: true, awaitText: 'What you expected', awaitStableTicks: 3, awaitSettleTicks: 2, data: '\r' },
      { atTick: 190, requireAwait: true, awaitText: 'What happened instead', awaitStableTicks: 3, awaitSettleTicks: 2, data: '\r' },
      { atTick: 400, requireAwait: true, awaitText: 'enter to file it', awaitStableTicks: 3, mark: 'review', data: '\u001b' },
      { atTick: 440, requireAwait: true, awaitText: 'Type a prompt', awaitStableTicks: 3, mark: 'kept', data: '' },
    ],
    460,
    { MERCURY_GH_CMD: fakeGhCmd, GH_SHIM_LOG: escLog },
  )
  check('the esc journey delivered every send', esc.status === 0, `exit ${esc.status}: ${esc.tail.trim().slice(-300)}`)
  const kept = esc.marks.kept ?? ''
  check('B4 esc at the review closes the dialog without filing (no Filed:, no review left on screen)', kept.includes('Type a prompt') && !kept.includes('Filed:') && !kept.includes('enter to file it'))
  const surface = readFileSync(join(REPO, 'src', 'components', 'Feedback.tsx'), 'utf8')
  check('B4 the kept receipt says so: drafted locally, nothing was filed', surface.includes("drafted locally at ${p.json} — nothing was filed."))
  const escLines = existsSync(escLog) ? readFileSync(escLog, 'utf8') : ''
  check('B4 esc spawns no gh issue create', !escLines.includes('gh issue create'))
  const escDir = join(HOME_ESC, 'feedback')
  const escFiles = existsSync(escDir) ? readdirSync(escDir).sort() : []
  check('B4 the draft and the body stay on disk after esc', escFiles.length === 2 && escFiles.some(f => f.endsWith('.json')) && escFiles.some(f => f.endsWith('.md')), escFiles.join(','))

  const HOME_PICK = join(SCRATCH, 'home-pick')
  const pick = await capture(
    'pick',
    HOME_PICK,
    [
      { atTick: 60, awaitText: '↑↓ choose', minTick: WARM_TICKS, awaitSettleTicks: 2, data: '\r' },
      { atTick: 90, data: '/feedback', awaitText: 'Type a prompt', minTick: 5 },
      { afterPrevTicks: 4, data: '\r' },
      { atTick: 150, requireAwait: true, awaitText: 'Provider or model report', awaitStableTicks: 3, mark: 'chooser', data: '\u001b' },
      { atTick: 190, requireAwait: true, awaitText: 'cancelled', awaitStableTicks: 3, mark: 'closed', data: '' },
    ],
    200,
    { MERCURY_GH_CMD: fakeGhCmd },
  )
  check('the /feedback journey delivered every send', pick.status === 0, `exit ${pick.status}: ${pick.tail.trim().slice(-300)}`)
  const chooser = pick.marks.chooser ?? ''
  check('B3 /feedback opens the three-row chooser with the yml names', chooser.includes('Feedback — which kind?') && forms.ISSUE_KINDS.every(k => chooser.includes(forms.ISSUE_FORMS[k].name)))
  const closed = pick.marks.closed ?? ''
  check('B3 esc on the chooser closes it and files nothing (no draft, no gh)', !closed.includes('Feedback — which kind?') && !existsSync(join(HOME_PICK, 'feedback')))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-feedback-issue-road: ALL LAWS HOLD' : `\nprove-feedback-issue-road: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
