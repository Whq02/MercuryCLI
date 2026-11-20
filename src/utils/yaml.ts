export function parseYaml(input: string): unknown {
  if (typeof Bun !== 'undefined') {
    const yaml = (Bun as { YAML?: { parse: (s: string) => unknown } }).YAML
    if (yaml) return yaml.parse(input)
  }
  const { parse } = require('yaml') as { parse: (s: string) => unknown }
  return parse(input)
}
