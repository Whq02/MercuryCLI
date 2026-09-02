#!/usr/bin/env bun
// ============================================================================
//  scripts/identity/prove-no-lineage-vocabulary.ts — the vocabulary ratchet.
//
//  Mercury's tree describes the product, never its authoring. This prover
//  fails when retired vocabulary appears anywhere in the TRACKED text estate
//  (src/, scripts/, docs/, design-system/, assets/, integrations/, stubs/,
//  .github/, the root files) or in the built dist/mercury.mjs — with one
//  small, explicit allowlist, each entry carrying its reason.
//
//  Laws:
//   §1 RETIRED TERMS — a fixed lexeme set may not appear at all (any case).
//   §2 THE OTHER PRODUCT — its spaced display name appears nowhere except
//      the enumerated wire identifiers; the built dist carries at most the
//      keychain service literal.
//   §3 THE ROSTER — retired uppercase codenames, held as digests, may not
//      appear as words.
//   §4 NARRATION WORDS — "provenance"/"lineage" stay product concepts: in
//      prose files they appear only beside their product senses (artifact
//      signing, install provenance, conversation lineage).
//   §7 ANCESTRY NARRATION — markdown describes the product as it is; the
//      diff-against-an-ancestor shapes (removed/kept/renamed-from framing,
//      fork-era wording, tombstone table rows) may not appear in MD files.
//
//  Every needle is composed from parts so this file never matches itself,
//  and the scan core is self-tested on generated fixtures before it touches
//  the real tree (a checker that cannot fail is not a check).
//
//  Run:  ~/.bun/bin/bun run scripts/identity/prove-no-lineage-vocabulary.ts
//        --report lists every hit without failing (for sweeps).
// ============================================================================
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const REPORT = process.argv.includes('--report')

// ── the retired vocabulary, composed from parts ─────────────────────────────
const J = (...parts: string[]): string => parts.join('')
const TERMS: Array<[string, RegExp]> = [
  ['clean-room family', new RegExp(J('clean', '[-_ ]?', 'room'), 'i')],
  // THE SCHEDULER'S NAME (zero allow): the scheduler is Saturn; neither of
  // the two other names for it may appear anywhere in the tracked tree.
  ['the retired scheduler name', new RegExp(J('kai', 'ros'), 'i')],
  ['the retired scheduler board name', new RegExp(J('cae', 'rus'), 'i')],
  ['de-fork family', new RegExp(J('\\bde', '-?', 'fork'), 'i')],
  ['fork-gate family', new RegExp(J('fork', '[- ]', 'gate') + '|' + J('FORK', 'GATE'))],
  ['nativized', new RegExp(J('nativi', 'z'), 'i')],
  ['re-authored', new RegExp(J('\\bre', '-?', 'author', 'ed'), 'i')],
  ['excision family', new RegExp(J('excis'), 'i')],
  ['retrofit', new RegExp(J('retro', 'fit'), 'i')],
  ['programme', new RegExp(J('\\b', 'programme', '\\b'), 'i')],
  ['the internal codename', new RegExp(J('ten', 'gu'), 'i')],
  ['imported snapshot', new RegExp(J('imported', ' snapshot'), 'i')],
  ['base import', new RegExp(J('\\bbase', ' import\\b'), 'i')],
  ['acquisition lexeme', new RegExp(J('de', 'obfusc'), 'i')],
  ['derivative claims', new RegExp(J('(rebranded', ' fork|renamed', ' derivative|fork', ' of ', 'Claude)'), 'i')],
  ['upstream-product framing', new RegExp(J('upstream', ' (product|harness|CLI|codebase|stamp|changelog|ingest)'), 'i')],
  // ── the collocation classes: the bare two-letter
  // lineage abbreviation survives only in innocent shapes (pixel-art frame
  // rows, the tmux control-mode flag), so its needles are COLLOCATIONS and
  // CALL SHAPES, never the bare token; "stock"/"fork" die only in their
  // the-original senses (stock node/Windows/terminal and the product's own
  // session/process forks stay); the ancestry shapes get a code-side sibling
  // of §7. All of these are TREE laws (TREE_ONLY below): vendored bundle
  // text may use the plain English words.
  ['bare lineage abbreviation beside product nouns', new RegExp(
    J('\\b', 'C', 'C', '[- ]') + '(product|docs|URL|family|compat|referral|upsell)' + '|' + J('\\b(zero|no|vs) ', 'C', 'C', '\\b'),
  )],
  ['composed foreign-prefix local named by the abbreviation', new RegExp(
    J('(const|let) ', 'C', 'C', ' =') + '|' + J('\\$\\{', 'C', 'C', '\\}'),
  )],
  ['stock as the-original (collocations)', new RegExp(
    J('\\bstock', '[- ]', '(parity|branch|spelling|rung|adapter|arm|side|corpus|text|hash|theme|deferral|prune|docs|linked|CC|Claude|harness|CLI)\\b') + '|' + J('\\bvs\\.? ', 'stock', '\\b'),
    'i',
  )],
  ['stamp-idiom lineage identifiers', new RegExp(
    [J('stock', 'Stamp'), J('stock', 'AuthHome'), J('stock', 'Svc'), J('STOCK', '_SENTENCE'), J('cc', '_hyphen'), J('cc', 'Family')].join('|'),
    'i',
  )],
  ['the-fork self-reference', new RegExp(
    [J('non', '-fork', '(?!ing)'), J('fork', '-defaulted'), J('fork', ' catalog'), J('same as ', 'fork', '\\b'), J('the ', 'FORK', ' product'), J('fork', '-independent'), J('even on the ', 'fork', '\\b')].join('|'),
    'i',
  )],
  ['ancestry narration in code', new RegExp(
    [J('(retained|reproduced) from', ' the original'), J('transcription of', ' the original'), J('mirrors the shape of', ' the original')].join('|'),
    'i',
  )],
  ["the upstream as a noun (possessive)", new RegExp(J('the ', 'upstream', "'s"), 'i')],
  // the config home is ~/.mercury and the project-local dir is .mercury —
  // a second home directory name is the home-flip class
  ['second home directory', new RegExp(J('\\.', 'her', 'mes\\b'), 'i')],
  ['second home env spelling', new RegExp(J('HER', 'MES_HOME'))],
  // the cockpit's retired design-system codename — the folders are
  // utils/cockpit and components/mercury-ui, the MCP server is the
  // coordination server, and the flag is MERCURY_COORDINATION_MCP. No
  // spelling is exempt: the package origin and every captured record name
  // the product, and the public-cut gate composes its own needle.
  ['retired cockpit codename', new RegExp(J('tem', 'pest'), 'i')],
  // the permission-bypass indicator is /sovereign, the posture is sovereign
  // mode; the one-word bypass spelling is retired (its camel-case sibling
  // `autoMode` names the classifier-routed mode and stays).
  ['retired bypass-indicator word', new RegExp(J('\\bauto', 'mode\\b'))],
  // the other vendor's plugin marketplaces: no marketplace or plugin source
  // is ever added without an operator act, so none of the vendor's
  // marketplace ids, its org path or its mirror host is spelled anywhere
  // the retired extension vocabulary: the thing
  // is an EXTENSION and it comes from a SOURCE; the two old words leave every
  // name, path, doc, skill, help row and registry pin. Third-party senses
  // are carved out by the lookarounds (Bun's build API, lint pragmas,
  // pytest's env var, Godot's editor addon API, the JetBrains IDE) and by
  // the path allowlist below.
  ['retired extension vocabulary (the thing is an extension)', new RegExp(
    '(?<!Bun\\.)(?<!\\{ )(?<!eslint-)(?<!lint/)(?<!DISABLE_)(?<!JetBrains[- ])(?<!IDE )(?<!editor )(?<!Editor)\\b' + J('plug', 'ins?') + '\\b(?!\\(\\{)(?!\\.cfg)(?!\\.gd)(?!: \\[)',
    'i',
  )],
  ['retired extension vocabulary (a source, not a store)', new RegExp(J('market', 'place'), 'i')],
  ['vendor marketplace id', new RegExp(
    '(' + [
      J('claude', '-plugins-', 'official'),
      J('claude', '-code-', 'plugins'),
      J('claude', '-code-', 'marketplace'),
      J('anthropic', '-marketplace'),
      J('anthropic', '-plugins'),
      J('claude', '-plugin-', 'directory'),
      J('downloads\\.', 'claude', '\\.ai'),
    ].join('|') + ')',
    'i',
  )],
  // the instruction estate's accessor spellings that named the other
  // product's instruction file where Mercury's is meant. The live spellings:
  // getAddedDirectories / setAddedDirectories (the --add-dir and /add-dir
  // roots), getCachedInstructionPrompt, isInstructionDiscoveryDisabled,
  // omitProjectInstructions, MAX_INSTRUCTION_FILE_TOKEN_CONTEXT_RATIO. The
  // wire spellings stay by design and never match here: the `claudeMd`
  // user-context key, the hasClaudeMd* project-config keys, the classifier
  // element, the insights JSON key.
  ['retired added-directories accessor', new RegExp(J('Directories', 'For', 'Claude', 'Md'))],
  ['retired instruction-prompt cache spelling', new RegExp(J('cached', 'Claude', 'Md', 'Content'), 'i')],
  ['retired discovery-gate spelling', new RegExp(J('is', 'Claude', 'Md', 'Disabled'))],
  ['retired slim-agent field spelling', new RegExp(J('omit', 'Claude', 'Md'))],
  ['retired large-file ratio spelling', new RegExp(J('MAX_', 'CLAUDE', '_MD_', 'TOKEN'))],
  // The developer guide is AGENTS.md, and rules are cited by their enforcer
  // (the pinning prover or suite). A comment or string that cites the other
  // product's instruction file as THIS repository's law is the guide-citation
  // class. Keyed on the CITATION SHAPES, never the bare filename: the compat
  // probes, the orientation-doc lists, the prompt bytes, and the pointer-file
  // provers spell the name by design and never match these.
  ['guide citation: per-file', new RegExp(J('per ', 'CLAUDE', '\\.md'))],
  ['guide citation: parenthetical', new RegExp(J('\\((see )?', 'CLAUDE', '\\.md(\\)| ?[§"+/]| render-verify)'))],
  ['guide citation: as-law collocation', new RegExp(J('CLAUDE', '\\.md', "('s\\b|:\\s*\"| (mandates?|names|says|law|rules?|flag table|hard rules?|prompt weight|provenance invariant|gotcha)\\b|, the [a-z-]+ (model )?rule\\b)"))],
  // Skills load from Mercury's homes alone and a skill body's template tokens
  // expand in Mercury's spelling alone: the other product's skills folder and
  // its template-token stems are retired spellings. The permission read-safe
  // tuples, the compaction marks, the portability doctor and the skill-forge
  // guide all speak `.mercury/skills`; scripts/skills/prove-skill-discovery.ts
  // holds the behaviour. No third-party sense exists for either needle.
  ["the other product's skills folder", new RegExp(J('\\.', 'claude', '/', '(skills|commands)'), 'i')],
  ["the other product's skill-template token", new RegExp(J('CLAUDE', '_', '(SKILL_DIR|SESSION_ID)'))],
]
// The other product's display name (spaced), composed.
const OTHER_NAME = new RegExp(J('claude', '[ ]', 'code'), 'i')

