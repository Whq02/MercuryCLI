import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { PYTHON3 } from '../lib/python3.ts'

const psWords = (line: string): string[] => {
  const words: string[] = []
  const token = /('(?:[^']|'')*'|[a-zA-Z0-9_-]+)(?:\s+|$)/y
  let offset = 0
  while (offset < line.length) {
    token.lastIndex = offset
    const match = token.exec(line)
    assert.ok(match, 'the fixture accepts only literal PowerShell arguments: ' + line)
    const word = match[1]!
    words.push(word.startsWith("'") ? word.slice(1, -1).replaceAll("''", "'") : word)
    offset = token.lastIndex
  }
  return words
}

export function boxScriptText(command: string, args: string[]): string {
  if (command === 'powershell.exe' && args[2] === '-EncodedCommand' && args[3]) return Buffer.from(args[3], 'base64').toString('utf16le')
  if (command === '/bin/sh' && args[0] === '-c' && args[1] !== undefined) return args[1]
  return args.join(' ')
}

export function bankDownloadWords(command: string, args: string[]): string[] | undefined {
  if (command === '/bin/sh' && args[1]?.includes(' download ')) {
    const syntax = spawnSync('bash', ['-n', '-c', args[1]], { encoding: 'utf8' })
    assert.equal(syntax.status, 0, syntax.stderr)
    const line = args[1].split('\n').find(row => row.includes(' download '))!
    const parsed = spawnSync(PYTHON3, ['-c', 'import json,shlex,sys; print(json.dumps(shlex.split(sys.argv[1])))', line], { encoding: 'utf8' })
    assert.equal(parsed.status, 0, parsed.stderr)
    return JSON.parse(parsed.stdout)
  }
  if (command !== 'powershell.exe') return undefined
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand'])
  assert.equal(args.length, 4)
  const script = Buffer.from(args[3]!, 'base64').toString('utf16le')
  assert.equal(Buffer.from(script, 'utf16le').toString('base64'), args[3])
  const lines = script.split('\n')
  assert.equal(lines.length, 8)
  assert.deepEqual(lines.slice(0, 2), ["$ErrorActionPreference='Stop'", "$ProgressPreference='SilentlyContinue'"])
  assert.ok(lines[2]!.startsWith('python -m venv '))
  const venv = psWords(lines[2]!.slice('python -m venv '.length))
  assert.equal(venv.length, 1)
  assert.ok(lines[3]!.startsWith('& '))
  const install = psWords(lines[3]!.slice(2))
  assert.equal(install[0]!.replaceAll('\\', '/'), venv[0]!.replaceAll('\\', '/') + '/Scripts/pip.exe')
  assert.deepEqual(install.slice(1), ['install', '--upgrade', 'huggingface_hub'])
  assert.equal(lines[4], 'if ($LASTEXITCODE -ne 0) { throw "pip install failed" }')
  assert.ok(lines[5]!.startsWith('& '))
  const words = psWords(lines[5]!.slice(2))
  assert.equal(words[0]!.replaceAll('\\', '/'), venv[0]!.replaceAll('\\', '/') + '/Scripts/hf.exe')
  assert.equal(words[1], 'download')
  assert.ok(words.indexOf('--local-dir') > 2 && words.indexOf('--local-dir') === words.length - 2)
  assert.equal(lines[6], 'if ($LASTEXITCODE -ne 0) { throw "download failed" }')
  assert.equal(lines[7], '')
  return words
}
