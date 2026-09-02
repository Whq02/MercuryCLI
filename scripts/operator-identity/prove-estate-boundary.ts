#!/usr/bin/env bun
// ============================================================================
//  scripts/operator-identity/prove-estate-boundary.ts — the extraction ratchet.
//
//  After MPEXTRACT (ledger L27, lane 1 of the multiplayer retirement) the
//  operator identity lives in src/substrate/identity and the connection
//  primitive in src/services/channel. What still imports the ESTATE —
//  src/caduceus/* and the party estate — from outside is EXACTLY the censused
//  manifest below, each row carrying its retirement class:
//
//    multiplayer-only — dies with the estate (the retirement lane's delete/retire list);
//    seam             — a product file needing only a fact/type that is null
//                       when solo; the lane drops the reference with the
//                       successor named (the C4 law).
//
//  The census's FIFTH class — the pings/attention/dispatch model mis-homed
//  in the estate (attention/ + relations.ts + statusFeed.ts, zero room
//  dependency) — MOVED to src/services/attention at the extraction (the
//  lead's ruling: the class the lane-2 brief lacked, caught BEFORE the
//  delete instead of after). It is one of the guarded extracted homes
//  below now, not a boundary class.
//
//  RED on: any file outside the estate referencing it WITHOUT a manifest row
//  (the creep this ratchet exists to stop), a manifest row that no longer
//  references the estate (moot rows rot the census — remove them), or the
//  extracted homes importing the estate (the extraction ran backwards).
//
//  LOSS FLAGS carried for the retirement lane (mark, never silently delete):
//    · utils/sessionStorage/writer.ts + utils/conversationRecovery.ts ride
//      sessionRoom's transcript mirror — the SIGKILL young-session resume
//      fallback (§TRANSCRIPT-DEBOUNCE-SIGKILL) dies with the estate unless a
//      minimal mirror survives or the JSONL debounce is fixed;
//    · the two-user commands (/handoff /invite /delegate /prompt /request
//      /say) are estate commands beyond the three named retirements (/say ruled retired; the bus stays).
//
//  THE RETIREMENT CENSUS lives HERE: every
//  row names its cluster, its verdict and its successor; the estate paths
//  the walker can never list (estate by construction) are enumerated; and
//  LANDED says which clusters have gone — their paths must stay gone (the
//  never-reappears ratchet) while the others' must still exist.
//
//  Run:  ~/.bun/bin/bun run scripts/operator-identity/prove-estate-boundary.ts
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

// ── the estate ──────────────────────────────────────────────────────────────

/** The party estate outside src/caduceus (file/dir prefixes, repo-relative). */
const PARTY_ESTATE_PREFIXES = [
  'src/components/party/',
  'src/components/PartyConsentCard.tsx',
  'src/tools/MultiplayerTool/',
  'src/commands/party/',
  'src/commands/multiplayer/',
  'src/commands/share-party/',
  'src/daemon/partySpawn.ts',
  'src/daemon/partyStateMirror.ts',
  'src/daemon/partyTopology.ts',
  'src/daemon/partyWorktrees.ts',
  'src/substrate/partyStateStore.ts',
  'src/utils/dungeon/engageParty.ts',
  'src/utils/dungeon/partyRouterSelect.ts',
  'src/utils/party/',
  'src/utils/router/adapters/party.ts',
  'src/services/resources/adapters/party.ts',
  'src/components/mercury-ui/parity/MultiplayerView.tsx',
]

function isEstateFile(rel: string): boolean {
  if (rel.startsWith('src/caduceus/')) return true
  return PARTY_ESTATE_PREFIXES.some(p => (p.endsWith('/') ? rel.startsWith(p) : rel === p))
}

/** Does an import specifier reach into the estate? */
function specifierHitsEstate(spec: string): 'caduceus' | 'party' | null {
  if (spec.includes('/caduceus/') || spec.startsWith('src/caduceus/')) return 'caduceus'
  if (
    /(^|\/)(partyStateStore|partySpawn|partyStateMirror|partyTopology|partyWorktrees|engageParty|partyRouterSelect|PartyConsentCard|PartyBoard)(\.js|\.ts|\.tsx)?$/.test(spec) ||
    spec.includes('MultiplayerTool/') ||
    spec.includes('adapters/party') ||
    spec.includes('parity/MultiplayerView') ||
    spec.includes('dungeon/engageParty') ||
    spec.includes('dungeon/partyRouterSelect') ||
    // the estate's presentation + transcript helpers (the census's blind
    // spot until the retirement lane: pidAlive rode components/party/tones into five
    // product files)
    /(^|\/)party\/(tones|seatTranscript)(\.js|\.ts)?$/.test(spec) ||
    spec.includes('components/party/')
  ) {
    return 'party'
  }
  return null
}