// §3 — retired uppercase codenames, never product identities. The rows are
// SHA-256 digests (lowercase hex) of the lowercased words, so the seal bites
// without spelling a name. A candidate is an all-capitals word of three or
// more letters and digits standing at word boundaries (an underscore glues,
// as \b does, so a segment of an env-var name never trips); it is lowercased
// only to form the digest. A hit reports the digest's first eight hex
// digits, never the word. Live module names (vulcan · themis · tabula ·
// mneme · saturn · daedalus · flux · switchboard · concourse) are product
// identifiers and never join the table; §6 holds the retired directory
// names the same way.
const digestMemo = new Map<string, string>()
const digestOf = (word: string): string => {
  const key = word.toLowerCase()
  let digest = digestMemo.get(key)
  if (digest === undefined) {
    digest = createHash('sha256').update(key, 'utf8').digest('hex')
    digestMemo.set(key, digest)
  }
  return digest
}
const ROSTER_DIGESTS: ReadonlySet<string> = new Set([
  '0acbf84757d057b4eaf593501359e26e0504de13993d6d08f8a383e97bdec5cd', '0dcfafab5f8035e779d7bea495f8177b9b7c5b892b81d7a687df96410a0ba304',
  '0efc7ad87e828dc8ed63b5f8fad6f0caa403592b42555bdcab0355eacd415459', '103608b9bff4544a5b2165da2d9aa0cfeb4bb28fc0f4a7468ab5e2a74448f5a2',
  '15626af7abddf6321e277fed53f79619eb758b0d32d355fc9f0baf50b2e9b6a3', '15c6d611193988e468c7431229c59ce13b0407fba24f11d36c42680d7fa11e98',
  '19818c00e27a53819a4ce1341ee0794353501110ebecd1c9884db188843988d0', '1b051a660fb48895dcee2bc8ed6c9bd560c69b48a3144f041416e17888762e0a',
  '21aef37bf4ee4959fdbe78951e41403222f6b902e0a6822daa7f0d49468714b8', '2995dbaa601b16501f01afff1040806c200c5c070ca50a96a3ffb9b1151c83e2',
  '2d7f45d7b98b427f824e0c643295583e9cf013faffdb5e7095d070ff85276bf4', '2e1025a6f0aa4c8ef105d6e89a8fd408c34ef2297f182f51549e498810be3c61',
  '31bcf00e541432c9fa66278f0606407d5114079c8ecb5908d9397df51a64438c', '340d6bb972c2bc1eb7e627ff505ae4fa90c8de05ea0c9903da7c161942b13cec',
  '3632ba7b1f3c76983fc85ebdd7a0a0a990680cd8ea6154e3802910fd625d89f3', '3b9895d9dc02f05355b1c8d5d9795ce499f294a1ae045e050bc50613f340e9c7',
  '3cd3ea577d506c913ed42a399144c4bbff6189edccb3cd476ca981a457660b45', '3e0aa7edd4441c8bc1509424097ea59b5f871452ab38cfdd0f1c4f1d97c69188',
  '40b5553ca09e063dd656c832e267f9914c07e2f6fdd22213588b4ad09aed198d', '42110162e06395fd53647c77db6814026e22e26a10c24b98431ff20dc5eafbc3',
  '446be308664e1964b816217ba48334a777837850765f863efbba3c6608da6b90', '45132c951b5e0167c6edd7044891c1b179c1e24e6f60831109c9f88af7c135e6',
  '4726a1bce9706083939a56b88b657a4c6fe83d9ae0543889df2938517ed1e4f5', '4a9909a9516d02fd4c729a45922398fb41c398c235423a5304085bc923a8db67',
  '4fa1a13ac468ac495f3390e859d76d5e8ef49806815b45a21de7711bcc624194', '50bc66d8aae5ae9020e15d53a103ddf91de202b3af5aeb3fd124b6861cdd2405',
  '527bc96e01d06a60a1157700059ea2d66906584a2f760f87c6e371a4bf5dc252', '54a85d2ae7b0a4d8005ab5cf466d4e582c6ea9aa5060b261241ec65a0ea58506',
  '5af22a29b4365d9978cfa98358ad9352aee7f8464b5ee70905d540417d8e2240', '6a62362c11e91c9f8205c47bbb30833a257c979f663b9a73d3c814ce228fe3dd',
  '6b27eba5652b46d31ef75f17784c2709ac019809c47ca538e91c0ab54a80892f', '6c1a88766cca9983e31f80c4924095dc641ad3a3a7e9ae6c87b4292d8db54820',
  '6ef39aec1f3a4d66f9bd733c3c85a559d954d77a38269ade7a0dc4693ced1421', '6f59cf9b31012122ebe1e3e75df8e41faa6aa6438044c581d3bad0922168b77a',
  '7186b6e1e13844499594bc935ee9f1091d59093bcb00eca31c3d563c5bb86f7d', '71b41d6dd48dc58eba8f5cf9edf30fef6597fdf285a521bb8fcbad4b3d50887d',
  '74cd18c016d902f940554dfd07545f219064b27fe6e890e9447f0c9e377903a8', '7a039460d488c46aab1a70265bf960d045684b20ff94c89e65a284f6a788a069',
  '7b381cef795b79f66c19723c5430604ab8209058a8360ec6437b733feb0cd4d4', '7f27fbfd9e241df13b7fa9d88c8db3208c836f783455238a5417553657061bf8',
  '846be5fc541c5039f7972c6f0a054a3460d3f4b3ee3541991baee4027465abdb', '85c59fad57d79df6b065bfecef893f923a82df3fc2ce618de883277259c6bdd7',
  '8d6546721a1d106cf8d27f7326ebae7e83c1592aeb7479b8f7ec9d8d700d464f', '93348c2a5f1fb7fadf1d3f4b799ab86a77ce9daa149f2020212fa8dcd43daa71',
  '948278737ada1997420a2cba8adaaff837c48e027d319d47b2555240c2ac091d', '9908deef60f1f07f0459802680480dff44b740e61f31d16faf3de387c1b7145e',
  '9a258f0a0a2c0191fabc12bd114366f3743db65e7ab01ccb77fbdb67b1228f09', '9d2ad9f28bb5190c5778607ee517ffe7352d263edc8af881cf967a9a09cd2a37',
  'a0b1df6be0428cdea4c1837a74388374aca9bd16843e53ea4819ca178b25664f', 'a1b93283a20f16d773f80b9f68cfbe14ebfd3269c45089e61c36dadd78b283a6',
  'a7fd11ebf9937f9d157648fe01dfdd256f3c03c63c3330571794fb995bd18746', 'b3704083f1b6e89fc99f494cdcd35f56b2a2894c0dc2d2643b86659f0dc4d85a',
  'b675469b940b1853ca2b177b23048bc3275f45949864ce82cbdadc786109c192', 'b8a201afe114d8d6e7b9fb56dd3a3ad6fc33a96fda253ba13b0281aa29c1002f',
  'bb4c8eb92b6ec7b9055c94a397581544693c61da0f8f6cbb808681ccd0d9ce9b', 'bf67c03c66eef4586b5b840ba521b68854f6c73aa9e4191407f8964882c19376',
  'c5220b3c4266890f047190c18dc4243e0dac079d43ca8065899c4f9f3cf124ef', 'c7083a77956cf334b91cd3cdcd5ef8ca7c302371ff30c0934189059e7005c3e8',
  'cf12c07ca8f421a23ccf202ef96cb799c5e78f592d74240fe970e2d506613800', 'd1068beeb96a6a79937661d5cc9f290dddaa5730e64b7ab2b238078a1194c614',
  'd5007cc3f96992ad0c10be2fda2a18bc06d8fa1a5a1672e2f131682f47e28039', 'd6dba7e8a54d32d2cf8eef5b0e648c5c388079827039a1e56a9bfb282fc883ab',
  'dfb316701857783dac69a14d1fe3fd60cff21d56e830baf7f0e3871bd73eee39', 'dfb76fb7c3c99efb6b3413690880ccb76f025faf26108a8c309e908fcf9f95f2',
  'e285cdd85064e369f2a8abef7052b621d9e596b3a29a8aadba8070de08c566c0', 'e8c3f3d87ee23e76dc8a5f57f060f9a0f6a9a97fd55bb616eaad66fca7fadd1b',
  'e97c382099fe40dd562b70df833ed1e24521e0b2b48d38b15e0da7e08fab459b', 'ef58ef3c1e321df6d41ed2fd179df253ccd966a3212cb97eedf9b369334786af',
  'f208248e5969ffdb9c213257a843a0d8b8b437ae8265dd19a2398f3f212a1566', 'f577060eba024252bcbd67f1d9e7cfaea534b7cbb2763bfe4b9dc85453fba3b4',
  'fe50934e42692a0185af09f7e374c0d4b3fdbe37159ea97d2283caed717c24e2',
])
const capitalWordRe = /(?<![A-Za-z0-9_])[A-Z][A-Z0-9]{2,}(?![A-Za-z0-9_])/g
/** The first roster row a line spells, as the digest's first eight hex digits; null when none. */
const rosterHit = (line: string): string | null => {
  for (const m of line.matchAll(capitalWordRe)) {
    const digest = digestOf(m[0])
    if (ROSTER_DIGESTS.has(digest)) return digest.slice(0, 8)
  }
  return null
}

