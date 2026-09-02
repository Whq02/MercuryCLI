/**
 * YAML parse wrapper preferring the runtime built-in over the npm parser.
 * The npm package is loaded lazily INSIDE the non-Bun branch (synchronous
 * require — the function is synchronous) so a native Bun build never pays
 * for evaluating the ~270 KB parser. Parse errors propagate.
 */
export function parseYaml(input: string): unknown {
  if (typeof Bun !== 'undefined' && (Bun as { YAML?: { parse: (s: string) => unknown } }).YAML) {
    return (Bun as unknown as { YAML: { parse: (s: string) => unknown } }).YAML.parse(input)
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parse } = require('yaml') as { parse: (s: string) => unknown }
  return parse(input)
}
