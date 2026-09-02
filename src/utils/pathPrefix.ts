// ============================================================================
//  pathPrefix — is this path the directory, or inside it, whatever the
//  separator spelling?
//
//  The plan/agent-output tool rows tested `filePath.startsWith(`${dir}/`)`
//  against directories built by path.join() — on win32 join emits '\', so
//  the POSIX needle could never prefix a native path and the rows never
//  resolved (TASK-017 supplement 3, TS-2: `● Read  ~\.mercury\plans\…`
//  instead of `● Read plan`). The same class the /realms home-root fold
//  closed at its own door: normalise the separators, fold case on win32
//  (NTFS matches insensitively), then one prefix test. Display-scope
//  helper — permission decisions keep their own owners.
// ============================================================================

const foldFor = (platform: NodeJS.Platform) => (s: string): string => {
  const normalised = s.replace(/\\/g, '/')
  return platform === 'win32' ? normalised.toLowerCase() : normalised
}

/** True when `filePath` IS `dir` or lives under it, on either separator
 *  spelling (mixed spellings included — the model writes POSIX paths at
 *  native directories). `platform` is injectable for the pins. */
export function isPathInside(filePath: string, dir: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = foldFor(platform)
  const f = fold(filePath)
  const d = fold(dir)
  return f === d || f.startsWith(`${d}/`)
}