// §4 — narration collocations. "provenance"/"lineage" are product trust
// vocabulary (tool cards, spawn ledger, recall rows); only the collocations
// that narrate the repository's own origin are retired.
const NARRATION = new RegExp(
  [
    J('lineage', ': §'),
    J('\\(', 'lineage', ':'),
    J('(source|code|repo|repository|project|tree) ', 'lineage'),
    J('provenance (of|for) (this|the) (repo|repository|project|code|tree)'),
    J('began (from|as) (a|an|the) '),
    J('acquisition', ' (narrative|method|history)'),
  ].join('|'),
  'i',
)
const PRODUCT_SENSE = /never a a?cquisition/i

// §7 — ancestry-narration shapes (MD files): a page that explains itself as a
// diff against an ancestor instead of describing the product. Composed from
// parts; extend the list when a new shape survives a sweep.
const ANCESTRY = new RegExp(
  [
    J('removed', ' \\('),
    J('retired', ' and now'),
    J('\\bkept', ' from\\b'),
    J('the fork', ' home'),
    J('fork', '-era'),
    J('inherited', ' from'),
    J('upstream', ' ancestor'),
    J('formerly', ' (called|named|known)'),
    J('renamed', ' from'),
    J('was ', 'renamed'),
    J('ported', ' from'),
    J('\\ba port', ' of\\b'),
    J('\\|\\s*(tombstoned?|', 'was removed|was retired)\\s*\\|'),
  ].join('|'),
  'i',
)

// ── §13 THE ONE ENTER GLYPH ─────────────────────────────────────────────────
// The kit's key vocabulary owner (KeyboardShortcutHint's KIT_KEY) maps Enter
// to the U+21B5 glyph; the retired U+23CE spelling may not return to the
// tracked text estate — literal or as a backslash-u escape — outside the
// reasoned rows below (generated records refresh on their own capture roads;
// frozen baselines keep their recorded bytes). The dist face is absolute:
// the built artifact carries zero occurrences. Needles are composed so this
// file never matches itself.
const RETIRED_ENTER_GLYPH = String.fromCharCode(0x23ce)
const retiredEnterEscapeRe = new RegExp('\\\\u\\{?' + '23' + 'ce', 'i')

