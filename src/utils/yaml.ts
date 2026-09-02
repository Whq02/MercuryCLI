export function parseYaml(input: string): unknown {
  if (typeof Bun !== 'undefined' && (Bun as { YAML?: { parse: (s: string) => unknown } }).YAML) {
    return (Bun as unknown as { YAML: { parse: (s: string) => unknown } }).YAML.parse(input)
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parse } = require('yaml') as { parse: (s: string) => unknown }
  return parse(input)
}
