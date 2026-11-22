import { posix } from 'node:path'
import { sep } from 'node:path'
import { notBuilt } from '../pi/holes.js'

const GENERATED_DIRECTORIES = [
  'dist',
  'build',
  'out',
  'output',
  'node_modules',
  'vendor',
  'vendored',
  'third_party',
  'third-party',
  'external',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'coverage',
  '__pycache__',
  '.tox',
  'venv',
  '.venv',
  'target/release',
  'target/debug',
]

export function isGeneratedFile(filePath: string): boolean {
  return notBuilt('src/utils/generatedFiles.ts:72')
}
