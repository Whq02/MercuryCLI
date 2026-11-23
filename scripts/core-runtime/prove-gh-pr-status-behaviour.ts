#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeScratch } from '../lib/removeScratch.ts'

type Case = { name: string; out: string | null; exit: number }
type Result = { name: string; answer?: unknown; rejected?: string; calls: string[] }

if (process.argv[2] === '--ask') {
  const bin = process.argv[3]!
  const cases = JSON.parse(readFileSync(process.argv[4]!, 'utf8')) as Case[]
  const { fetchPrStatus } = await import('../../src/platform/git/ghPrStatus.ts')
  const results: Result[] = []
  for (const one of cases) {
    rmSync(join(bin, 'calls.log'), { force: true })
    rmSync(join(bin, 'out.txt'), { force: true })
    if (one.out !== null) writeFileSync(join(bin, 'out.txt'), one.out)
    writeFileSync(join(bin, 'exit.txt'), String(one.exit))
    const calls = (): string[] => (existsSync(join(bin, 'calls.log')) ? readFileSync(join(bin, 'calls.log'), 'utf8').split('\n').filter(line => line !== '') : [])
    try {
      const answer = await fetchPrStatus()
      results.push({ name: one.name, answer, calls: calls() })
    } catch (error) {
      results.push({ name: one.name, rejected: String(error), calls: calls() })
    }
  }
  process.stdout.write(`RESULTS ${JSON.stringify(results)}\n`)
  process.exit(0)
}

const WHERE = 'fetchPrStatus in src/platform/git/ghPrStatus.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

if (process.platform === 'win32') {
  console.log('prove-gh-pr-status-behaviour: the stand-in gh is a shell script, which this platform does not run; nothing proven here')
  process.exit(0)
}

