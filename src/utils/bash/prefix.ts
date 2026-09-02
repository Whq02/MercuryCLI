/**
 * Spec-driven (non-model) bash command-prefix computation.
 *
 * The computation needs a structural parse of each subcommand, and the bash
 * parser lane is not shipped in this build:
 * every parse answers "no tree", so no subcommand ever yields a static
 * prefix and the compound entry resolves to an empty list for every input.
 * The entry keeps its exported shape while its remaining consumer (the bash
 * permission card) still calls it; the wrapper walk, spec lookup and
 * word-aligned collapse rules it would drive live in the slice spec as the
 * archive.
 */

/**
 * Static compound prefixes for a whole command line. With no parser lane
 * there is nothing to compute: the answer is always the empty list, so the
 * exclusion predicate is never consulted.
 */
export async function getCompoundCommandPrefixesStatic(
  _command: string,
  _excludeSubcommand?: (subcommand: string) => boolean,
): Promise<string[]> {
  return []
}
