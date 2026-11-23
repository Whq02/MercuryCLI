#!/usr/bin/env bun
// gate-watch: src/permissions/wards/wards.ts src/permissions/wards/wardsRefusals.ts src/permissions/wards/wardsShellRead.ts src/permissions/guards/wardsGuard.ts src/engine/cwdMemo.ts src/platform/files/cwd.ts src/platform/substrate/flagRegistry.ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { withProofAccountHome } from '../lib/proofAccountHome.ts'

const scratch = withProofAccountHome()
const configScratch = realpathSync(mkdtempSync(join(tmpdir(), 'ward-path-')))
const project = join(scratch, 'hunt')
const inside = join(project, 'scratch-dir', 'zzz-test')
mkdirSync(inside, { recursive: true })
const canary = join(project, 'CANARY')
writeFileSync(canary, 'alive')
const outside = join(scratch, 'outside-decoy')
mkdirSync(outside, { recursive: true })
mkdirSync(join(configScratch, 'home'), { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(configScratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = '', fix = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!ok && fix ? ` — to fix: ${fix}` : ''}`)
}
const FIX_RESOLVE = 'makeTargetResolver in src/permissions/guards/wardsGuard.ts must resolve the target to a real path inside the project, and the delete rules of evaluateWards in src/permissions/wards/wards.ts must allow a resolved in-project target'
const FIX_HOLE = 'evaluateWards in src/permissions/wards/wards.ts (rule no-home-recursive-delete) must keep refusing a target that resolves outside the project'
const FIX_HOOK = 'registerWardsGuard in src/permissions/guards/wardsGuard.ts must route Bash calls through evaluateWards with the project resolver'

type PendingToolCall = import('../../src/permissions/wards/wards.js').PendingToolCall
const { AUTONOMOUS_WARDS, evaluateWards } = await import('../../src/permissions/wards/wards.js')
const { deleteWardActive, makeTargetResolver, WARDS_HOOK_ID, registerWardsGuard, resetWardsEngagedSessionsForTest } = await import('../../src/permissions/guards/wardsGuard.js')
const { judgeToolCall } = await import('../../src/permissions/guards/guards.js')
const { runWithCwdOverride } = await import('../../src/platform/files/cwd.js')

const bash = (command: string, resolvePath?: PendingToolCall['resolvePath']): PendingToolCall => ({
  toolName: 'Bash',
  input: { command },
  shellCommand: command,
  ...(resolvePath ? { resolvePath } : {}),
})

try {
  console.log('delete-ward resolves the path — SH-02')
  check('the account home is the fixture, not the invoking account', homedir() === scratch, '', 'withProofAccountHome in scripts/lib/proofAccountHome.ts must point the account home at the scratch folder')
  process.env.MERCURY_SPAWNED_BY = 'proof:ward-path#1'
  check('the autonomous delete-ward is armed (MERCURY_SPAWNED_BY set)', deleteWardActive(), '', 'deleteWardActive in src/permissions/guards/wardsGuard.ts must be true while MERCURY_SPAWNED_BY is set')

  const projectReal = realpathSync(project)
  const homeReal = homedir()
  const outsideReal = realpathSync(outside)
  const resolveInProject = makeTargetResolver(projectReal)

  const absoluteInside = `rm -rf ${join(projectReal, 'scratch-dir', 'zzz-test')}`
  const relativeInside = 'rm -rf scratch-dir/zzz-test'
  const absoluteOutside = `rm -rf ${outsideReal}`
  const absoluteHome = `rm -rf ${homeReal}`

  {
    const stringOnly = evaluateWards(AUTONOMOUS_WARDS, bash(absoluteInside))
    check(
      'BASE (string match only): the in-project absolute delete is warded today — the bug this proof pins',
      !stringOnly.allow && stringOnly.rule.name === 'no-home-recursive-delete',
      stringOnly.allow ? 'unexpectedly allowed' : stringOnly.rule.name,
      'the rule no-home-recursive-delete in src/permissions/wards/wards.ts must refuse a bare absolute delete when no resolver is given',
    )
    const resolved = evaluateWards(AUTONOMOUS_WARDS, bash(absoluteInside, resolveInProject))
    check(
      "absolute-path delete INSIDE the project passes the autonomous ward (it is the project's own)",
      resolved.allow,
      resolved.allow ? '' : `denied by ${resolved.rule.name}`,
      FIX_RESOLVE,
    )
    const relative = evaluateWards(AUTONOMOUS_WARDS, bash(relativeInside, resolveInProject))
    check('the relative-path spelling passes the ward (parity with the card road)', relative.allow, '', FIX_RESOLVE)

    const stillWarded = evaluateWards(AUTONOMOUS_WARDS, bash(absoluteOutside, resolveInProject))
    check(
      'the same delete OUTSIDE the project stays warded',
      !stillWarded.allow && stillWarded.rule.name === 'no-home-recursive-delete',
      stillWarded.allow ? 'ALLOWED (hole!)' : stillWarded.rule.name,
      FIX_HOLE,
    )
    const homeWarded = evaluateWards(AUTONOMOUS_WARDS, bash(absoluteHome, resolveInProject))
    check(
      'a recursive delete of the home itself stays warded',
      !homeWarded.allow,
      homeWarded.allow ? 'ALLOWED (hole!)' : homeWarded.rule.name,
      FIX_HOLE,
    )
    const literalUsersDelete = `rm -rf /Users/proof-decoy`
    const literalUsers = evaluateWards(AUTONOMOUS_WARDS, bash(literalUsersDelete, resolveInProject))
    check(
      'a home-shaped path that resolves to NO real folder (nothing to resolve against) stays warded',
      !literalUsers.allow,
      literalUsers.allow ? 'ALLOWED (hole!)' : literalUsers.rule.name,
      FIX_HOLE,
    )
  }

  {
    const store = { state: { sessionHooks: new Map() }, set(fn: (p: never) => never) { this.state = fn(this.state) } }
    resetWardsEngagedSessionsForTest()
    const id = await runWithCwdOverride(projectReal, () => registerWardsGuard(store.set as never, 'ward-path-proof'))
    check('the wards guard registered in the project cwd', id === WARDS_HOOK_ID, '', 'registerWardsGuard in src/permissions/guards/wardsGuard.ts must return WARDS_HOOK_ID when called under the project cwd')

    const judge = async (command: string): Promise<string | true> => {
      const verdict = await judgeToolCall('ward-path-proof', {
        tool: 'Bash',
        input: { command },
        callId: `ward-path-${command.length}`,
        messages: [],
        toolRef: { name: 'Bash', shellCommandOf: (value: { command?: unknown }) => (typeof value.command === 'string' ? value.command : undefined) } as never,
      })
      if (verdict.refused) return verdict.reason
      return true
    }

    const insideVerdict = await judge(absoluteInside)
    check(
      'the hook road lets the in-project absolute delete through (the card decides)',
      insideVerdict === true,
      typeof insideVerdict === 'string' ? insideVerdict.slice(0, 100) : '',
      FIX_HOOK,
    )
    const outsideVerdict = await judge(absoluteOutside)
    check(
      "the hook road still wards the outside delete with the rule named",
      typeof outsideVerdict === 'string' && outsideVerdict.includes("Ward 'no-home-recursive-delete'"),
      typeof outsideVerdict === 'string' ? outsideVerdict.slice(0, 100) : 'ALLOWED (hole!)',
      FIX_HOOK,
    )
    const homeVerdict = await judge(absoluteHome)
    check(
      'the hook road wards a delete of the whole home',
      typeof homeVerdict === 'string' && (homeVerdict.includes("Ward 'no-home-recursive-delete'") || homeVerdict.includes("Ward 'no-root-recursive-delete'")),
      typeof homeVerdict === 'string' ? homeVerdict.slice(0, 100) : 'ALLOWED (hole!)',
      FIX_HOOK,
    )

    const rootDelete = await judge('rm -rf /')
    check(
      "the refuse-list still refuses rm -rf / on the same hook (no weakening)",
      typeof rootDelete === 'string' && rootDelete.includes("Ward 'no-root-recursive-delete'"),
      typeof rootDelete === 'string' ? rootDelete.slice(0, 80) : 'ALLOWED (hole!)',
      'the rule no-root-recursive-delete in src/permissions/wards/wards.ts must still refuse rm -rf / and be reached by the hook in src/permissions/guards/wardsGuard.ts',
    )
    const homeTilde = await judge('rm -rf ~')
    check(
      "the refuse-list still refuses rm -rf ~ (no weakening)",
      typeof homeTilde === 'string' && homeTilde.includes("Ward 'no-root-recursive-delete'"),
      typeof homeTilde === 'string' ? homeTilde.slice(0, 80) : 'ALLOWED (hole!)',
      'the rule no-root-recursive-delete in src/permissions/wards/wards.ts must still refuse rm -rf ~ and be reached by the hook in src/permissions/guards/wardsGuard.ts',
    )
  }

  {
    const nested = join(projectReal, 'a', 'b', 'c', 'deep-delete')
    mkdirSync(nested, { recursive: true })
    const nestedVerdict = evaluateWards(AUTONOMOUS_WARDS, bash(`rm -rf ${nested}`, resolveInProject))
    check('a deeply nested in-project absolute delete passes', nestedVerdict.allow, '', FIX_RESOLVE)

    const escapedVerdict = evaluateWards(AUTONOMOUS_WARDS, bash(`rm -rf ${join(projectReal, '..', 'escape-target')}`, resolveInProject))
    check(
      'a ..-escape OUT of the project by absolute path stays warded',
      !escapedVerdict.allow,
      escapedVerdict.allow ? 'ALLOWED (hole!)' : escapedVerdict.rule.name,
      'makeTargetResolver in src/permissions/guards/wardsGuard.ts must normalise .. before it decides the target is inside the project',
    )

    const findInside = `find ${join(projectReal, 'scratch-dir')} -name "*.log" -delete`
    check(
      'find <in-project absolute path> -delete passes',
      evaluateWards(AUTONOMOUS_WARDS, bash(findInside, resolveInProject)).allow,
      '',
      'the find -delete rule of evaluateWards in src/permissions/wards/wards.ts must resolve its path through the project resolver',
    )
    const findVerdict = evaluateWards(AUTONOMOUS_WARDS, bash(`find ${outsideReal} -name "*.log" -delete`, resolveInProject))
    check(
      'find <outside absolute path> -delete stays warded',
      !findVerdict.allow,
      findVerdict.allow ? 'ALLOWED (hole!)' : findVerdict.rule.name,
      'the find -delete rule of evaluateWards in src/permissions/wards/wards.ts must keep refusing a path outside the project',
    )

    const unresolvable = evaluateWards(AUTONOMOUS_WARDS, bash(`rm -rf ${join(projectReal, 'does-not-exist-yet', 'x')}`, resolveInProject))
    check(
      'an in-project path that does not exist yet still passes (the project prefix is resolvable)',
      unresolvable.allow,
      unresolvable.allow ? '' : `denied by ${unresolvable.rule.name}`,
      'makeTargetResolver in src/permissions/guards/wardsGuard.ts must resolve the existing project prefix of a path whose tail does not exist yet',
    )

    check(
      'the literal home form of the in-project delete resolves inside and passes',
      evaluateWards(AUTONOMOUS_WARDS, bash(`rm -rf ${projectReal}/scratch-dir/zzz-test`, resolveInProject)).allow,
      '',
      FIX_RESOLVE,
    )
  }

  check(
    'the canary survived and no decoy was touched — nothing was ever run',
    existsSync(canary) && existsSync(join(outside, '.')) && existsSync(inside),
    '',
    'something executed a delete: the proof must only evaluate commands, so look at which verdict above allowed a real rm and at src/permissions/guards/wardsGuard.ts',
  )
  console.log(`ward-path: ${passed} passed, ${failed} failed`)
} finally {
  delete process.env.MERCURY_SPAWNED_BY
  rmSync(configScratch, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