// ── the allowlist: path prefix → [which law it exempts, reason] ─────────────
const ALLOW: Array<[string, string, string]> = [
  ['scripts/identity/prove-no-lineage-vocabulary.ts', '*', 'this prover names the vocabulary it retires (composed needles only)'],
  ['scripts/identity/prove-dist-invariants.sh', 'terms', 'the dist invariants name the vendor needles they refuse (composed) and the JetBrains IDE integration directory'],
  ['assets/vulcan/', 'terms', "Godot's editor addon API (EditorPlugin, plugin.cfg, plugin.gd) — the engine's own vocabulary"],
  ['src/services/vulcan/', 'terms', "Godot's editor addon API — the engine's own vocabulary"],
  ['src/utils/vulcan/', 'terms', "Godot's editor addon API — the engine's own vocabulary (generated op table)"],
  ['scripts/vulcan/', 'terms', "Godot's editor addon API — the engine's own vocabulary"],
  ['src/services/lsp/godotLane.ts', 'terms', "Godot's editor addon API"],
  ['src/utils/jetbrains.ts', 'terms', "the JetBrains IDE integration — that product's own word for its editor add-ons"],
  ['src/utils/ide.ts', 'terms', "the JetBrains IDE integration — that product's own word for its editor add-ons"],
  ['src/utils/status.tsx', 'terms', "the JetBrains IDE integration — that product's own word"],
  ['src/components/IdeOnboardingDialog.tsx', 'terms', "the JetBrains IDE integration — that product's own word"],
  ['src/hooks/notifs/useIDEStatusIndicator.tsx', 'terms', "the JetBrains IDE integration — that product's own word"],
  ['src/commands/ide/', 'terms', "the JetBrains IDE integration — that product's own word"],
  ['scripts/lsp/prove-ide-detect.ts', 'terms', "the JetBrains IDE integration — that product's own word"],
  ['scripts/substrate/prove-identity-constants.ts', 'terms', "the JetBrains IDE integration — that product's own word"],
  ['src/services/ide/pythonTests.ts', 'terms', "pytest's own vocabulary for its add-ons"],
  ['BUILD-NOTES.md', 'terms', "Bun's build API vocabulary (the build's module-resolution hook)"],
  ['scripts/gate/gate-ledger.jsonl', 'terms,estate-paths,estate-caduceus', 'an append-only record of past gate runs; it names the suite paths as they were'],
  // ── §13 rows (each names a record that keeps its bytes; generated records
  // refresh on their own capture roads and need no rows — a return there
  // reds like anywhere else) ────────────────────────────────────────────────
  ['scripts/interview/baselines/', 'enter-glyph', 'frozen R0 journey captures — the recorded screens keep their recorded bytes by design'],
  ['scripts/visual-contract/baselines/', 'enter-glyph', 'frozen R0/wave capture records of prior trees — diff anchors, deliberately never regenerated'],
  ['src/utils/secureStorage/macOsKeychainHelpers.ts', 'other-name', 'the keychain service name is a wire identifier Mercury must spell to read the credential'],
  ['src/utils/knownAgentClis.ts', 'other-name', 'the foreign-writer recognizer attributes external products by their own display names — a signature table naming the OTHER product deliberately, never Mercury identity'],
  ['scripts/health/prove-foreign-harness-inversion.ts', 'other-name', "the recognizer's prover byte-pins the attribution evidence line, whose value IS the other product's display name — the pinned literal must spell it or the byte pin proves nothing"],
  ['scripts/project-intel/fixtures/', 'terms', 'fixture repositories exercise ordinary English (inventory stock)'],
  ['scripts/search/fixtures/', 'terms,other-name', "captured third-party search-result pages — the outside world's own text, replayed verbatim"],
  ['scripts/search/prove-websearch-doors.ts', 'terms,roster', 'names the identity needles it refuses (negative user-agent pins) and the sovereign-mode posture — the dist-invariants class'],
  ['scripts/search/lib/bundle-for-node.ts', 'terms', "Bun's build API vocabulary (the bundling hook — the BUILD-NOTES row's class)"],
  ['design-system/live/manifest.json', 'roster', 'generated visual baseline — its note strings regenerate from the fixed generator at the next real-binary capture'],
  // ── §10 (the retired multiplayer estate) ──────────────────────────────────
  ['scripts/operator-identity/prove-estate-boundary.ts', 'estate-paths,estate-idents,estate-caduceus', 'the boundary ratchet names the estate to pin its absence'],
  ['scripts/workflows/corpus/', 'estate-paths', 'replay fixtures pinned to a pre-retirement corpus commit speak that tree\'s paths'],
  ['scripts/workflows/fixtures/verdict.json', 'estate-paths', 'evidence record of the ratified benchmark run at the pinned corpus commit'],
  ['src/services/channel/', 'estate-caduceus', "the extracted channel home: the protocol's HKDF/AAD wire strings spell the old name by contract, and its origin notes name it"],
  ['src/substrate/identity/', 'estate-caduceus', 'the extracted identity home names its origin'],
  ['src/services/attention/', 'estate-caduceus', 'the extracted attention home names its origin'],
  ['src/substrate/pidLock.ts', 'estate-caduceus', "provenance notes: the retired room gate's proven loop is owned here"],
  ['src/prompt/composer.ts', 'estate-caduceus', 'provenance note'],
  ['src/services/crew/identity.ts', 'estate-caduceus', 'recognition: old principal records keep binding'],
  ['src/constants/changelog.ts', 'estate-caduceus,retired-doors', 'released-version history states what those versions shipped (the guest verb among them)'],
  ['src/entrypoints/cli.tsx', 'retired-doors', "the retired guest verbs' typed-answer owner: the entry recognises the two verb spellings to answer the retirement sentence before auth — the one-owner analogue of the retired-stub module"],
  ['scripts/engine-durability/bench-authority-worker.ts', 'estate-caduceus', 'operator benchmark whose seeds document the historical segment shapes'],
  ['scripts/substrate/prove-pidlock-release.ts', 'estate-caduceus', 'cites the residual head locks that motivated the release law'],
  ['scripts/channel/prove-channel-primitives.ts', 'estate-caduceus', 'cites the pre-move prover names as the origin of its sections'],
]
function allowed(path: string, law: string): boolean {
  for (const [prefix, laws, _reason] of ALLOW) {
    if (path === prefix || path.startsWith(prefix)) {
      if (laws === '*' || laws.split(',').includes(law)) return true
    }
  }
  return false
}

const BINARY_EXT = /\.(png|jpe?g|gif|ico|icns|pdf|wasm|woff2?|ttf|otf|node|zip|gz|tgz|jar|mp[34]|exe|dylib|so|bin|zst|tar)$/i

type Violation = { path: string; line: number; law: string; text: string }

