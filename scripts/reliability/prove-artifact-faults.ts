
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

let failures = 0
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}`)
  if (!cond) failures++
}

const REPO = join(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')

if (!existsSync(DIST)) {
  console.error('❌ artifact faults: dist/mercury.mjs missing')
  process.exit(1)
}

const tmp = mkdtempSync(join(tmpdir(), 'mercury-artifact-faults-'))
const home = join(tmp, 'home')
const daemon = join(tmp, 'daemon')
const project = join(tmp, 'project')
for (const d of [home, daemon, project]) mkdirSync(d, { recursive: true })

const childEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: daemon,
  MERCURY_PARTY: '0',
  MERCURY_SESSION_ROOM: '',
  MERCURY_ROOM_TOKEN: '',
  MERCURY_FAULT_INJECT: '',
  ...extra,
})

const nodeArgs = (args: string[]) => [DIST, ...args]

function runHealth(deep: boolean): { status: number | null; cert: unknown } {
  const res = spawnSync(
    'node',
    nodeArgs(['health', '--json', ...(deep ? ['--deep'] : [])]),
    {
      cwd: project,
      env: childEnv({ ANTHROPIC_API_KEY: 'fixture-anthropic-key' }),
      encoding: 'utf8',
      timeout: deep ? 180_000 : 60_000,
    },
  )
  let cert: unknown = null
  try {
    cert = JSON.parse(res.stdout)
  } catch {
  }
  return { status: res.status, cert }
}

type Check = { id: string; status: string; evidence: string; fix?: string }
function checksOf(cert: unknown, sectionId: string): Check[] {
  const sections = (cert as { sections?: Array<{ id: string; checks: Check[] }> })?.sections ?? []
  return sections.find(s => s.id === sectionId)?.checks ?? []
}

console.log('— A. health --json --deep on the artifact —')
{
  const { status, cert } = runHealth(true)
  ok(status === 0 && cert !== null, `deep health emitted a certificate with a credential present (exit ${status})`)
  const durability = checksOf(cert, 'durability')
  const txn = durability.find(c => c.id === 'durable-transaction')
  ok(txn?.status === 'ok', `durable-transaction probe ok in the bundle (${txn?.evidence?.slice(0, 80) ?? 'MISSING'})`)
  for (const id of ['durable-journals', 'store-quarantines', 'orphan-temps'] as const) {
    const c = durability.find(x => x.id === id)
    ok(c?.status === 'ok', `${id} ok on a pristine home (${c?.status ?? 'MISSING'})`)
  }
  const kernel = checksOf(cert, 'run-kernel').find(c => c.id === 'run-kernel-roundtrip')
  ok(kernel?.status === 'ok', `run-kernel deep probe still ok beside the durability section (${kernel?.status})`)
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ artifact faults: ALL PASS' : `\n❌ artifact faults: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
