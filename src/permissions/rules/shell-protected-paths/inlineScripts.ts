import { getMercuryHome } from '../../../platform/environment/envUtils.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'
import type { Layer } from '../decision/commandAnalysis.js'

const SCRIPT_LANGUAGES = /^(?:node|nodejs|bun|deno|python[\d.]*|ruby|perl|php|lua)$/

export function inlineScriptOfArgv(program: string, argv: readonly string[]): string | null {
  if (!SCRIPT_LANGUAGES.test(program)) return null
  const flag = argv.findIndex((word, i) => i > 0 && /^-(?:e|c|p|E|r|command)$/i.test(word))
  return flag >= 0 ? argv.slice(flag + 1).join(' ') : null
}

export function inlineScriptOf(layer: Layer): string | null {
  return inlineScriptOfArgv(layer.program, layer.argv)
}

export function normalizeInlineScript(script: string): string {
  const home = (hostEnv().HOME || hostEnv().USERPROFILE || '').replace(/\\/g, '/')
  const config = getMercuryHome().replace(/\\/g, '/')
  const exe = process.execPath.replace(/\\/g, '/')
  return script
    .replace(/\bprocess\.execPath\b/g, JSON.stringify(exe))
    .replace(/(?:os\.environ(?:\.get)?\s*[\[(]\s*(['"])MERCURY_CONFIG_DIR\1\s*[\])]|process\.env\.MERCURY_CONFIG_DIR)\s*\+\s*(['"])([^'"\r\n]+)\2/g, (_m, _q1, q2, rest) => `${q2}${config}${rest}${q2}`)
    .replace(/(?:os\.environ(?:\.get)?\s*[\[(]\s*(['"])(?:HOME|USERPROFILE)\1\s*[\])]|os\.path\.expanduser\s*\(\s*(['"])~\2\s*\)|(?:os\.)?homedir\s*\(\s*\)|process\.env\.(?:HOME|USERPROFILE))\s*\+\s*(['"])([^'"\r\n]+)\3/g, (_m, _q1, _q2, q3, rest) => `${q3}${home}${rest}${q3}`)
}

export function inlineScriptWrites(rawScript: string, spans?: Map<string, string>): string[] {
  const script = normalizeInlineScript(rawScript)
  const out: string[] = []
  const add = (call: RegExpMatchArray, ...paths: string[]): void => {
    const prefix = script.slice(0, call.index)
    const location = `${prefix.split('\n').length}:${prefix.length - prefix.lastIndexOf('\n')}`
    for (const path of paths) {
      out.push(path)
      spans?.set(path, `code at ${location}: ${call[0]}`)
    }
  }
  for (const call of script.matchAll(/(?:\b(?:write\w*|append\w*|rm\w*|unlink\w*|delete\w*|truncate\w*|rename\w*|remove\w*|rmtree|chmod\w*|chown\w*)|\.write_text|\.write_bytes)\s*\(\s*(['"])([^'"\r\n]+)\1/g)) {
    add(call, call[2]!)
  }
  for (const call of script.matchAll(/\b(?:copy\w*|move|rename)\s*\(\s*(['"])([^'"\r\n]+)\1\s*,\s*(['"])([^'"\r\n]+)\3/g)) {
    add(call, call[4]!, call[2]!)
  }
  const replacements = new Set(['os\\.replace'])
  const constructors = new Set(['Path', 'pathlib\\.Path'])
  for (const imported of script.matchAll(/\bimport\s+(os|pathlib)\s+as\s+(\w+)/g)) {
    if (imported[1] === 'os') replacements.add(`${imported[2]}\\.replace`)
    else constructors.add(`${imported[2]}\\.Path`)
  }
  for (const imported of script.matchAll(/\bfrom\s+(os|pathlib)\s+import\s+([^;\n]+)/g)) {
    for (const name of imported[2]!.split(',')) {
      const binding = /^\s*(replace|Path)(?:\s+as\s+(\w+))?\s*$/.exec(name)
      if (binding?.[1] === 'replace' && imported[1] === 'os') replacements.add(binding[2] ?? 'replace')
      if (binding?.[1] === 'Path' && imported[1] === 'pathlib') constructors.add(binding[2] ?? 'Path')
    }
  }
  const literal = String.raw`(['"])([^'"\r\n]+)\1`
  for (const call of script.matchAll(new RegExp(String.raw`\b(?:${[...replacements].join('|')})\s*\(\s*${literal}\s*,\s*(['"])([^'"\r\n]+)\3`, 'g'))) {
    add(call, call[4]!, call[2]!)
  }
  const constructor = String.raw`\b(?:${[...constructors].join('|')})\s*\(\s*${literal}\s*\)`
  for (const call of script.matchAll(new RegExp(String.raw`${constructor}\s*\.\s*(?:write_text|write_bytes|unlink|rmdir|touch|chmod|replace|rename)\b(?:\s*\(\s*(['"])([^'"\r\n]+)\3)?`, 'g'))) {
    add(call, call[2]!)
    if (/\.(?:replace|rename)\s*\(/.test(call[0]) && call[4]) add(call, call[4])
  }
  for (const assigned of script.matchAll(new RegExp(String.raw`\b(\w+)\s*=\s*(?:${[...constructors].join('|')})\s*\(\s*(['"])([^'"\r\n]+)\2\s*\)`, 'g'))) {
    for (const call of script.matchAll(new RegExp(String.raw`\b${assigned[1]}\s*\.\s*(?:replace|rename)\s*\(\s*${literal}`, 'g'))) {
      add(call, call[2]!, assigned[3]!)
    }
  }
  for (const call of script.matchAll(/\bopen\s*\(\s*(['"])([^'"\r\n]+)\1\s*(?:,\s*(?:mode\s*=\s*)?(['"])([^'"\r\n]*)\3)?/g)) {
    const mode = call[4] ?? ''
    if (/[wax+]/.test(mode) || /\.write(?:lines)?\s*\(/.test(script)) add(call, call[2]!)
  }
  return out
}

export function inlineScriptWriteTargets(script: string): string[] {
  return inlineScriptWrites(script)
}

export function inlineScriptReads(rawScript: string): string[] {
  const script = normalizeInlineScript(rawScript)
  if (!/\b(?:read\w*|open|load\w*|Get-Content|ReadAll\w*|ReadLines|OpenRead|Path|cat|type)\b/i.test(script)) return []
  const out: string[] = []
  for (const call of script.matchAll(/(['"])([^'"\r\n]+)\1/g)) out.push(call[2]!)
  return out
}