/** The ONE scan core — fixtures and the real tree both go through here. */
function scan(files: Array<{ path: string; content: string }>): Violation[] {
  const out: Violation[] = []
  for (const f of files) {
    const lines = f.content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      for (const [label, re] of TERMS) {
        if (re.test(line) && !allowed(f.path, 'terms')) {
          out.push({ path: f.path, line: i + 1, law: `terms:${label}`, text: line.trim().slice(0, 140) })
          break
        }
      }
      if (OTHER_NAME.test(line) && !allowed(f.path, 'other-name')) {
        out.push({ path: f.path, line: i + 1, law: 'other-name', text: line.trim().slice(0, 140) })
      }
      if (!allowed(f.path, 'roster')) {
        const digest8 = rosterHit(line)
        if (digest8) out.push({ path: f.path, line: i + 1, law: 'roster', text: digest8 })
      }
      if (/\.(md|txt|tsv)$/.test(f.path) && NARRATION.test(line) && !PRODUCT_SENSE.test(line) && !allowed(f.path, 'narration')) {
        out.push({ path: f.path, line: i + 1, law: 'narration', text: line.trim().slice(0, 140) })
      }
      if (/\.md$/.test(f.path) && ANCESTRY.test(line) && !allowed(f.path, 'ancestry')) {
        out.push({ path: f.path, line: i + 1, law: 'ancestry', text: line.trim().slice(0, 140) })
      }
      if ((line.includes(RETIRED_ENTER_GLYPH) || retiredEnterEscapeRe.test(line)) && !allowed(f.path, 'enter-glyph')) {
        out.push({ path: f.path, line: i + 1, law: 'enter-glyph', text: line.trim().slice(0, 140) })
      }
    }
  }
  return out
}

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  [PASS] ${name}`)
  else {
    failures++
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('============================================================')
console.log(' vocabulary ratchet — the tree describes the product')
console.log('============================================================')

// ── §0 self-test on generated fixtures ──────────────────────────────────────
{
  const fx = mkdtempSync(join(tmpdir(), 'vocab-ratchet-'))
  const bad = [
    'This module began as a ' + J('clean', '-', 'room') + ' rewrite.',
    'The ' + J('de', '-', 'fork') + ' removed the gate.',
    'See the ' + J('SIGNAL', 'HOUSE') + ' record.',
    'The ' + J('Claude', ' ', 'Code') + ' surface.',
    'The repo ' + J('lineage', ':') + ' is recorded in the ledger.',
    'The flag was ' + J('renamed', ' from') + ' its old spelling.',
    'This helper is ' + J('kept', ' from') + ' the ancestor tree.',
    '| gate | ' + J('tomb', 'stoned') + ' |',
    'Converted per ' + J('CLAUDE', '.md') + ' before editing.',
    'render-verify required ' + J('(', 'CLAUDE', '.md)') + '.',
    'The rule is ' + J('CLAUDE', '.md') + "'s law.",
    'Install the ' + J('plug', 'in') + ' from the ' + J('market', 'place') + '.',
    'Skills also load from ' + J('.cla', 'ude/skills') + '/<name>.',
    'Expand ' + J('${CLA', 'UDE_SKILL_DIR}') + ' in the body.',
    // the collocation classes
    'the ' + J('C', 'C') + ' product URL is banned here.',
    'const ' + J('C', 'C') + " = ['X', 'Y'].join('_')",
    'the ' + J('sto', 'ck') + ' parity summary.',
    'const ' + J('sto', 'ck') + 'Stamped = probe()',
    'the ' + J('non', '-fork') + ' path is unchanged.',
    'listFeatureToggles() === ' + J('fork', ' catalog'),
    'Recognition ' + J('retained from', ' the original') + '.',
    'parsed from ' + J('the ', 'upstream', "'s") + ' checkout.',
  ].join('\n')
  writeFileSync(join(fx, 'bad.md'), bad)
  const good = 'A plain constraint statement about artifact provenance and the product.\n'
  writeFileSync(join(fx, 'good.md'), good)
  const vBad = scan([{ path: 'fixture/bad.md', content: bad }])
  const vGood = scan([{ path: 'fixture/good.md', content: good }])
  check('self-test: the planted fixture trips all five law families', new Set(vBad.map(v => v.law.split(':')[0])).size >= 5, vBad.map(v => v.law).join(','))
  check('self-test: the ancestry shapes trip §7 (renamed-from · kept-from · tombstone row)', vBad.filter(v => v.law === 'ancestry').length >= 3, String(vBad.filter(v => v.law === 'ancestry').length))
  check('self-test: the guide-citation shapes trip (per-file · parenthetical · as-law)', vBad.filter(v => v.law.startsWith('terms:guide citation')).length >= 3, String(vBad.filter(v => v.law.startsWith('terms:guide citation')).length))
  check('self-test: the retired extension vocabulary trips', vBad.some(v => v.law.startsWith('terms:retired extension vocabulary')), vBad.map(v => v.law).join(','))
  check("self-test: the other product's skills folder trips", vBad.some(v => v.law === "terms:the other product's skills folder"), vBad.map(v => v.law).join(','))
  check("self-test: the other product's skill-template token trips", vBad.some(v => v.law === "terms:the other product's skill-template token"), vBad.map(v => v.law).join(','))
  const carved = scan([{ path: 'fixture/carved.ts', content: ["import { " + J('plug', 'in') + " } from 'bun'", '// biome-ignore lint/' + J('plug', 'in') + ': x', "const PYTEST_DISABLE_" + J('PLUG', 'IN') + "_AUTOLOAD = 1", 'the JetBrains ' + J('plug', 'in') + ' directory', "plugins: [mercury" + J('Plug', 'in') + "]", 'skills live under ' + J('.mer', 'cury/skills') + ' and expand ' + J('${MER', 'CURY_SKILL_DIR}')].join('\n') }])
  check('self-test: the third-party senses are carved out', carved.length === 0, carved.map(v => v.text).join(' | '))
  // the carve-outs: the innocent senses the collocation/call-shape
  // needles are DESIGNED never to reach.
  const sweepBad = scan([{ path: 'fixture/sweep-bad.ts', content: ['the ' + J('C', 'C') + '-family resolved home', 'the ' + J('fork', '-defaulted') + ' dist', 'vs ' + J('sto', 'ck') + ' at equal effort'].join('\n') }])
  check('self-test: the sweep collocations trip (family · fork-defaulted · vs-stock)', sweepBad.length === 3, sweepBad.map(v => v.law).join(','))
  const sweepCarved = scan([{ path: 'fixture/sweep-carved.ts', content: [
    "'...CC..CC....CC..CC.....', // pixel frame row",
    'unset => default-on with the tmux -CC auto-disable',
    'the engine parses under ' + J('sto', 'ck') + ' node from the dist layout',
    'a ' + J('non', '-forking') + ' restore adopts the loaded session',
    'omit subagent_type to ' + J('for', 'k') + ' yourself — the ' + J('for', 'k') + ' inherits your context',
    'wall vs the external harness at equal model+effort',
  ].join('\n') }])
  check('self-test: the sweep carve-outs stay silent (pixel row · tmux -CC · stock node · non-forking · the feature fork)', sweepCarved.length === 0, sweepCarved.map(v => `${v.law}:${v.text}`).join(' | '))
  check('self-test: the clean fixture passes', vGood.length === 0, vGood.map(v => v.law).join(','))
  // §13 — the retired Enter glyph: the literal trips, the escape spelling
  // trips, the kit's own glyph never does.
  const enterBad = scan([{ path: 'fixture/enter.ts', content: ["const legend = '" + RETIRED_ENTER_GLYPH + " confirm'", "controls: 'one call per \\" + 'u' + '23' + "ce'"].join('\n') }])
  check('§13 self-test: the retired Enter glyph trips (literal + escape spelling)', enterBad.filter(v => v.law === 'enter-glyph').length === 2, enterBad.map(v => v.law).join(','))
  const enterGood = scan([{ path: 'fixture/enter-kit.ts', content: "const legend = '↵ confirm · esc cancel'" }])
  check('§13 self-test: the kit glyph stays silent', enterGood.length === 0, enterGood.map(v => v.law).join(','))
  // §3 — the digest rows bite: a codename composed from two halves at runtime
  // trips and reports the digest's first eight hex digits, never the word; a
  // near-miss (one letter changed), a mixed-case spelling and an underscore-
  // glued identifier stay silent.
  const composed = J('SIGNAL', 'HOUSE')
  const vComposed = scan([{ path: 'fixture/roster.ts', content: 'See the ' + composed + ' record.' }])
  check('§3 self-test: a codename composed from halves trips and reports the digest prefix, never the word',
    vComposed.length === 1 && vComposed[0]!.law === 'roster' && vComposed[0]!.text === digestOf(composed).slice(0, 8) && !vComposed[0]!.text.includes(composed),
    JSON.stringify(vComposed))
  const vNear = scan([{ path: 'fixture/roster-near.ts', content: [
    'See the ' + J('SIGNAL', 'HOUSF') + ' record.',
    'the ' + J('Signal', 'house') + ' record',
    'MERCURY_' + composed + '_MODE',
    'x' + composed + 'y',
  ].join('\n') }])
  check('§3 self-test: a near-miss, a mixed-case spelling and a glued identifier stay silent', vNear.length === 0, vNear.map(v => `${v.law}:${v.text}`).join(' | '))
  rmSync(fx, { recursive: true, force: true })
}

// ── §1..§4 the real tree ────────────────────────────────────────────────────
const tracked = execSync('git ls-files -z', { cwd: ROOT })
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
  .filter(p => !BINARY_EXT.test(p))
const files = tracked.map(path => {
  try {
    return { path, content: readFileSync(join(ROOT, path), 'utf8') }
  } catch {
    return { path, content: '' }
  }
})
const violations = scan(files)
if (REPORT) {
  for (const v of violations) console.log(`${v.path}:${v.line}  [${v.law}]  ${v.text}`)
  console.log(`\n${violations.length} hit(s)`) 
  process.exit(0)
}
check(`tracked tree carries no retired vocabulary (${tracked.length} files)`, violations.length === 0,
  violations.slice(0, 12).map(v => `${v.path}:${v.line} [${v.law}]`).join(' · '))

// ── the allowlist's own law: a row must name a path the tracked tree holds ──
// An allow row for a path that no longer exists is not inert — it exempts
// whatever is created there next: a file re-created under a stale prefix
// could carry every dead identifier past §10. Every prefix must match at
// least one tracked path; a row whose path left the tree leaves with it.
{
  const mootRows = (rows: ReadonlyArray<[string, string, string]>): string[] =>
    rows.filter(([prefix]) => !tracked.some(p => p === prefix || p.startsWith(prefix))).map(([prefix]) => prefix)
  const moot = mootRows(ALLOW)
  check('every allow row names a path the tracked tree still holds (a moot row exempts a future file)', moot.length === 0, moot.join(' · '))
  const planted = mootRows([...ALLOW, ['src/no-such-home/', 'estate-idents', 'poison: a row for a path that is gone']])
  check('allowlist self-test: a planted row for an absent path is reported as moot', planted.length === 1 && planted[0] === 'src/no-such-home/', planted.join(' · '))
}

// ── §6 RETIRED SCRIPTS DIRECTORY NAMES ─────────────────────────────────────
// No tracked path reintroduces a retired suite directory name as a scripts/
// directory segment or as a word of a scripts/ basename. The rows are
// SHA-256 digests (lowercase hex) of the lowercased names. The candidates:
// the first segment under scripts/, whole; and in the basename every word
// (a run of letters and digits) and every hyphen-joined run of adjacent
// words, so a two-word name is met as one. A hit prints the path with the
// matched span replaced by the digest's first eight hex digits.
const RETIRED_DIR_DIGESTS: ReadonlySet<string> = new Set([
  '04a4718fed785ca35c5908bba9672d004ff8aa1dd9e20d7ca0500c4b39135d54', '0acbf84757d057b4eaf593501359e26e0504de13993d6d08f8a383e97bdec5cd',
  '0dcfafab5f8035e779d7bea495f8177b9b7c5b892b81d7a687df96410a0ba304', '103608b9bff4544a5b2165da2d9aa0cfeb4bb28fc0f4a7468ab5e2a74448f5a2',
  '15c6d611193988e468c7431229c59ce13b0407fba24f11d36c42680d7fa11e98', '19818c00e27a53819a4ce1341ee0794353501110ebecd1c9884db188843988d0',
  '1a2fc26dc7ea5a2a4748b7cb2b1ef193d96ab2c99f93092f69e63075b28d1278', '1b051a660fb48895dcee2bc8ed6c9bd560c69b48a3144f041416e17888762e0a',
  '1cf5d74d95b8c53b0c29ffbda56d61217566a05b00dbdf49576ca3569ec37140', '21aef37bf4ee4959fdbe78951e41403222f6b902e0a6822daa7f0d49468714b8',
  '298fb3e7dd113320a9e02953c01264243e39072a0b68b6d60141e2e68aa754e2', '2d7f45d7b98b427f824e0c643295583e9cf013faffdb5e7095d070ff85276bf4',
  '2e1025a6f0aa4c8ef105d6e89a8fd408c34ef2297f182f51549e498810be3c61', '340d6bb972c2bc1eb7e627ff505ae4fa90c8de05ea0c9903da7c161942b13cec',
  '3632ba7b1f3c76983fc85ebdd7a0a0a990680cd8ea6154e3802910fd625d89f3', '3cd3ea577d506c913ed42a399144c4bbff6189edccb3cd476ca981a457660b45',
  '3e0aa7edd4441c8bc1509424097ea59b5f871452ab38cfdd0f1c4f1d97c69188', '42110162e06395fd53647c77db6814026e22e26a10c24b98431ff20dc5eafbc3',
  '446be308664e1964b816217ba48334a777837850765f863efbba3c6608da6b90', '45132c951b5e0167c6edd7044891c1b179c1e24e6f60831109c9f88af7c135e6',
  '4726a1bce9706083939a56b88b657a4c6fe83d9ae0543889df2938517ed1e4f5', '4a9909a9516d02fd4c729a45922398fb41c398c235423a5304085bc923a8db67',
  '4fa1a13ac468ac495f3390e859d76d5e8ef49806815b45a21de7711bcc624194', '50bc66d8aae5ae9020e15d53a103ddf91de202b3af5aeb3fd124b6861cdd2405',
  '527bc96e01d06a60a1157700059ea2d66906584a2f760f87c6e371a4bf5dc252', '54a85d2ae7b0a4d8005ab5cf466d4e582c6ea9aa5060b261241ec65a0ea58506',
  '5af22a29b4365d9978cfa98358ad9352aee7f8464b5ee70905d540417d8e2240', '6a62362c11e91c9f8205c47bbb30833a257c979f663b9a73d3c814ce228fe3dd',
  '6afe40611ff94485d186f84f9433631893b90737bc4fa518a510f7b65c874bfe', '6b27eba5652b46d31ef75f17784c2709ac019809c47ca538e91c0ab54a80892f',
  '6ef39aec1f3a4d66f9bd733c3c85a559d954d77a38269ade7a0dc4693ced1421', '71abe01f382f83813ec22c058f7a717c81bab787155cafe7f100fcc81f7e1656',
  '7b381cef795b79f66c19723c5430604ab8209058a8360ec6437b733feb0cd4d4', '7f27fbfd9e241df13b7fa9d88c8db3208c836f783455238a5417553657061bf8',
  '846be5fc541c5039f7972c6f0a054a3460d3f4b3ee3541991baee4027465abdb', '948278737ada1997420a2cba8adaaff837c48e027d319d47b2555240c2ac091d',
  '9908deef60f1f07f0459802680480dff44b740e61f31d16faf3de387c1b7145e', '9a258f0a0a2c0191fabc12bd114366f3743db65e7ab01ccb77fbdb67b1228f09',
  'a0b1df6be0428cdea4c1837a74388374aca9bd16843e53ea4819ca178b25664f', 'a2e10207c7be30e1d07b0b7e353ecc1a1364f39057e1acedd3f76c5d2ceed180',
  'b3704083f1b6e89fc99f494cdcd35f56b2a2894c0dc2d2643b86659f0dc4d85a', 'b675469b940b1853ca2b177b23048bc3275f45949864ce82cbdadc786109c192',
  'b8a201afe114d8d6e7b9fb56dd3a3ad6fc33a96fda253ba13b0281aa29c1002f', 'c5220b3c4266890f047190c18dc4243e0dac079d43ca8065899c4f9f3cf124ef',
  'c7083a77956cf334b91cd3cdcd5ef8ca7c302371ff30c0934189059e7005c3e8', 'd1068beeb96a6a79937661d5cc9f290dddaa5730e64b7ab2b238078a1194c614',
  'd5007cc3f96992ad0c10be2fda2a18bc06d8fa1a5a1672e2f131682f47e28039', 'd6dba7e8a54d32d2cf8eef5b0e648c5c388079827039a1e56a9bfb282fc883ab',
  'dfb316701857783dac69a14d1fe3fd60cff21d56e830baf7f0e3871bd73eee39', 'dfb76fb7c3c99efb6b3413690880ccb76f025faf26108a8c309e908fcf9f95f2',
  'e285cdd85064e369f2a8abef7052b621d9e596b3a29a8aadba8070de08c566c0', 'e8c3f3d87ee23e76dc8a5f57f060f9a0f6a9a97fd55bb616eaad66fca7fadd1b',
  'e97c382099fe40dd562b70df833ed1e24521e0b2b48d38b15e0da7e08fab459b', 'ef58ef3c1e321df6d41ed2fd179df253ccd966a3212cb97eedf9b369334786af',
  'f208248e5969ffdb9c213257a843a0d8b8b437ae8265dd19a2398f3f212a1566', 'f577060eba024252bcbd67f1d9e7cfaea534b7cbb2763bfe4b9dc85453fba3b4',
])
/** Every word of a basename and every hyphen-joined run of adjacent words. */
const basenameSpans = (base: string): string[] => {
  const out: string[] = []
  for (const piece of base.split(/[^A-Za-z0-9-]+/)) {
    const words = piece.split('-')
    for (let i = 0; i < words.length; i++) {
      if (!words[i]) continue
      for (let j = i; j < words.length && words[j]; j++) out.push(words.slice(i, j + 1).join('-'))
    }
  }
  return out.filter(s => /^[A-Za-z]/.test(s) && s.length >= 3)
}
const retiredPathHitsOf = (paths: ReadonlyArray<string>): string[] => {
  const hits: string[] = []
  for (const p of paths) {
    if (!p.startsWith('scripts/')) continue
    const segments = p.slice('scripts/'.length).split('/')
    const span = [segments[0]!, ...basenameSpans(segments[segments.length - 1]!)].find(s => RETIRED_DIR_DIGESTS.has(digestOf(s)))
    if (span !== undefined) hits.push(p.replace(new RegExp(span, 'gi'), '[' + digestOf(span).slice(0, 8) + ']'))
  }
  return hits
}
const retiredPathHits = retiredPathHitsOf(tracked)
check('§6 retired scripts directory names stay retired', retiredPathHits.length === 0,
  retiredPathHits.slice(0, 8).join(' · '))
// self-tests: a name composed from two halves at runtime trips as a directory
// segment and as a basename word (a two-word name through its hyphen-joined
// span), a hit masks the span with the digest prefix, and a near-miss (one
// letter changed), a word fragment and a path outside scripts/ stay silent.
{
  const name = J('signal', 'house')
  const twoWord = J('native', '-core')
  const planted = retiredPathHitsOf(['scripts/' + name + '/x.ts', 'scripts/x/prove-' + name + '.ts', 'scripts/x/prove-' + twoWord + '-parity.ts'])
  check('§6 self-test: a composed name trips as a segment, as a basename word and as a hyphen-joined span', planted.length === 3, planted.join(' · '))
  check('§6 self-test: a hit masks the span with the digest prefix, never the name',
    planted.every(h => /\[[0-9a-f]{8}\]/.test(h) && !h.toLowerCase().includes(name) && !h.includes(twoWord)), planted.join(' · '))
  const near = retiredPathHitsOf(['scripts/' + J('signal', 'housf') + '/x.ts', 'scripts/x/prove-' + J('signal', 'housf') + '.ts', 'scripts/identity/prove-' + name.slice(0, 5) + '.ts', 'src/' + name + '/x.ts'])
  check('§6 self-test: a near-miss, a word fragment and a path outside scripts/ stay silent', near.length === 0, near.join(' · '))
}

// ── §9 RETIRED COMMAND SPELLINGS ───────────────────────────────────────────
// Palette names that left the product. The slash form may not appear as a
// command token anywhere in the tracked text estate, the registry may not
// declare the name, and the /help domains may not list it. Needles are
// composed so this file never matches itself.
const RETIRED_COMMANDS = [J('extra', '-usage'), J('fa', 'st'), J('auto', 'mode')]
const retiredSlashRe = new RegExp('(^|[\\s"\'`(\\[|,])/(' + RETIRED_COMMANDS.join('|') + ')(?![\\w-])', 'i')
const retiredDeclRe = new RegExp("\\bname:\\s*'(" + RETIRED_COMMANDS.join('|') + ")'")
const retiredDomainRe = new RegExp("'(" + RETIRED_COMMANDS.join('|') + ")'")
{
  const hits: string[] = []
  for (const f of files) {
    if (allowed(f.path, '*')) continue
    const lines = f.content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (retiredSlashRe.test(line) || retiredDeclRe.test(line)) hits.push(`${f.path}:${i + 1}`)
      else if (f.path === 'src/components/HelpV2/commandDomains.ts' && retiredDomainRe.test(line)) hits.push(`${f.path}:${i + 1}`)
    }
  }
  check(`§9 retired command spellings never return (${RETIRED_COMMANDS.join(', ')})`, hits.length === 0, hits.slice(0, 8).join(' · '))
}