// ── the manifest ────────────────────────

type BoundaryClass = 'multiplayer-only' | 'seam'

/** The retirement verdict — the fate of the FILE carrying the row,
 *  re-derived cold from these rows and a fresh importer grep:
 *    delete — the file is estate; it goes with its cluster;
 *    seam   — the file stays; its estate reference goes, successor named;
 *    move   — the file keeps a FACT that re-homes before the delete. */
type RetireVerdict = 'delete' | 'seam' | 'move'

/** The delete clusters, one commit each, in landing order. */
type RetireCluster = 'fallback' | 'commands' | 'seams' | 'caduceus' | 'party'

type ManifestRow = {
  classes: ReadonlySet<BoundaryClass>
  cluster: RetireCluster
  verdict: RetireVerdict
  successor: string
}

/** file → classes of estate reference it may carry + its retirement verdict. A
 *  file appearing here MUST still reference the estate (moot rows red — a
 *  cluster that lands takes its rows out), and every estate reference
 *  outside the estate MUST have a row (creep reds). */
const MANIFEST: ReadonlyMap<string, ManifestRow> = new Map(
  (
    [
      // (the commands cluster landed: delegate · handoff · invite ×2 · prompt
      //  · request — and the party-prefixed party · multiplayer · share
      //  doors and the /tickets door — became typed retired stubs,
      //  src/commands/retired.ts.)
      // (the caduceus cluster landed: joinMain [`mercury join` + `join-kit`
      //  answer the retired sentence in entrypoints/cli.tsx], JoinScreen,
      //  TicketsView, roomBroker [the exit-cliff 'room-clients' registrant
      //  retired; the drain owner stays], roomRemote and the src/caduceus
      //  tree itself are DELETED — the never-reappears list below holds
      //  them.)
      // (estate→estate imports — the party files importing caduceus and the
      //  reverse — are estate-internal: the walker skips them, no rows.)
      // (the seams cluster landed whole — every consumer dropped its estate
      //  reference with the successor named in the two seams commits: the
      //  party half [the daemon's party block, the crew/coordination/fleet
      //  seat rows, the pickers' party sentinel, the model helpers' party
      //  arms, the party rail, the resource adapter, the tool roster entry;
      //  resolvePartyReconAllow → src/daemon/workerRecon.ts, pidAlive →
      //  src/utils/pidAlive.ts] and the room half [print's joinFlow boot +
      //  steering notify, the rails' federation glance, the consent dialogs'
      //  attribution line, the prompt's rooms section, the subagent doctrine
      //  line, the transcript adapter's mirror branch, the claims note, the
      //  lifecycle rows, the room-context attachment kind, the harness map
      //  lines, the health rows, the envelope-guard hook (deleted), the
      //  mailbox mirror, the workbench collab/seat projections, the old /say room
      //  arm, the concourse env scrub, minerva's guest check]. The fallback
      //  cluster landed before them: the transcript mirror + fabric resume
      //  fallback retired — successor: the -p pump flushes the transcript
      //  before a result frame, scripts/run-recovery/prove-sigkill-resume-
      //  fallback.ts leg A.)
    ] as Array<[string, BoundaryClass[], RetireCluster, RetireVerdict, string]>
  ).map(([f, cs, cluster, verdict, successor]) => [f, { classes: new Set(cs), cluster, verdict, successor }]),
)

/** Estate BY CONSTRUCTION — files that import nothing from the estate (so
 *  the walker never lists them) but exist only for it: the guest-kit
 *  bundler + its arg parser behind `mercury join`, and the /tickets door
 *  whose only screen is TicketsView. They go with their cluster. */
const ESTATE_BY_CONSTRUCTION: ReadonlyArray<[string, RetireCluster]> = [
  ['src/cli/joinArgs.ts', 'caduceus'],
  ['src/cli/joinKit.ts', 'caduceus'],
  ['src/commands/tickets/index.ts', 'commands'],
  ['src/commands/tickets/tickets.tsx', 'commands'],
  // Operator ruling: the /say door retires typed; the local
  // channel bus (the agents' wire) stays.
  ['src/commands/say/index.ts', 'commands'],
]

/** The estate paths by cluster: the caduceus root, the party prefixes (the
 *  three command doors among them go with the commands cluster), the
 *  by-construction files. */
