import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const ROOT = resolve(import.meta.dir, '../..')
export const BASE = '59a987410603024225009f4dd483b0cfe024fe02'
export function argument(name: string): string | undefined {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
export function git(...args: string[]): string {
  return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trimEnd()
}
export function hasBaseObject(): boolean {
  return spawnSync('git', ['-C', ROOT, 'cat-file', '-e', `${BASE}^{commit}`], { stdio: 'ignore' }).status === 0
}
export function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}
export function baseSources(work: string): string {
  const dest = join(work, 'base')
  if (existsSync(join(dest, 'source-sha'))) {
    if (readFileSync(join(dest, 'source-sha'), 'utf8') !== BASE) throw new Error('base source stamp differs')
    return dest
  }
  mkdirSync(dest, { recursive: true })
  const archive = execFileSync('git', ['-C', ROOT, 'archive', BASE, 'src', 'assets', 'vendor', 'package.json', 'tsconfig.json'], { maxBuffer: 128 * 1024 * 1024 })
  const extracted = spawnSync('tar', ['-xf', '-', '-C', dest], { input: archive })
  if (extracted.status !== 0) throw new Error(`base extraction failed: ${extracted.stderr}`)
  symlinkSync(join(ROOT, 'node_modules'), join(dest, 'node_modules'))
  writeFileSync(join(dest, 'source-sha'), BASE)
  return dest
}
export const median = (values: number[]): number => {
  if (values.length === 0 || values.some(n => !Number.isFinite(n))) throw new Error('a measured sample is missing or invalid')
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