// ── §11 THE FOCUSED-CHAT VOCABULARY: there is no "main" chat — the one on screen is THE FOCUSED CHAT.
// The retired crumb phrase never returns to the concourse estate (any line),
// and never returns as screen text (a non-comment line) anywhere in src/.
// Needles are composed so this file never matches itself; the lowercase
// contract id ('main-repl') and camel identifiers stay legal; comments
// elsewhere in src may still use the phrase in its route-surface sense.
const CONCOURSE_ESTATE = new RegExp('^src/(components|services)/concourse/')
const retiredCrumbUpper = new RegExp('[Mm]ain[- ]' + J('RE', 'PL'))
const retiredCrumbSpaced = new RegExp(J('main', '[ ]', 'repl'), 'i')
const isCommentLine = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line.trimStart().length > 0 ? line : line)
{
  const hits: string[] = []
  for (const f of files) {
    if (!f.path.startsWith('src/')) continue
    if (!/\.(ts|tsx)$/.test(f.path)) continue
    const estate = CONCOURSE_ESTATE.test(f.path)
    const lines = f.content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (!estate && isCommentLine(line)) continue
      if (retiredCrumbUpper.test(line) || retiredCrumbSpaced.test(line)) hits.push(`${f.path}:${i + 1}`)
    }
  }
  check('§11 the retired crumb phrase stays out of the concourse estate and out of screen text', hits.length === 0, hits.slice(0, 8).join(' · '))
  // the needle bites (a pin that cannot fail proves nothing) and the id stays legal
  const planted = 'esc ' + J('main', ' ', 'RE', 'PL')
  check('§11 self-test: a planted crumb phrase trips', retiredCrumbUpper.test(planted) || retiredCrumbSpaced.test(planted))
  check('§11 self-test: the lowercase hyphen id does not trip', !retiredCrumbUpper.test("'" + J('main-re', 'pl') + "'") && !retiredCrumbSpaced.test("'" + J('main-re', 'pl') + "'"))
}

