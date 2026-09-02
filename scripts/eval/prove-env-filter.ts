#!/usr/bin/env bun
import { execSync } from 'node:child_process'
import { check, cleanup, finish, refusingBridge, loadEval, section, setup, within } from './lib.js'

const { work } = setup()
const { credentialEnvNames } = await import('../../src/utils/router/providerSecrets.js')
const { isDeniedKernelEnvName, buildKernelEnv } = await import('../../src/services/eval/kernelEnv.js')
const { evalKernelManager } = await loadEval()

section('the enumeration mirrors real resolvers (anti-drift)')
const names = credentialEnvNames()
check('the enumeration is non-trivial', names.length >= 10, String(names.length))
for (const name of names) {
  let hits: string[] = []
  try {
    hits = execSync(`grep -rlF ${JSON.stringify(name)} src --include='*.ts' --include='*.tsx' || true`, {
      encoding: 'utf8',
      cwd: process.cwd(),
    })
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .filter(file => !file.includes('utils/router/providerSecrets.ts') && !file.includes('services/eval/'))
  } catch {
    hits = []
  }
  check(`${name} has a live reader in src`, hits.length > 0, hits[0] ?? '')
}

section('the pure filter: derived names, suffix belt, allowed rest')
for (const name of names) check(`${name} denied`, isDeniedKernelEnvName(name))
check('generic _TOKEN suffix denied', isDeniedKernelEnvName('SOME_VENDOR_TOKEN'))
check('generic _SECRET suffix denied', isDeniedKernelEnvName('MY_APP_SECRET'))
check('GITHUB_TOKEN denied (extra belt)', isDeniedKernelEnvName('GITHUB_TOKEN'))
check('PATH allowed', !isDeniedKernelEnvName('PATH'))
check('HOME allowed', !isDeniedKernelEnvName('HOME'))
check('VIRTUAL_ENV allowed', !isDeniedKernelEnvName('VIRTUAL_ENV'))
const built = buildKernelEnv({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-x', INNOCENT_VAR: 'yes' })
check('buildKernelEnv strips the credential', !('ANTHROPIC_API_KEY' in built))
check('buildKernelEnv keeps the innocent var', built.INNOCENT_VAR === 'yes')
check('buildKernelEnv pins MPLBACKEND=Agg', built.MPLBACKEND === 'Agg')
check('buildKernelEnv pins PYTHONUNBUFFERED', built.PYTHONUNBUFFERED === '1')

section('a LIVE kernel sees none of the planted credentials')
const planted: string[] = []
for (const name of names) {
  process.env[name] = `planted-${name}`
  planted.push(name)
}
process.env.EVIL_EXTRA_TOKEN = 'planted-extra'
process.env.EVAL_PROVER_INNOCENT = 'visible'
try {
  const probe = await within(
    'env probe cell',
    60_000,
    evalKernelManager.runCell({
      owner: 'env-owner',
      cwd: work,
      input: {
        language: 'py',
        code: `leaked = [n for n in ${JSON.stringify([...planted, 'EVIL_EXTRA_TOKEN'])} if n in env]\nok = env.get('EVAL_PROVER_INNOCENT')\nrepr((leaked, ok))`,
      },
      abortSignal: new AbortController().signal,
      serveBridge: refusingBridge(),
    }),
  )
  check('probe cell ran', probe.status === 'ok', JSON.stringify(probe.error ?? probe.annotations))
  check('ZERO credentials visible in the kernel', (probe.resultRepr ?? '').includes('([], '), probe.resultRepr)
  check('the innocent var passed through', (probe.resultRepr ?? '').includes("'visible'"), probe.resultRepr)
} finally {
  for (const name of planted) delete process.env[name]
  delete process.env.EVIL_EXTRA_TOKEN
  delete process.env.EVAL_PROVER_INNOCENT
  await evalKernelManager.disposeAll()
  cleanup()
}
finish('ENV-FILTER')