const ASKED = 'pr view --json number,url,reviewDecision,isDraft,headRefName,state'
const URL = 'https://example.invalid/acme/widgets/pull/7'
const pr = (over: Record<string, unknown>): string => JSON.stringify({ number: 7, url: URL, headRefName: 'feature', state: 'OPEN', isDraft: false, ...over })
const without = (key: string): string => {
  const whole = JSON.parse(pr({})) as Record<string, unknown>
  delete whole[key]
  return JSON.stringify(whole)
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'gh-pr-status-')))
try {
  const bin = join(scratch, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'gh'),
    ['#!/bin/sh', 'here=$(dirname "$0")', 'printf \'%s\\n\' "$*" >> "$here/calls.log"', 'if [ -f "$here/out.txt" ]; then cat "$here/out.txt"; fi', 'exit "$(cat "$here/exit.txt")"', ''].join('\n'),
  )
  chmodSync(join(bin, 'gh'), 0o755)

  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  const git = (cwd: string, ...args: string[]): void => {
    const run = spawnSync('git', ['-c', 'user.name=proof', '-c', 'user.email=proof@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, env: gitEnv, encoding: 'utf8' })
    if (run.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${run.stderr}`)
  }
  const repo = (name: string, branch: string | null): string => {
    const dir = join(scratch, name)
    mkdirSync(dir)
    if (branch !== null) {
      git(dir, 'init', '-q', '-b', 'main')
      git(dir, 'commit', '-q', '--allow-empty', '-m', 'first')
      if (branch !== 'main') git(dir, 'checkout', '-q', '-b', branch)
    }
    return dir
  }
  const plain = repo('plain', null)
  const onMain = repo('on-main', 'main')
  const onFeature = repo('on-feature', 'feature')

  const home = join(scratch, 'home')
  mkdirSync(home)
  let batch = 0
  const ask = (cwd: string, cases: Case[]): Map<string, Result> => {
    const file = join(scratch, `cases-${batch++}.json`)
    writeFileSync(file, JSON.stringify(cases))
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, MERCURY_CONFIG_DIR: home, NODE_ENV: 'test' }
    delete env.MERCURY_HOME
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--ask', bin, file], { cwd, env, encoding: 'utf8', timeout: 120_000 })
    const line = (run.stdout ?? '').split('\n').find(text => text.startsWith('RESULTS '))
    if (line === undefined) {
      appendFileSync(join(scratch, 'child-errors.log'), `${run.stderr ?? ''}\n`)
      check(`the asking process for ${cwd} answered`, false, `exit ${run.status}; ${(run.stderr ?? '').trim().split('\n').slice(-3).join(' | ')}; see ${WHERE}`)
      return new Map()
    }
    return new Map((JSON.parse(line.slice('RESULTS '.length)) as Result[]).map(result => [result.name, result]))
  }
  const isNull = (result: Result | undefined): boolean => result !== undefined && result.rejected === undefined && result.answer === null
  const show = (result: Result | undefined): string => `got ${JSON.stringify(result)}; see ${WHERE}`

  section('§1 no question is put to gh where there is nothing to ask')
  {
    const open = [{ name: 'open', out: pr({}), exit: 0 }]
    const outside = ask(plain, open).get('open')
    check('outside a repository the answer is null', isNull(outside), show(outside))
    check('outside a repository gh is not run', outside?.calls.length === 0, show(outside))
    const main = ask(onMain, open).get('open')
    check('on the default branch the answer is null', isNull(main), show(main))
    check('on the default branch gh is not run', main?.calls.length === 0, show(main))
  }

  const cases: Case[] = [
    { name: 'open', out: pr({}), exit: 0 },
    { name: 'approved', out: pr({ reviewDecision: 'APPROVED' }), exit: 0 },
    { name: 'changes', out: pr({ reviewDecision: 'CHANGES_REQUESTED' }), exit: 0 },
    { name: 'required', out: pr({ reviewDecision: 'REVIEW_REQUIRED' }), exit: 0 },
    { name: 'empty decision', out: pr({ reviewDecision: '' }), exit: 0 },
    { name: 'lower case decision', out: pr({ reviewDecision: 'approved' }), exit: 0 },
    { name: 'draft', out: pr({ isDraft: true }), exit: 0 },
    { name: 'draft and approved', out: pr({ isDraft: true, reviewDecision: 'APPROVED' }), exit: 0 },
    { name: 'no draft member', out: without('isDraft'), exit: 0 },
    { name: 'lower case state', out: pr({ state: 'merged' }), exit: 0 },
    { name: 'no state member', out: without('state'), exit: 0 },
    { name: 'no head member', out: without('headRefName'), exit: 0 },
    { name: 'line end after the answer', out: `${pr({})}\n`, exit: 0 },
    { name: 'gh fails with an answer', out: pr({}), exit: 1 },
    { name: 'gh fails with nothing', out: null, exit: 4 },
    { name: 'nothing', out: null, exit: 0 },
    { name: 'blanks', out: ' \n\t\n', exit: 0 },
    { name: 'head main', out: pr({ headRefName: 'main' }), exit: 0 },
    { name: 'head master', out: pr({ headRefName: 'master' }), exit: 0 },
    { name: 'merged', out: pr({ state: 'MERGED' }), exit: 0 },
    { name: 'closed', out: pr({ state: 'CLOSED' }), exit: 0 },
    { name: 'number as text', out: pr({ number: '7' }), exit: 0 },
    { name: 'no number', out: without('number'), exit: 0 },
    { name: 'no url', out: without('url'), exit: 0 },
    { name: 'url as number', out: pr({ url: 7 }), exit: 0 },
    { name: 'not JSON', out: 'no pull requests found for branch "feature"', exit: 0 },
    { name: 'JSON null', out: 'null', exit: 0 },
    { name: 'JSON list', out: '[]', exit: 0 },
  ]
  const got = ask(onFeature, cases)
  const stateOf = (name: string): unknown => (got.get(name)?.answer as { reviewState?: unknown } | null | undefined)?.reviewState

  section('§2 on another branch gh is asked once, with exactly these arguments, and its answer becomes a record of three')
  {
    const open = got.get('open')
    check('gh is run once', open?.calls.length === 1, show(open))
    check(`its arguments are: ${ASKED}`, open?.calls[0] === ASKED, show(open))
    check(
      'the record holds number, url and reviewState, in that order',
      JSON.stringify(open?.answer) === JSON.stringify({ number: 7, url: URL, reviewState: 'pending' }),
      show(open),
    )
    check('a line end after the answer changes nothing', JSON.stringify(got.get('line end after the answer')?.answer) === JSON.stringify(open?.answer), show(got.get('line end after the answer')))
    check('every case asked gh exactly once', cases.every(one => got.get(one.name)?.calls.length === 1 && got.get(one.name)?.calls[0] === ASKED), cases.filter(one => got.get(one.name)?.calls.length !== 1).map(one => one.name).join(', '))
  }

  section('§3 the review state')
  {
    const want: Array<[string, string]> = [
      ['open', 'pending'],
      ['approved', 'approved'],
      ['changes', 'changes_requested'],
      ['required', 'pending'],
      ['empty decision', 'pending'],
      ['lower case decision', 'pending'],
      ['draft', 'draft'],
      ['draft and approved', 'draft'],
      ['no draft member', 'pending'],
    ]
    for (const [name, state] of want) check(`${name}: ${state}`, stateOf(name) === state, show(got.get(name)))
    check('a state that is not exactly MERGED or CLOSED still shows the pull request', stateOf('lower case state') === 'pending', show(got.get('lower case state')))
    check('an answer with no state shows the pull request', stateOf('no state member') === 'pending', show(got.get('no state member')))
    check('an answer with no head branch shows the pull request', stateOf('no head member') === 'pending', show(got.get('no head member')))
  }

  section('§4 nothing to show is null, and nothing is ever thrown')
  {
    for (const name of ['gh fails with an answer', 'gh fails with nothing', 'nothing', 'blanks', 'head main', 'head master', 'merged', 'closed', 'number as text', 'no number', 'no url', 'url as number', 'not JSON', 'JSON null', 'JSON list']) {
      check(`${name}: null`, isNull(got.get(name)), show(got.get(name)))
    }
    check('no case rejected', cases.every(one => got.get(one.name)?.rejected === undefined), cases.filter(one => got.get(one.name)?.rejected !== undefined).map(one => one.name).join(', '))
  }
} finally {
  removeScratch(scratch)
}

if (failures > 0) {
  console.error(`\nprove-gh-pr-status-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-gh-pr-status-behaviour: all green')