function clusterOfEstatePath(rel: string): RetireCluster {
  if (rel.startsWith('src/caduceus/')) return 'caduceus'
  if (/^src\/commands\/(party|multiplayer|share-party)\//.test(rel)) return 'commands'
  const built = ESTATE_BY_CONSTRUCTION.find(([f]) => f === rel)
  return built ? built[1] : 'party'
}

/** Which clusters have LANDED in this tree: a landed cluster's estate paths
 *  must be GONE (the never-reappears ratchet); an unlanded cluster's paths
 *  must EXIST (the census is true of the tree it was cut from). Each
 *  delete cluster adds itself here as it lands. */
const LANDED: ReadonlySet<RetireCluster> = new Set<RetireCluster>(['fallback', 'commands', 'seams', 'caduceus', 'party'])

// ── the sweep ───────────────────────────────────────────────────────────────

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) yield* walk(full)
    else if (/\.(ts|tsx)$/.test(name)) yield full
  }
}

const SPEC_RE = /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g

const hits = new Map<string, Set<'caduceus' | 'party'>>()
for (const abs of walk(join(ROOT, 'src'))) {
  const rel = relative(ROOT, abs)
  if (isEstateFile(rel)) continue
  const src = readFileSync(abs, 'utf8')
  for (const m of src.matchAll(SPEC_RE)) {
    const kind = specifierHitsEstate(m[1]!)
    if (!kind) continue
    if (!hits.has(rel)) hits.set(rel, new Set())
    hits.get(rel)!.add(kind)
  }
}

console.log('============================================================')
console.log(' operator-identity — the estate boundary ratchet')
console.log('============================================================')

// (1) creep: every estate reference outside the estate has a manifest row.
const creep = [...hits.keys()].filter(f => !MANIFEST.has(f)).sort()
check(
  `no unlisted file references the estate (${hits.size} referencing files, ${MANIFEST.size} manifest rows)`,
  creep.length === 0,
  creep.join(', '),
)

// (2) rot: every manifest row still references the estate.
const moot = [...MANIFEST.keys()].filter(f => !hits.has(f)).sort()
check('no moot manifest rows (a row whose reference is gone must be removed)', moot.length === 0, moot.join(', '))

// (3) the extracted homes never import the estate back.
for (const home of ['src/substrate/identity', 'src/services/channel', 'src/services/attention']) {
  const back: string[] = []
  for (const abs of walk(join(ROOT, home))) {
    const src = readFileSync(abs, 'utf8')
    for (const m of src.matchAll(SPEC_RE)) {
      if (specifierHitsEstate(m[1]!)) back.push(`${relative(ROOT, abs)} → ${m[1]!}`)
    }
  }
  check(`${home} imports nothing from the estate`, back.length === 0, back.join(', '))
}

// (4) the moved modules are GONE from the estate (the extraction is total).
{
  const gone = ['identity.ts', 'frame.ts', 'hlc.ts', 'sealedChannel.ts'].filter(n => {
    try {
      statSync(join(ROOT, 'src/caduceus', n))
      return true
    } catch {
      return false
    }
  })
  check('identity/frame/hlc/sealedChannel no longer exist under src/caduceus', gone.length === 0, gone.join(', '))
}

// (5) the retirement census is true of THIS tree: an unlanded cluster's estate
//     paths exist; a landed cluster's are gone (the never-reappears
//     ratchet); every delete-verdict row's file follows its cluster too.
{
  const exists = (rel: string): boolean => {
    try {
      statSync(join(ROOT, rel))
      return true
    } catch {
      return false
    }
  }
  const estatePaths: Array<[string, RetireCluster]> = [
    ['src/caduceus/', 'caduceus'],
    ...PARTY_ESTATE_PREFIXES.map((p): [string, RetireCluster] => [p, clusterOfEstatePath(p)]),
    ...ESTATE_BY_CONSTRUCTION,
    ...[...MANIFEST.entries()].filter(([, row]) => row.verdict === 'delete').map(([f, row]): [string, RetireCluster] => [f, row.cluster]),
  ]
  const wrong = estatePaths.filter(([p, cluster]) => exists(p) === LANDED.has(cluster))
  check(
    `the census is true of this tree: unlanded clusters' estate paths exist, landed clusters' are gone (${estatePaths.length} paths; landed: ${[...LANDED].join(' · ')})`,
    wrong.length === 0,
    wrong.map(([p, c]) => `${p} [${c}: ${LANDED.has(c) ? 'reappeared' : 'missing'}]`).join(', '),
  )
  const byCluster = new Map<RetireCluster, number>()
  for (const row of MANIFEST.values()) byCluster.set(row.cluster, (byCluster.get(row.cluster) ?? 0) + 1)
  for (const [, cluster] of ESTATE_BY_CONSTRUCTION) byCluster.set(cluster, (byCluster.get(cluster) ?? 0) + 1)
  const open = [...byCluster.entries()].filter(([c]) => !LANDED.has(c))
  console.log(`  (retirement clusters still open: ${open.map(([c, n]) => `${c}=${n}`).join(' · ') || 'none'})`)
}

console.log(failures === 0 ? '\n ✅ ESTATE BOUNDARY HOLDS' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
