import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { resolveGodotExecutable } from '../../src/services/vulcan/portabilityHealth.ts'

type Probe = { status: number | null; stdout?: string; stderr?: string; signal?: string | null; error?: Error }
export function godotPrerequisiteFailure(probe: Probe): string | null {
  const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`
  const missingRuntime = /dotnet: command not found|\.NET: One of the dependent libraries is missing|failed to load hostfxr/i.test(output)
  if (probe.status === 0 && !missingRuntime) return null
  const reason = output.split('\n').map(line => line.trim()).find(line => /ERROR:|dotnet:|hostfxr|hostpolicy|coreclr/i.test(line))
  return reason ?? probe.error?.message ?? `blank-project startup exited ${probe.status ?? probe.signal ?? 'without a status'}`
}

export async function resolveProofGodot(): Promise<{ resolved: string | null; reason: string | null }> {
  const executable = process.env.GODOT_BIN || (await resolveGodotExecutable({ census: [] })).resolved
  if (!executable) return { resolved: null, reason: 'no Godot executable is available; set GODOT_BIN to a working Godot 4 executable' }
  const scratch = mkdtempSync(join(tmpdir(), 'godot-prerequisite-'))
  try {
    writeFileSync(join(scratch, 'project.godot'), 'config_version=5\n[application]\nconfig/name="proof prerequisite"\n')
    for (const name of ['home', 'config', 'cache', 'data']) mkdirSync(join(scratch, name))
    const probe = spawnSync(executable, ['--headless', '--editor', '--path', scratch, '--quit'], {
      cwd: scratch, encoding: 'utf8', timeout: vshotBudgetMs(15_000), killSignal: 'SIGKILL',
      env: { ...process.env, HOME: join(scratch, 'home'), XDG_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'), XDG_DATA_HOME: join(scratch, 'data') },
    })
    const reason = godotPrerequisiteFailure(probe)
    return reason === null ? { resolved: executable, reason: null } : { resolved: null, reason: `Godot cannot start an empty project: ${reason}; use a working Godot 4 installation or run the live leg in the hosted gate` }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}