// ── §10 THE RETIRED MULTIPLAYER ESTATE ─────────────────────────────────────
// The retired multiplayer estate and its session-room fabric are absent from
// the tree (the channel, identity and attention homes stand on their own).
// Three laws keep it absent without banning the living vocabulary (the
// retired-door stub's "party" row, the channel bus's "room", the
// typed-retirement sentences):
//   (a) DEAD PATHS — the deleted namespaces may not be spelled as paths;
//   (b) DEAD IDENTIFIERS — the deleted export names may not return;
//   (c) the caduceus word survives only where a reasoned allowlist row says
//       why (protocol vocabulary in the extracted homes, provenance notes,
//       append-only history);
//   (d) ONE OWNER for the nine retired command names — only the retired-stub
//       module may declare them under src/commands/ (a successor takes a
//       name back by editing the stub AND this law, deliberately).
// Needles are composed so this file never matches itself. (The residue class
// — the crew identity's recognition rows and the retired-door stub — is
// deliberate and NOT a law here; see the boundary ratchet for what is.)
const ESTATE_DEADPATHS: string[] = [
  J('src/', 'cadu', 'ceus/'),
  J('scripts/', 'cadu', 'ceus/'),
  J('scripts/', 'multi', 'player/'),
  J('scripts/', 'par', 'ty/'),
  J('src/components/', 'par', 'ty/'),
  J('src/tools/', 'Multi', 'playerTool'),
  J('src/utils/', 'par', 'ty/'),
  J('daemon/', 'room', 'Remote'),
  J('daemon/', 'room', 'Broker'),
  J('par', 'tyStateStore'),
  J('cli/', 'join', 'Main'),
  J('cli/', 'join', 'Kit'),
]
const ESTATE_DEADIDENTS: string[] = [
  J('isRoom', 'GuestBoot'),
  J('room', 'SnapshotPolicy'),
  J('engage', 'Par', 'tyEnv'),
  J('disengage', 'Par', 'tySession'),
  J('par', 'tyWorktrees'),
  J('Par', 'tyBriefFacet'),
  J('Par', 'tySeatFact'),
  J('Multi', 'playerTool'),
  J('envelope', 'GuardHook'),
  J('par', 'tyHeartbeat'),
]
const CADUCEUS_WORD = new RegExp(J('cadu', 'ceus'), 'i')
const RETIRED_MP_NAMES = ['par' + 'ty', 'multi' + 'player', 'rooms', 'share', 'invite', 'handoff', 'delegate', 'prompt', 'request', 'tickets', 'say']
const retiredMpDeclRe = new RegExp("\\bname:\\s*'(" + RETIRED_MP_NAMES.join('|') + ")'")
const RETIRED_STUB_OWNER = 'src/commands/retired.ts'
{
  const hits: string[] = []
  for (const f of files) {
    const lines = f.content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (!allowed(f.path, 'estate-paths') && ESTATE_DEADPATHS.some(p => line.includes(p))) hits.push(`${f.path}:${i + 1} [paths]`)
      if (!allowed(f.path, 'estate-idents') && ESTATE_DEADIDENTS.some(p => line.includes(p))) hits.push(`${f.path}:${i + 1} [idents]`)
      if (!allowed(f.path, 'estate-caduceus') && CADUCEUS_WORD.test(line)) hits.push(`${f.path}:${i + 1} [word]`)
      if (f.path.startsWith('src/commands/') && f.path !== RETIRED_STUB_OWNER && retiredMpDeclRe.test(line)) hits.push(`${f.path}:${i + 1} [owner]`)
    }
  }
  check('§10 the retired estate stays gone (paths · identifiers · the word · the one stub owner)', hits.length === 0, hits.slice(0, 10).join(' · '))
  // self-tests: every needle family bites, and the carve-outs hold
  const planted = [
    'import x from "' + J('src/', 'cadu', 'ceus/') + 'room.js"',
    'const g = ' + J('is', 'Room', 'GuestBoot') + '()',
    'the ' + J('Cadu', 'ceus') + ' fabric',
  ].join('\n')
  const vPlanted = scan([{ path: 'fixture/planted.ts', content: planted }])
  void vPlanted // scan() covers other laws; §10 is checked directly below
  check('§10 self-test: a planted dead path trips', ESTATE_DEADPATHS.some(p => planted.includes(p)))
  check('§10 self-test: a planted dead identifier trips', ESTATE_DEADIDENTS.some(p => planted.includes(p)))
  check('§10 self-test: the composed word needle trips', CADUCEUS_WORD.test(planted))
  check('§10 self-test: a stray stub declaration trips (and the owner is exempt)',
    retiredMpDeclRe.test("name: '" + RETIRED_MP_NAMES[0] + "',") && RETIRED_STUB_OWNER === 'src/commands/' + 'retired.ts')
}

// ── §12 THE RETIRED DOORS' LIVE COPY ───────────────────────────────────────
// §10's one-owner law covers `name:` DECLARATIONS; it cannot see COPY: a tip,
// a landing hint line or a ledger hint could advertise a retired door after
// the estate left. This leg reads what an operator reads — a STRING
// LITERAL or JSX TEXT anywhere under src/ that spells a retired door as a
// slash command ('/…') or as one of the two retired guest verbs advertises a
// door that answers only the retirement sentence. The roster derives from
// the stub module's OWN rows (names + aliases; never a retyped list) plus
// the two verbs. NOT copy, never a hit (pinned by the self-tests): a regex
// literal (/prompt is too long/), a path-joined spelling ('daemon/party/crew'),
// a regex-joined spelling (/party_(dps\d)/), a comment line. The two allow
// rows are the two real owners of the spellings: the released-version
// history and the verbs' typed-answer entry.
const RETIRED_STUB_SRC = files.find(f => f.path === RETIRED_STUB_OWNER)?.content ?? ''
const retiredDoorNames = [
  ...[...RETIRED_STUB_SRC.matchAll(/\bname:\s*'([a-z-]+)'/g)].map(m => m[1]!),
  ...[...RETIRED_STUB_SRC.matchAll(/aliases:\s*\[([^\]]*)\]/g)].flatMap(m => [...m[1]!.matchAll(/'([a-z-]+)'/g)].map(x => x[1]!)),
]
const RETIRED_VERBS = ['mercury join', 'join-kit']
const retiredDoorCopyRe = new RegExp(
  '(?<![\\w./-])/(' + retiredDoorNames.join('|') + ')(?![\\w./-])|\\b(' + RETIRED_VERBS.map(v => v.replace('-', '\\-')).join('|') + ')\\b',
)
/** The copy of ONE source line: its string literals, its JSX text between a
 *  closing `>` and the next `<`/`{`, and — in a .tsx file — a bare text line
 *  standing alone between tags. Code outside quotes (regex literals, calls,
 *  identifiers) is never copy. Block comments are stripped by the caller. */
