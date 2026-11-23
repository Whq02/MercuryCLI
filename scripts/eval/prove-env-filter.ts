#!/usr/bin/env bun
import { execSync } from 'node:child_process'
import { check, cleanup, finish, refusingBridge, loadEval, section, setup, within } from './lib.js'

const { work } = setup()

const hintedCheck = (label: string, cond: boolean, detail: string | undefined, hint: string): void =>
  check(label, cond, cond ? detail : `${detail ? `${detail}; ` : ''}${hint}`)
const { credentialEnvNames } = await import('../../src/models/sign-in/account-ledger/providerSecrets.js')
const { isDeniedKernelEnvName, buildKernelEnv } = await import('../../src/tools/engines/eval-kernels/kernelEnv.js')
const { evalKernelManager } = await loadEval()

section('the enumeration mirrors real resolvers (anti-drift)')
const names = credentialEnvNames()
hintedCheck('the enumeration is non-trivial', names.length >= 10, String(names.length), 'credentialEnvNames in src/models/sign-in/account-ledger/providerSecrets.ts returned too few names')
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
      .filter(file => !file.includes('models/sign-in/account-ledger/providerSecrets.ts') && !file.includes('services/eval/'))
  } catch {
    hits = []
  }
  hintedCheck(`${name} has a live reader in src`, hits.length > 0, hits[0] ?? '', 'no file under src outside services/eval reads this name; drop it from credentialEnvNames in src/models/sign-in/account-ledger/providerSecrets.ts or add its reader')
}

section('the pure filter: derived names, suffix belt, allowed rest')
for (const name of names) hintedCheck(`${name} denied`, isDeniedKernelEnvName(name), undefined, 'isDeniedKernelEnvName in src/tools/engines/eval-kernels/kernelEnv.ts must deny every name credentialEnvNames returns')
hintedCheck('generic _TOKEN suffix denied', isDeniedKernelEnvName('SOME_VENDOR_TOKEN'), undefined, 'SECRET_SUFFIX in src/tools/engines/eval-kernels/kernelEnv.ts must match names ending in _TOKEN')
hintedCheck('generic _SECRET suffix denied', isDeniedKernelEnvName('MY_APP_SECRET'), undefined, 'SECRET_SUFFIX in src/tools/engines/eval-kernels/kernelEnv.ts must match names ending in _SECRET')
hintedCheck('GITHUB_TOKEN denied (extra belt)', isDeniedKernelEnvName('GITHUB_TOKEN'), undefined, 'EXTRA_DENY in src/tools/engines/eval-kernels/kernelEnv.ts must list GITHUB_TOKEN')
hintedCheck('PATH allowed', !isDeniedKernelEnvName('PATH'), undefined, 'isDeniedKernelEnvName in src/tools/engines/eval-kernels/kernelEnv.ts denies PATH; narrow its deny rules')
hintedCheck('HOME allowed', !isDeniedKernelEnvName('HOME'), undefined, 'isDeniedKernelEnvName in src/tools/engines/eval-kernels/kernelEnv.ts denies HOME; narrow its deny rules')
hintedCheck('VIRTUAL_ENV allowed', !isDeniedKernelEnvName('VIRTUAL_ENV'), undefined, 'isDeniedKernelEnvName in src/tools/engines/eval-kernels/kernelEnv.ts denies VIRTUAL_ENV; narrow its deny rules')
const built = buildKernelEnv({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-x', INNOCENT_VAR: 'yes' })
hintedCheck('buildKernelEnv strips the credential', !('ANTHROPIC_API_KEY' in built), undefined, 'buildKernelEnv in src/tools/engines/eval-kernels/kernelEnv.ts must drop names isDeniedKernelEnvName denies')
hintedCheck('buildKernelEnv keeps the innocent var', built.INNOCENT_VAR === 'yes', undefined, 'buildKernelEnv in src/tools/engines/eval-kernels/kernelEnv.ts must copy names that are not denied')
hintedCheck('buildKernelEnv pins MPLBACKEND=Agg', built.MPLBACKEND === 'Agg', undefined, 'buildKernelEnv in src/tools/engines/eval-kernels/kernelEnv.ts must set MPLBACKEND to Agg')
hintedCheck('buildKernelEnv pins PYTHONUNBUFFERED', built.PYTHONUNBUFFERED === '1', undefined, 'buildKernelEnv in src/tools/engines/eval-kernels/kernelEnv.ts must set PYTHONUNBUFFERED to 1')

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
  hintedCheck('probe cell ran', probe.status === 'ok', JSON.stringify(probe.error ?? probe.annotations), 'the py kernel did not run the probe cell; read the error above and src/tools/engines/eval-kernels/kernelManager.ts runCell')
  hintedCheck('ZERO credentials visible in the kernel', (probe.resultRepr ?? '').includes('([], '), probe.resultRepr, 'the kernel env still holds a planted name; the kernel must start from buildKernelEnv in src/tools/engines/eval-kernels/kernelEnv.ts')
  hintedCheck('the innocent var passed through', (probe.resultRepr ?? '').includes("'visible'"), probe.resultRepr, 'buildKernelEnv in src/tools/engines/eval-kernels/kernelEnv.ts removed a name it should keep, or the kernel does not use it')
} finally {
  for (const name of planted) delete process.env[name]
  delete process.env.EVIL_EXTRA_TOKEN
  delete process.env.EVAL_PROVER_INNOCENT
  await evalKernelManager.disposeAll()
  cleanup()
}
finish('ENV-FILTER')
