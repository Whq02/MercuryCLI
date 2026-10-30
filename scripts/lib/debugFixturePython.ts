import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const DEBUGPY_FLOOR = '3.10'

export function reachesDebugpyFloor(interpreter: string): boolean {
  if (!existsSync(interpreter)) return false
  const [major, minor] = DEBUGPY_FLOOR.split('.').map(Number)
  const r = spawnSync(interpreter, ['-c', `import sys; raise SystemExit(0 if sys.version_info >= (${major}, ${minor}) else 1)`], {
    timeout: 20_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  return r.status === 0
}

export function debugFixturePython(root: string): string | null {
  const pack = join(root, 'dist', 'vendor', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
  const onPath = (name: string): string | null => Bun.which(name)
  const candidates = process.platform === 'win32' ? [pack, onPath('python'), onPath('py')] : [pack, '/usr/bin/python3', onPath('python3')]
  for (const candidate of candidates) {
    if (candidate !== null && reachesDebugpyFloor(candidate)) return candidate
  }
  return null
}