const copySpansOf = (line: string, tsx: boolean): string[] => {
  const spans: string[] = []
  let i = 0
  while (i < line.length) {
    const ch = line[i]!
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < line.length && line[j] !== ch) {
        if (line[j] === '\\') j++
        j++
      }
      spans.push(line.slice(i + 1, j))
      i = j + 1
      continue
    }
    i++
  }
  for (const m of line.matchAll(/>([^<{]+)</g)) spans.push(m[1]!)
  if (tsx && /^\s*[^<>{}()=;'"`]+$/.test(line) && /\s/.test(line.trim())) spans.push(line)
  return spans
}
const stripBlockComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
const retiredDoorCopyHits = (path: string, content: string): string[] => {
  const out: string[] = []
  const tsx = path.endsWith('.tsx')
  const lines = stripBlockComments(content).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*\/\//.test(line)) continue
    if (copySpansOf(line, tsx).some(span => retiredDoorCopyRe.test(span))) out.push(`${path}:${i + 1}`)
  }
  return out
}
{
  check('§12 the roster derives from the stub module (ten names, the one alias)', retiredDoorNames.length === 11 && retiredDoorNames.includes('say') && retiredDoorNames.includes('rooms'), retiredDoorNames.join(' '))
  const hits: string[] = []
  for (const f of files) {
    if (!f.path.startsWith('src/') || !/\.(ts|tsx)$/.test(f.path)) continue
    if (f.path === RETIRED_STUB_OWNER || allowed(f.path, 'retired-doors')) continue
    hits.push(...retiredDoorCopyHits(f.path, f.content))
  }
  check('§12 no product copy under src/ names a retired door (string literals · JSX text)', hits.length === 0, hits.slice(0, 8).join(' · '))
  // self-tests — every copy shape bites, every non-copy shape stays silent
  const bites: Array<[string, string, boolean]> = [
    ['a string literal', "export const tip = '/" + 'par' + "ty boards the live seats'", true],
    ['JSX text between tags', '<Text>type /' + 'say' + ' to chat</Text>', true],
    ['a bare JSX text line (.tsx)', '        run /' + 'invite' + ' to add a peer', true],
    ['a retired verb in a literal', "['daemon', 'join', '" + 'join-' + "kit', 'acp']", true],
    ['a regex literal', 'const re = /' + 'prompt' + ' is too long/i', false],
    ['a path-joined spelling', "const p = 'Scheduler/daemon/" + 'party' + "/crew workers'", false],
    ['a regex-joined spelling', 'const lane = /' + 'party' + '_(dps\\d|tank|healer)/', false],
    ['a comment line', '// the /' + 'tickets' + ' door is retired', false],
    ['a block comment', '/* the /' + 'party' + ' door */ const x = 1', false],
  ]
  for (const [label, text, bites_] of bites) {
    const got = retiredDoorCopyHits('fixture/planted.tsx', text).length > 0
    check(`§12 self-test: ${label} ${bites_ ? 'trips' : 'stays silent'}`, got === bites_)
  }
}

// ── §8 GENERATED INVENTORIES STAY OUT OF THE TREE ──────────────────────────
// Rendered inventories are derived truth: generate → verify → never commit.
// The retired committed paths may not return, and the generators' untracked
// .out inspection dirs may never become tracked.
const UNTRACKED_ONLY = [
  'docs/FLAG-REGISTRY.md',
  'docs/REACHABILITY-MANIFEST.json',
  'docs/REACHABILITY-MAP.md',
]
const inventoryHits = tracked.filter(
  p => UNTRACKED_ONLY.includes(p) || p.startsWith('scripts/orphans/.out/') || p.startsWith('scripts/substrate/.out/'),
)
check('§8 generated inventories stay out of the tracked tree', inventoryHits.length === 0,
  inventoryHits.slice(0, 4).join(' · '))

// ── §5 the built artifact ───────────────────────────────────────────────────
const distPath = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(distPath)) {
  console.log('  [SKIP] dist/mercury.mjs not built — run `bun run build.ts` for the dist law')
} else {
  const dist = readFileSync(distPath, 'utf8')
  const spaced = dist.match(new RegExp(OTHER_NAME.source, 'gi')) ?? []
  // <=2: the keychain service identifier + the foreign-writer recognizer's
  // attribution label (knownAgentClis.ts names the external product it
  // detects by that product's own display name).
  check('dist: the other product\'s display name ships at most as the keychain identifier + the attribution label', spaced.length <= 2, `${spaced.length} occurrence(s)`)
  // The two extension-vocabulary terms stay TREE laws: bundled third-party
  // code (Bun's API, language services, the IDE integrations) legitimately
  // spells the words inside the artifact; the dist law for the retired
  // estate is its LOAD-BEARING literals instead.
  const TREE_ONLY = new Set([
    'retired extension vocabulary (the thing is an extension)',
    'retired extension vocabulary (a source, not a store)',
    // the collocation classes are tree laws: the bundle's vendored third-party
    // text may spell the plain English words; the dist's identity face is
    // owned by the URL/name ratchets in prove-dist-invariants.sh.
    'bare lineage abbreviation beside product nouns',
    'composed foreign-prefix local named by the abbreviation',
    'stock as the-original (collocations)',
    'stamp-idiom lineage identifiers',
    'the-fork self-reference',
    'ancestry narration in code',
    "the upstream as a noun (possessive)",
    // the bundled sandbox runtime (a third-party library) names the other
    // product's command and agent folders in its own write-protection list;
    // the folder term's dist face is the skills folder alone, below.
    "the other product's skills folder",
  ])
  for (const [label, re] of TERMS) {
    if (label === 'excision family' || label === 'retrofit') continue // vendored library text may use the plain English words
    if (TREE_ONLY.has(label)) continue
    check(`dist: no ${label}`, !re.test(dist))
  }
  check('dist: zero retired Enter glyphs (the artifact speaks the kit vocabulary)', !dist.includes(RETIRED_ENTER_GLYPH))
  const otherSkillsFolder = new RegExp(J('\\.', 'claude', '/', 'skills'), 'i')
  check('dist needle control: a planted other-product skills path trips', otherSkillsFolder.test(J('~/.cla', 'ude/skills/x')))
  check("dist: no other-product skills folder", !otherSkillsFolder.test(dist))
  for (const literal of [
    J('.mercury', '-plug', 'in'),
    J('known_', 'market', 'places.json'),
    J('installed_', 'plug', 'ins.json'),
    J('enabled', 'Plug', 'ins'),
    J('extraKnown', 'Market', 'places'),
  ]) {
    check(`dist: no retired estate literal ${literal}`, !dist.includes(literal))
  }
  // §9's dist face: a retired palette name may not ship as a QUOTED TOKEN —
  // the shape a registration row or palette entry takes in the artifact. The
  // closing quote keeps the wire spellings out of the needle's reach (the
  // mock scenario id continues with `-required`, and /cost's attributed
  // "extra-usage pool" wording carries no quotes). `fa`+`st` gets NO dist
  // needle: the bare word is live product vocabulary (the /router mode enum,
  // easing names), so a quoted-token pin would flag living keys — the tree
  // laws above remain its whole enforcement.
  for (const name of [J('extra', '-usage'), J('auto', 'mode')]) {
    const quoted = J('"', name, '"')
    const poisoned = J('{type:"local-jsx",name:', quoted, ',description:"x"}')
    check(`dist needle control: a planted registration row trips "${name}"`, poisoned.includes(quoted))
    check(`dist: no quoted retired palette token ${quoted}`, !dist.includes(quoted))
  }
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ vocabulary ratchet: ${failures} FAILED`)
  process.exit(1)
}
console.log('✅ vocabulary ratchet: clean')
