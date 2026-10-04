#!/usr/bin/env bun
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const REPORT = process.argv.includes('--report')
const J = (...parts: string[]): string => parts.join('')

const OTHER_ENTER_GLYPH = String.fromCharCode(0x23ce)
const otherEnterEscapeRe = new RegExp('\\\\u\\{?' + '23' + 'ce', 'i')

const WORDS: Array<[string, RegExp]> = [
  ['the thing is an extension', new RegExp(
    '(?<!Bun\\.)(?<!\\{ )(?<!eslint-)(?<!lint/)(?<!DISABLE_)(?<!JetBrains[- ])(?<!IDE )(?<!editor )(?<!Editor)\\b' + J('plug', 'ins?') + '\\b(?!\\(\\{)(?!\\.cfg)(?!\\.gd)(?!: \\[)',
    'i',
  )],
  ['it comes from a source', new RegExp(J('market', 'place'), 'i')],
  ['run-short', /(?<![\w-])-p(?![\w-])/],
  ['run-print', /--print(?![\w-])/],
  ['run-format', /--output-format(?![\w-])/],
  ['run-input', /--input-format(?![\w-])/],
  ['run-partial', /--include-partial-messages(?![\w-])/],
  ['run-sovereign', /--dangerously-bypass-permissions(?![\w-])/],
  ['run-allow-sovereign', /--allow-dangerously-bypass-permissions(?![\w-])/],
  ['run-mode', /--permission-mode(?![\w-])/],
]

const RUN_SCOPE = /^(?:src\/|docs\/|README\.md$|bench\/|\.github\/)/
const RETIRED_SCOPE = /^(?:src\/|docs\/|README\.md$|scripts\/)/
const asWord = (name: string): RegExp => new RegExp('(?<![\\w-])' + name + '(?![\\w-])')
const asName = (name: string): RegExp => new RegExp('(?<![\\w$])' + name + '(?![\\w$])')
const asModeValue = (names: string): RegExp => new RegExp("['\"`](?:" + names + ")['\"`]|--mode (?:" + names + ')(?![\\w-])|(?:permissionMode|defaultMode):\\s*(?:' + names + ')(?![\\w-])')
const RETIRED: Array<[string, RegExp, string[]]> = [
  ['mode-deepthink', asWord(J('deep', 'think')), [J('deep', 'think')]],
  ['mode-supercode', asWord(J('super', 'code')), [J('super', 'code')]],
  ['mode-ultrathink', asWord(J('ultra', 'think')), [J('ultra', 'think')]],
  ['mode-ultracode', asWord(J('ultra', 'code')), [J('ultra', 'code')]],
  ['mode-ultraplan', asWord(J('ultra', 'plan')), [J('ultra', 'plan')]],
  ['mode-autopilot', asWord(J('[Aa]uto', 'pilot')), [J('uto', 'pilot')]],
  ['mode-tier-tool', asName(J('(?:Set', 'Tier|set_', 'tier)')), [J('Set', 'Tier'), J('set_', 'tier')]],
  ['mode-tier-readout', asWord(J('self-', 'tier')), [J('self-', 'tier')]],
  ['mode-autopilot-env', asName(J('MERCURY_AUTO', 'PILOT(?:_MODELS)?')), [J('MERCURY_AUTO', 'PILOT')]],
  ['mode-effort-keys', asName(J('(?:super', 'codeEffort|ultra', 'codeEffort|super', 'code_mode|deep', 'think_effort|ultra', '_effort)')), ['codeEffort', 'code_mode', 'think_effort', J('ultra', '_effort')]],
  ['mode-trigger-machinery', asName(J('keyword', '(?:Glow|Trigger)')), [J('keyword', 'Glow'), J('keyword', 'Trigger')]],
  ['mode-spelling-accept-bypass', asModeValue(J('accept', 'Edits|bypass', 'Permissions')), [J('accept', 'Edits'), J('bypass', 'Permissions')]],
  ['mode-spelling-plan-auto', /--mode (?:plan|auto)(?![\w-])|(?:permissionMode|defaultMode)\s*[:=]\s*['"]?(?:plan|auto)['"]?(?![\w-])/, ['--mode ', 'permissionMode', 'defaultMode']],
  ['mode-spelling-table', asName(J('RETIRED_PERMISSION_', 'MODE_SPELLINGS|decode', 'PermissionModeSpelling')), ['MODE_SPELLINGS', 'PermissionModeSpelling']],
  ['strategy-mode-tools', asName(J('(?:Enter|Exit)(?:Strat', 'egy|Plan)Mode(?:V2)?')), [J('Strat', 'egyMode'), 'PlanMode']],
  ['strategy-slash', new RegExp("(?<=['\"`\\s(])/strat" + 'egy(?![\\w-])'), [J('/strat', 'egy')]],
  ['strategy-mode-value', new RegExp('--mode strat' + "egy(?![\\w-])|(?:permissionMode|mode|Mode)\\s*(?:[:=]|===|!==)\\s*['\"]strat" + "egy['\"]|case ['\"]strat" + "egy['\"]"), [J('strat', 'egy')]],
  ['strategy-mode-names', asName(J('(?:strat', 'egyMode|modeStrat', 'egy|preStrat', 'egyMode|lastStrat', 'egyModeUse|checkStrat', 'egyShellRefusal|strat', 'egyMutation|showClearContextOnStrat', 'egyAccept)')), [J('trat', 'egy')]],
  ['strategy-plan-names', asName(J('(?:plan_mode', '(?:_required|_reentry|_exit)?|plan', 'ModeRequired|plan_approval', '_(?:request|response)|awaitingPlan', 'Approval|plan_file', '_reference|PLAN_REJECTION', '_PREFIX|plan', 'ModeV2|isPlan', 'ModeInterviewPhaseEnabled|MERCURY_', 'INTERVIEW|getPlans', 'Directory|isPlan', 'FilePath|cleanupOld', 'PlanFiles|plans', 'Directory|getRuntime', 'MainLoopModel|pendingPlan', 'Verification|reasonIs', 'PlanFloor)')), ['plan', 'Plan', 'PLAN_', J('MERCURY_', 'INTERVIEW'), 'MainLoopModel']],
  ['strategy-band', new RegExp('Strat' + 'egy Mode'), [J('Strat', 'egy Mode')]],
  ['strategy-flags', new RegExp('--strat' + 'egy-mode-required|--require-strat' + 'egy'), [J('strat', 'egy')]],
  ['strategy-settings', new RegExp('strat' + 'egy\\.(?:directory|offerFreshContext)'), [J('strat', 'egy.')]],
  ['strategy-opusplan', asWord(J('opus', 'plan')), [J('opus', 'plan')]],
  ['strategy-floors', asWord(J('plan-', '(?:floor|entry|exit)')), ['plan-']],
  ['ide-editor-link-keys', asName(J('(?:autoInstall', 'IdeExtension|autoConnect', 'Ide|ideHint', 'ShownCount|hasIdeAutoConnect', 'DialogBeenShown|hasIdeOnboarding', 'BeenShown|ideInstallation', 'Status|ide', 'Selection)')), ['IdeExtension', 'ConnectIde', J('ideHint', 'Shown'), J('IdeOnboarding', 'Been'), J('ideInstallation', 'Status'), J('ide', 'Selection')]],
  ['ide-diff-tool-type', asName(J('[Dd]iff', 'Tool')), [J('iff', 'Tool')]],
  ['ide-fs-right', new RegExp(J('_?cla', 'ude_fs_right')), ['_fs_right']],
  ['ide-mcp-ide', new RegExp(J('mcp__', 'ide__')), [J('mcp__', 'ide__')]],
  ['ide-companion', asName(J('(?:notifyVscode', 'FileUpdated|registerEditor', 'Companion|vscode', 'SdkMcp|zodInstance', 'Seam|configHome', 'ExplicitlySet|getAncestor', 'CommandsAsync)')), ['FileUpdated', 'EditorCompanion', 'SdkMcp', 'InstanceSeam', 'ExplicitlySet', 'CommandsAsync']],
  ['ide-companion-name', asWord(J('mercury-editor', '-companion')), ['editor-companion']],
  ['ide-visual-bell', new RegExp(J('[Vv]isual', ' [Bb]ell')), ['isual ']],
  ['helper-steward', asWord(J('ste', 'ward')), [J('ste', 'ward')]],
  ['memory-gate-env', asName(J('MERCURY_', '(?:RELEVANT_RECALL|MNEME)')), [J('RELEVANT_', 'RECALL'), J('MERCURY_', 'MNEME')]],
  ['option-debug-words', asWord(J('-{1,2}d2', 'e|--debug-', '(?:file|to-stderr)')), [J('d2', 'e'), '--debug-']],
  ['option-run-words', asWord('--(?:' + J('ba', 're|init-', 'only|mainten', 'ance|json-', 'schema|max-budget', '-usd|disallowed-', 'tools|strict-mcp-', 'config|mcp-', 'config|system-', 'prompt(?:-file)?|append-system-', 'prompt(?:-file)?|fork-', 'session|from-', 'pr|pre', 'fill|no-session-', 'persistence|resume-session', '-at|rewind-', 'files|be', 'tas|fallback-', 'model|work', 'load|project-', 'root|setting-', 'sources|disable-slash-', 'commands|tm', 'ux') + ')'), ['--']],
  ['option-crew-words', asWord(J('--(?:agent-', 'id|agent-', 'name|crew-', 'name|agent-', 'color|parent-session', '-id|agent-', 'type)')), [J('--agent', '-'), J('--crew', '-name'), J('--parent', '-session')]],
  ['option-editor-link', asWord(J('--editor', '-link')), [J('--editor', '-link')]],
  ['verb-mcp', asWord(J('mcp (?:add-', 'json|reset-project', '-choices)')), [J('mcp add', '-json'), J('mcp reset', '-project')]],
  ['verb-auth-token', new RegExp(J("(?<=mercury |[`'\"])auth ", 'token(?![\\w-])')), [J('auth ', 'token')]],
  ['verb-extensions', new RegExp(J("(?<=mercury |[`'\"])extensions ", '(?:check|approve|block|unblock|validate|init)(?![\\w-])')), ['extensions ']],
  ['verb-root', asWord(J('mercury (?:sh', 'ow|edi', 'tor|agen', 'ts|jo', 'in|join-', 'kit)')), ['mercury ']],
  ['agent-type-general', asWord(J('mercury-', 'general')), [J('mercury-', 'general')]],
  ['agent-type-general-purpose', asWord(J('general', '-purpose')), [J('general', '-purpose')]],
  ['agent-type-background', asWord(J('mercury-', 'background')), [J('mercury-', 'background')]],
  ['agent-type-architect', asWord(J('mercury-', 'architect')), [J('mercury-', 'architect')]],
  ['agent-type-guide', asWord(J('mercury-', 'guide')), [J('mercury-', 'guide')]],
  ['agent-type-reviewer', asWord(J('mercury-', 'reviewer')), [J('mercury-', 'reviewer')]],
  ['agent-type-verifier', asWord(J('mercury-', 'verifier')), [J('mercury-', 'verifier')]],
  ['push-tool', asName(J('(?:Push', 'Notification(?:Tool)?|PUSH_', 'NOTIFICATION_TOOL|push', 'notification)')), ['otification', 'OTIFICATION']],
  ['push-saturn-exempt', asName(J('(?:MERCURY_SATURN_', 'EXEMPT_PUSH|SATURN_EXEMPT_', 'TOOL_[AB]|isSaturnExempt', '[AB]Enabled)')), ['SATURN_', 'SaturnExempt']],
  ['push-notif-keys', asName(J('(?:taskComplete', 'NotifEnabled|inputNeeded', 'NotifEnabled|agentPush', 'NotifEnabled)')), ['NotifEnabled']],
  ['push-os-notification', asName(J('sendOS', 'Notification')), [J('sendOS', 'Notification')]],
  ['push-proof-name', new RegExp(J('prove-push-', 'notification-honest')), [J('prove-push-', 'notification')]],
  ['rule-prefix-form', new RegExp('\\b(?:Bash|PowerShell|Skill)\\([^()\\n]*' + J(':', '\\*\\)') + "|(?<=['\"])" + J(':', '\\*') + "(?=['\"])"), [J(':', '*)'), J("':", "*'"), J('":', '*"')]],
  ['sdk-result-fields', asName(J('(?:rate_limit', '_event|parent_tool', '_use_id|duration_api', '_ms|num_', 'turns|permission_', 'denials|is_', 'replay|error_max_', '(?:turns|budget_usd|structured_output_retries)|api_', 'retry|hook_', 'callback|mcp_', 'message)')), [J('rate_limit', '_event'), J('parent_tool', '_use_id'), J('duration_api', '_ms'), J('num_', 'turns'), J('permission_', 'denials'), J('is_', 'replay'), J('error_max', '_'), J('api_', 'retry'), J('hook_', 'callback'), J('mcp_', 'message')]],
  ['sdk-result-error-word', new RegExp(J('(?<!hook_)error_during', '_execution')), [J('error_during', '_execution')]],
  ['sdk-wire-words', new RegExp('(?<![\\w-])(?:--)?' + J('(?:permission-', 'channel|permission-prompt', '-tool|stream-', 'json|replay-user', '-messages)') + '(?![\\w-])'), [J('permission-', 'channel'), J('permission-prompt', '-tool'), J('stream-', 'json'), J('replay-user', '-messages')]],
  ['sdk-home', new RegExp(J('entrypoints/', 'sdk|agentSdk', 'Types|\\bSDK[A-Z]\\w*', 'Message\\b|\\bSDKControl', '\\w*')), [J('entrypoints/', 'sdk'), J('agentSdk', 'Types'), 'SDK']],
  ['sdk-wire-names', new RegExp(J('[Ss]tream', 'Json')), [J('tream', 'Json')]],
  ['sdk-init-names', new RegExp(J('(?<![\\w$])(?:SdkInit', 'Owner|resetSdkInit', 'State|[gs]etInitJson', 'Schema|initJson', 'Schema)(?![\\w$])|sdk-', 'init\\.')), [J('SdkInit', ''), J('InitJson', 'Schema'), J('initJson', 'Schema'), J('sdk-', 'init')]],
  ['control-frames', asName(J('(?:control_', 'request|control_', 'response|control_cancel', '_request|can_use', '_tool|set_permission', '_mode)')), [J('control_', 'req'), J('control_', 'resp'), J('control_', 'cancel'), J('can_use', '_tool'), J('set_permission', '_mode')]],
  ['activity-stream-arms', new RegExp(J('stream-(?:file-', 'change|command|check|question|work-', 'item|generic-', 'tool|tool-', 'result|message|session-', 'lifecycle)(?![\\w-])|explodeActivity', 'Inputs')), [J('stream-', ''), J('explodeActivity', '')]],
  ['rule-sentences', new RegExp(J('is blocked by a ', 'deny rule|', 'deny rule matched|requires ', 'confirmation for this (?:command|tool|edit|read)|Permission ', "rule '|by a permission ", 'rule|blocked by permission ', 'rules|denied by permission ', 'settings|blocked by a permission ', 'deny rule|Permission rules can be ', 'changed in /permissions|has been denied by ', 'permission rule|Permission to (?:read|edit) .* (?:has been ', 'denied|requires confirmation)')), [J('deny ', 'rule'), J('requires ', 'confirmation'), J('ermission ', 'rule'), J('permission ', 'settings'), J('Permission to ', 'read'), J('Permission to ', 'edit')]],
  ['screen-chat-path', new RegExp(J('screens/', 'RE', 'PL')), [J('screens/', 'RE', 'PL')]],
  ['screen-chat-launcher', new RegExp(J('repl', 'Launcher|launch', 'Repl')), [J('repl', 'Launcher'), J('launch', 'Repl')]],
  ['screen-chat-word', new RegExp(J('\\b', 'RE', 'PL', '\\b')), [J('RE', 'PL')]],
  ['flow-classifier-names', new RegExp(J('yolo', 'Classifier|[Yy]olo', '[A-Z]|yolo', '_classifier')), [J('Yo', 'lo'), J('yo', 'lo')]],
  ['mneme-home-name', new RegExp(J('mem', 'dir'), 'i'), [J('mem', 'dir'), J('mem', 'Dir'), J('Mem', 'dir'), J('Mem', 'Dir'), J('MEM', 'DIR')]],
  ['turn-engine-names', new RegExp(J('Query', 'Engine|submit', 'Message')), [J('Query', 'Engine'), J('submit', 'Message')]],
  ['crew-names', new RegExp(J('utils/', 'swarm|isAgent', 'SwarmsEnabled|Swarm', '[A-Z]')), [J('utils/', 'swarm'), J('isAgent', 'Swarms'), J('Swa', 'rm')]],
  ['engine-model-name', new RegExp(J('[mM]ain', 'LoopModel')), [J('ain', 'LoopModel')]],
  ['respond-to-model-name', new RegExp(J('RespondTo', 'Claude')), [J('RespondTo', 'Claude')]],
  ['shell-snapshot-name', new RegExp(J('ClaudeCode', 'Snapshot')), [J('ClaudeCode', 'Snapshot')]],
  ['skill-scope-name', new RegExp(J('ClaudeSkill', 'Scope')), [J('ClaudeSkill', 'Scope')]],
  ['command-words', new RegExp("(?<=['\"`\\s(])/" + J('(?:pr-', 'comments|co', 'st|co', 'lor|release-', 'notes|heap', 'dump|mock-', 'limits|fi', 'les|security-', 'review|terminal-', 'setup)') + "(?![\\w=\\\\(/-])(?![^\\n/]*\\/[dgimsuy]*\\.(?:test|exec|match|replace|source|split)\\b)"), [J('/pr-', 'comments'), J('/co', 'st'), J('/co', 'lor'), J('/release-', 'notes'), J('/heap', 'dump'), J('/mock-', 'limits'), J('/fi', 'les'), J('/security-', 'review'), J('/terminal-', 'setup')]],
  ['health-word', new RegExp(J('doc', 'tor'), 'i'), [J('doc', 'tor'), J('Doc', 'tor'), J('DOC', 'TOR')]],
  ['stop-checker-slash', new RegExp("(?<=['\"`\\s(])/" + J('super', 'visor') + '(?![\\w-])'), [J('/super', 'visor')]],
  ['stop-checker-env', asName(J('MERCURY_SUPER', 'VISOR')), [J('MERCURY_SUPER', 'VISOR')]],
  ['stop-checker-key', asName(J('(?:(?:setS|s)uper', 'visorEnabled|super', 'visorGate|super', 'visedStopVerdict|SUPER', 'VISOR_EVALUATOR_DEADLINE_MS)')), [J('visor', 'Enabled'), J('visor', 'Gate'), J('vised', 'StopVerdict'), J('VISOR_', 'EVALUATOR')]],
  ['identity-old-ids', asName(J('(?:legacyOperator', 'PrincipalIds?|isLegacyOperator', 'PrincipalId|rawPinOperator', 'PrincipalId|principalId', 'OwnsRecord|rekeyLegacy', 'OperatorIds|rekeyOperator', 'Records)')), [J('Operator', 'PrincipalId'), J('principalId', 'OwnsRecord'), J('rekey', 'Legacy'), J('rekeyOperator', 'Records')]],
]
const SETTINGS_SCOPE = /^(?:src\/|docs\/|README\.md$|scripts\/)/
const RETIRED_SETTINGS_ROOTS = [
  'apiKeyHelper', 'proxyAuthHelper', 'forceLoginMethod', 'forceLoginOrgUUID', 'fileSuggestion', 'respectGitignore', 'cleanupPeriodDays',
  'instructionExcludes', 'includeGitInstructions', 'instructionProfile', 'plansDirectory', 'showClearContextOnStrategyAccept', 'autoMemoryEnabled',
  'autoMemoryDirectory', 'memoryUpkeepEnabled', 'loopGuardStopEnabled', 'includeMercuryCoAuthor', 'allowManagedPermissionRulesOnly',
  'skipSovereignConsentPrompt', 'availableModels', 'modelOverrides', 'effortLevel', 'supercodeEffort', 'sessionDefaultsKey', 'alwaysThinkingEnabled',
  'enableAllProjectMcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'allowedMcpServers', 'deniedMcpServers', 'allowManagedMcpServersOnly',
  'disableAllHooks', 'allowManagedHooksOnly', 'allowedHttpHookUrls', 'httpHookAllowedEnvVars', 'strictExtensionOnlyCustomization', 'spinnerTipsEnabled',
  'spinnerTipsOverride', 'spinnerVerbs', 'progressReporting', 'filesBox', 'modelPickerCentred', 'syntaxHighlightingDisabled', 'prefersReducedMotion',
  'backgroundKey', 'sessionsBar', 'firstRunCards', 'compactWayBack', 'promptSuggestionEnabled', 'defaultShell', 'shellEngine', 'shellEngineSessions',
  'openrouterRouting', 'channelsEnabled', 'localServer',
]
const RETIRED_SETTINGS_GENERIC_ROOTS = ['env', 'attribution', 'permissions', 'sandbox', 'model', 'agent', 'hooks', 'language', 'worktree']
const RETIRED_SETTINGS_FIELDS = [
  'disableBypassPermissionsMode', 'disableAutoMode', 'skipDangerousModePermissionPrompt', 'autoDreamEnabled', 'showClearContextOnPlanAccept',
  J('claudeMd', 'Excludes'), J('Tea', 'mmateIdle'), 'defaultMode',
]
const RETIRED_SETTINGS_MODULES = [
  'migrateSettingsSpellings', 'migrateEnableAllProjectMcpServersToSettings', 'migrateBypassPermissionsAcceptedToSettings', 'migrateAutoupdateEnvName',
  'migrateConfigSpellings',
]
const RETIRED_POLICY_PLACES = [J('com.anthropic.', 'claudecode'), J('Policies\\\\', 'ClaudeCode')]
const SETTINGS_LEAF_KEPT = new Set(['model', 'agent', 'hooks', 'sandbox', 'worktree', 'language', 'env', 'attribution', 'permissions'])
const SETTINGS_LEAF_NAMES = new Set(['backgroundKey', 'sessionsBar', 'firstRunCards'])
const asRoot = (key: string): RegExp => new RegExp(
  '(?:[sS]ettings\\w*(?:\\([^)]*\\))?\\??\\.' + key + '(?![\\w$])|(?:writeFileSync\\([^;]*JSON\\.stringify\\(|updateSettingsForSource\\([^,]+,\\s*|safeParse\\(|parse\\()\\s*\\{\\s*' + key + '\\s*:|SettingsJson\\[["\']' + key + '["\']\\])',
)
const asDistinctRoot = (key: string): RegExp => new RegExp('(?:\\)\\??\\.' + key + '(?![\\w$])|`' + key + '`)')
const asJsonKey = (key: string): RegExp => new RegExp('"' + key + '"\\s*:')
const inDocs = (key: string): RegExp => new RegExp('(?<![\\w$./\'"-])' + key + '(?![\\w$/-])')
const dottedOrNamed = (key: string): RegExp => new RegExp('`' + key + '(?:\\.[A-Za-z]+)+`|`' + key + '`\\s+(?:setting|key|block|list)')
const plainName = (key: string): RegExp => new RegExp('(?<![\\w$./\'"-])' + key + '(?![\\w$/-])')
const moduleName = (name: string): RegExp => new RegExp('(?<![\\w$-])' + name + '(?![\\w$-])')
const RELEASE_SETTINGS_LINES: Readonly<Record<string, string>> = {
  'docs/releases/1.0.0-beta.21.md': '  one stretch is asked once to continue past it; with loopGuardStopEnabled',
  'src/constants/changelog.ts': '- Added a loop guard: a tool call repeated with identical arguments and an identical result is reminded at the third, fifth and eighth repeat, a cycle of up to five calls repeated five times is named, and a reply that chants one stretch is asked once to continue past it; with loopGuardStopEnabled true in settings the second detection of the same cycle ends the turn as loop_stopped (by default nothing is ended)',
}
function settingsViolation(path: string, line: string): string | null {
  if (!SETTINGS_SCOPE.test(path) || allowed(path, 'settings')) return null
  if (RELEASE_SETTINGS_LINES[path] === line) return null
  const prose = /\.md$/.test(path) || path === 'src/constants/changelog.ts'
  for (const place of RETIRED_POLICY_PLACES) if (line.includes(place)) return `settings:${place}`
  for (const name of RETIRED_SETTINGS_MODULES) if (moduleName(name).test(line)) return `settings:${name}`
  for (const key of [...RETIRED_SETTINGS_ROOTS, ...RETIRED_SETTINGS_GENERIC_ROOTS, ...RETIRED_SETTINGS_FIELDS]) {
    if (asRoot(key).test(line) || dottedOrNamed(key).test(line)) return `settings:${key}`
    if (SETTINGS_LEAF_KEPT.has(key)) continue
    if (asDistinctRoot(key).test(line) || (!SETTINGS_LEAF_NAMES.has(key) && asJsonKey(key).test(line))) return `settings:${key}`
    if (prose && inDocs(key).test(line)) return `settings:${key}`
  }
  return null
}
const CONCOURSE_HOME = new RegExp('^src/(components|services)/concourse/')
const crumbUpperRe = new RegExp('[Mm]ain[- ]' + J('RE', 'PL'))
const crumbSpacedRe = new RegExp(J('main', '[ ]', 'repl'), 'i')
const isCommentLine = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line)

const ALLOW: Array<[string, string, string]> = [
  ['scripts/identity/prove-vocabulary.ts', '*', 'this check composes the needles it holds'],
  ['src/services/ide/pythonTests.ts', 'run-short', 'pytest selects its own modules'],
  ['src/tools/BashTool/readOnlyValidation.ts', 'run-short', 'shell utility argument grammars'],
  ['src/tools/PowerShellTool/readOnlyValidation.ts', 'run-short', 'shell utility argument grammars'],
  ['src/utils/shell/readOnlyCommandValidation.ts', 'run-short', 'git and language-tool argument grammars'],
  ['src/utils/bash/ast.ts', 'run-short', 'the shell wait builtin argument grammar'],
  ['src/utils/bash/specs/pyright.ts', 'run-short', 'pyright project selection'],
  ['src/tools/AgentTool/reviewerPolicy.ts', 'run-short', 'mktemp scratch selection'],
  ['src/utils/processGroup.ts', 'run-short', 'POSIX process inspection'],
  ['src/daemon/processSweepPosix.ts', 'run-short', 'POSIX process inspection'],
  ['src/daemon/ownerWatch.ts', 'run-short', 'POSIX process inspection'],
  ['scripts/interview/baselines/', 'enter-glyph', 'frozen journey capture records keep their recorded bytes by design'],
  ['scripts/visual-contract/baselines/', 'enter-glyph', 'frozen capture records of earlier screens — diff anchors, deliberately never regenerated'],
  ['assets/vulcan/', 'words', "Godot's editor addon API (EditorPlugin, plugin.cfg, plugin.gd) — the engine's own vocabulary"],
  ['src/services/vulcan/', 'words', "Godot's editor addon API — the engine's own vocabulary"],
  ['src/utils/vulcan/', 'words', "Godot's editor addon API — the engine's own vocabulary (generated op table)"],
  ['scripts/vulcan/', 'words', "Godot's editor addon API — the engine's own vocabulary"],
  ['src/services/lsp/godotLane.ts', 'words', "Godot's editor addon API"],
  ['src/services/ide/pythonTests.ts', 'words', "pytest's own vocabulary for its add-ons"],
  ['BUILD-NOTES.md', 'words', "Bun's build API vocabulary (the build's module-resolution hook)"],
  ['MERCURY-COMMUNITY-PRODUCTION-TERMS.md', 'words', "the licence's companion terms: generic legal enumerations of third-party things, in the licence's own wording"],
  ['scripts/gate/gate-ledger.jsonl', 'words,retired', 'an append-only record of past gate runs'],
  ['scripts/project-intel/fixtures/', 'words', 'fixture repositories exercise ordinary English'],
  ['scripts/search/fixtures/', 'words', "captured third-party search-result pages — the outside world's own text, replayed verbatim"],
  ['scripts/search/prove-websearch-doors.ts', 'words', 'names the needles it refuses in its negative user-agent checks'],
  ['scripts/search/lib/bundle-for-node.ts', 'words', "Bun's build API vocabulary (the bundling hook)"],
  ['src/constants/changelog.ts', 'retired', 'a published record keeps its lines'],
  ['docs/releases/', 'retired', 'published release pages keep their lines'],
  ['scripts/identity/prove-release-notes-words.ts', 'retired', 'the release-notes word list — a forbidden-words list under scripts/identity'],
  ['scripts/identity/prove-retired-keys-unknown.ts', 'retired,settings', 'the retired settings keys it proves unknown — a forbidden-words list under scripts/identity'],
  ['scripts/computer/prove-computer-readiness.ts', 'settings', "the desktop scene file's own permissions record, not a settings key"],
  ['scripts/sessionStorage/prove-old-transcript-kinds-parse.ts', 'agent-type-general-purpose,option-crew-words', "an older build's sidecar fixture — one of the 16 on-disk proofs, unedited; and the retired crew spelling it proves absent from the launcher"],
  ['scripts/mission-runner/corpus/', 'mode-autopilot', "a fixture game's own autopilot — a scenario word, not the mode"],
  ['scripts/api/prove-typed-word-is-a-word.ts', 'mode-deepthink,mode-supercode,mode-ultrathink,mode-ultracode,mode-ultraplan', 'names the words it types to prove them plain'],
  ['scripts/prompt-input/prove-typed-word-plain-ink.ts', 'mode-deepthink,mode-supercode,mode-ultrathink', 'names the words it types to prove them plain ink'],
  ['scripts/effort/prove-effort-slider-ends-at-max.ts', 'mode-supercode,mode-ultracode,mode-effort-keys', 'names the needles it refuses: the slash word, the stored keys'],
  ['scripts/effort/prove-effort-persistence.ts', 'mode-supercode', 'names the needle it refuses in the stored keys'],
  ['scripts/permissions/prove-rule-words.ts', 'rule-prefix-form', 'spells the retired prefix form as the nonsense control beside the current one'],
  ['scripts/permissions/prove-mode-cycle-ends-at-sovereign.ts', 'mode-autopilot,mode-tier-tool,mode-tier-readout,mode-autopilot-env', 'names the needles it refuses: the mode word, the tier tool, the opt-in flag'],
  ['scripts/permissions/prove-retired-mode-words-unknown.ts', 'mode-spelling-accept-bypass,mode-spelling-table', 'names the spellings it proves unknown'],
  ['scripts/permissions/prove-apollo-plans.ts', 'strategy-slash,strategy-mode-value,strategy-plan-names', 'names the needles it refuses: the slash word, the mode value, the protocol kinds'],
  ['scripts/editor-bridge/prove-acp-saved-mode.ts', 'mode-spelling-accept-bypass', 'names the saved spellings it proves open as default'],
  ['scripts/editor-bridge/prove-vscode-bridge.ts', 'mode-spelling-accept-bypass', 'names the fixed list it proves the extension no longer carries'],
  ['scripts/switchboard/prove-seat-permission-mode.ts', 'mode-spelling-plan-auto', 'names the saved spelling it proves resolves to flow'],
  ['scripts/settings/prove-config-popup-rows.ts', 'ide-editor-link-keys,ide-diff-tool-type', 'names the keys and the type it proves gone from /config'],
  ['scripts/headless/prove-session-words.ts', 'helper-steward,verb-mcp,verb-auth-token,verb-extensions', 'names the retired spellings it proves unknown beside the current ones'],
  ['scripts/memory/prove-memory-always-on.ts', 'memory-gate-env', 'names the gate names it proves absent from the registry, the boot menu and the capability rows'],
  ['scripts/substrate/prove-git-facts-owner.ts', 'option-run-words', "git's own init --bare"],
  ['scripts/bash/prove-worktree-janitor.ts', 'option-run-words', "git's own init --bare"],
  ['scripts/agents/prove-worktree-base.ts', 'option-run-words', "git's own clone --bare"],
  ['scripts/ops/run-all.sh', 'option-run-words', 'names the launcher path it proves absent'],
  ['scripts/editor-bridge/prove-editor-door.ts', 'option-editor-link', 'names the flags it proves unknown'],
  ['scripts/updater/prove-update-journey.ts', 'verb-auth-token', 'names the gh subcommand it proves never asked'],
  ['scripts/updater/prove-never-public.ts', 'verb-auth-token', 'names the gh subcommand it proves never asked'],
  ['scripts/interview/corpus-verdict.json', 'sdk-wire-words', 'a frozen verdict record keeps its line'],
  ['scripts/terminal-boundary/prove-machine-output-contract.ts', 'sdk-wire-words', 'names the flags it proves absent from --help'],
  ['scripts/headless/prove-row-vocabulary.ts', 'control-frames', 'names the message kinds it proves apart from the rows and the frame it proves unread'],
  ['scripts/headless/prove-runner-wire-laws.ts', 'control-frames', 'feeds the retired frame it proves refused'],
  ['scripts/headless/prove-structuredio-laws.ts', 'control-frames', 'feeds the retired frame it proves refused'],
  ['scripts/daemon/prove-seat-door-direct.ts', 'control-frames', 'names the words it proves absent from the daemon'],
  ['scripts/identity/prove-unknown-command-answer.ts', 'health-word', 'names the word it proves unknown'],
  ['scripts/command-catalogue/prove-beta-journey-matrix.ts', 'health-word', 'names the word it proves is no surface'],
  ['scripts/ui/prove-old-transcript-rows.ts', 'screen-chat-word', "an older transcript's absent tool name — the row it proves paints by name"],
]
function allowed(path: string, rule: string): boolean {
  for (const [prefix, rules] of ALLOW) {
    if (path === prefix || path.startsWith(prefix)) {
      if (rules === '*' || rules.split(',').includes(rule)) return true
    }
  }
  return false
}

const XAI_CLIENT_REFERENCES = new Set([
  'mercury-skills/provider-apis/references/live-sources.md',
  'src/skills/bundled/provider-apis/references/live-sources.md',
  'scripts/providers/fixtures/xai-subscription-contract.json',
])
const RELEASE_RUN_LINES: Readonly<Record<string, string>> = {
  'src/constants/changelog.ts': '- Fixed mercury -p /usage (and the other screen-only commands) printing nothing instead of saying they need the interactive session',
  'docs/releases/1.0.0-beta.26.md': '- Fixed mercury -p /usage (and the other screen-only commands) printing',
}

function ownWords(path: string, line: string): string {
  if (!XAI_CLIENT_REFERENCES.has(path)) return line
  return line.replaceAll('packages/opencode/src/plugin/xai.ts', '')
    .replaceAll('packages/core/src/plugin/provider/xai.ts', '')
    .replaceAll('OpenCode auth plugin', '')
}

const BINARY_EXT = /\.(png|jpe?g|gif|ico|icns|pdf|wasm|woff2?|ttf|otf|node|zip|gz|tgz|jar|mp[34]|exe|dylib|so|bin|zst|tar|wav)$/i

type Violation = { path: string; line: number; rule: string; text: string }

function scan(files: Array<{ path: string; content: string }>): Violation[] {
  const out: Violation[] = []
  for (const f of files) {
    const lines = f.content.split('\n')
    const srcCode = f.path.startsWith('src/') && /\.(ts|tsx)$/.test(f.path)
    const concourse = CONCOURSE_HOME.test(f.path)
    const retiredHere = RETIRED_SCOPE.test(f.path) && !allowed(f.path, 'retired')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if ((line.includes(OTHER_ENTER_GLYPH) || otherEnterEscapeRe.test(line)) && !allowed(f.path, 'enter-glyph')) {
        out.push({ path: f.path, line: i + 1, rule: 'enter-glyph', text: line.trim().slice(0, 140) })
      }
      for (const [label, re] of WORDS) {
        const runRule = label.startsWith('run-')
        if (runRule ? !RUN_SCOPE.test(f.path) || allowed(f.path, 'run') || allowed(f.path, label) : allowed(f.path, 'words')) continue
        if (runRule && RELEASE_RUN_LINES[f.path] === line) continue
        let checked = ownWords(f.path, line)
        if (label === 'run-short') {
          checked = checked.replace(/\b(?:spawnSync|spawn|execFileSync|run)\(['"](?:ps|node|unzip|lsof|tmux)['"],\s*\[[^\n]*?['"]-p['"]/g, value => value.replace(/['"]-p['"]/, ''))
          checked = checked.replace(/\b(?:mkdir|ps|shopt|mktemp)\s+[^;&|\n]*?(?<![\w-])-p(?![\w-])/g, value => value.slice(0, -2))
        }
        if (re.test(checked)) {
          out.push({ path: f.path, line: i + 1, rule: `words:${label}`, text: line.trim().slice(0, 140) })
          break
        }
      }
      if (retiredHere) {
        for (const [label, re, stems] of RETIRED) {
          if (!stems.some(stem => line.includes(stem)) || allowed(f.path, label) || !re.test(line)) continue
          out.push({ path: f.path, line: i + 1, rule: `retired:${label}`, text: line.trim().slice(0, 140) })
          break
        }
      }
      if (srcCode && (concourse || !isCommentLine(line)) && (crumbUpperRe.test(line) || crumbSpacedRe.test(line))) {
        out.push({ path: f.path, line: i + 1, rule: 'focused-chat', text: line.trim().slice(0, 140) })
      }
      const settingsRule = settingsViolation(f.path, line)
      if (settingsRule !== null) out.push({ path: f.path, line: i + 1, rule: settingsRule, text: line.trim().slice(0, 140) })
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
console.log(' vocabulary — the tree speaks the product\'s own words')
console.log('============================================================')

{
  const enterBad = scan([{ path: 'fixture/enter.ts', content: ["const legend = '" + OTHER_ENTER_GLYPH + " confirm'", "controls: 'one call per \\" + 'u' + '23' + "ce'"].join('\n') }])
  check('§1 self-test: the other Enter glyph trips (literal + escape spelling)', enterBad.filter(v => v.rule === 'enter-glyph').length === 2, enterBad.map(v => v.rule).join(','))
  const enterGood = scan([{ path: 'fixture/enter-kit.ts', content: "const legend = '↵ confirm · esc cancel'" }])
  check('§1 self-test: the kit glyph stays silent', enterGood.length === 0, enterGood.map(v => v.rule).join(','))
  const frozen = scan([{ path: 'scripts/interview/baselines/x.txt', content: OTHER_ENTER_GLYPH }])
  check('§1 self-test: a frozen capture record is exempt', frozen.length === 0, frozen.map(v => v.rule).join(','))

  const wordsBad = scan([{ path: 'fixture/words.md', content: 'Install the ' + J('plug', 'in') + ' from the ' + J('market', 'place') + '.' }])
  check('§2 self-test: the two outside words trip', wordsBad.length === 1 && wordsBad[0]!.rule.startsWith('words:'), wordsBad.map(v => v.rule).join(','))
  const carved = scan([{ path: 'fixture/carved.ts', content: [
    "import { " + J('plug', 'in') + " } from 'bun'",
    '// biome-ignore lint/' + J('plug', 'in') + ': x',
    'const PYTEST_DISABLE_' + J('PLUG', 'IN') + '_AUTOLOAD = 1',
    'the JetBrains ' + J('plug', 'in') + ' directory',
    'plugins: [mercury' + J('Plug', 'in') + ']',
  ].join('\n') }])
  check('§2 self-test: the third-party senses stay silent', carved.length === 0, carved.map(v => v.text).join(' | '))
  const foreignReferences = 'packages/opencode/src/plugin/xai.ts packages/core/src/plugin/provider/xai.ts OpenCode auth plugin'
  check('external-client references keep their own paths and vocabulary only in the recorded sources',
    [...XAI_CLIENT_REFERENCES].every(path => scan([{ path, content: foreignReferences }]).length === 0) &&
      scan([{ path: 'docs/other.md', content: foreignReferences }]).length === 1)
  check('the external reference carveout never excuses Mercury words beside it',
    [...XAI_CLIENT_REFERENCES].every(path => scan([{ path, content: `${foreignReferences}; Mercury plugin` }]).length === 1))
  const product = scan([{ path: 'fixture/product.md', content: 'An extension comes from a source; add one with /extensions.' }])
  check('§2 self-test: the product words pass', product.length === 0, product.map(v => v.rule).join(','))

  const runInputs = ['mercury -p "hello"', '--print', '--output-format', '--input-format', '--include-partial-messages', '--dangerously-bypass-permissions', '--allow-dangerously-bypass-permissions', '--permission-mode']
  const runHomes = ['src/run-fixture.ts', 'docs/run-fixture.md', 'README.md', 'bench/run-fixture.py', '.github/run-fixture.yml']
  check('the run words are enforced on every owned surface', runHomes.every(path => runInputs.every(content => scan([{ path, content }]).some(hit => hit.rule.startsWith('words:run-')))))
  check('the script estate is outside the run-word scope', runInputs.every(content => scan([{ path: 'scripts/run-fixture.ts', content }]).length === 0))
  check('run words and other programs remain distinct', scan([{ path: 'src/run-fixture.ts', content: 'mercury run --format rows --input rows --partial --sovereign --allow-sovereign --mode flow' }, { path: 'bench/run-fixture.ts', content: "spawnSync('ps', ['-p', pid])" }, { path: '.github/run-fixture.yml', content: 'mkdir -p output' }]).length === 0)
  check('the argv reader has no run-word exemption', scan([{ path: 'src/cli/runArgs.ts', content: '--print' }]).length === 1)
  check('the two published release lines keep their recorded bytes', Object.entries(RELEASE_RUN_LINES).every(([path, content]) => scan([{ path, content }]).length === 0))
  check('release records and foreign commands do not exempt new run spellings', scan([{ path: 'docs/releases/fixture.md', content: 'mercury -p' }, { path: 'src/constants/changelog.ts', content: 'mercury -p' }, { path: '.github/fixture.yml', content: 'mkdir -p out && mercury -p hello' }]).length === 3)

  const crumb = 'esc ' + J('main', ' ', 'RE', 'PL')
  const crumbRule = (hits: Violation[]): Violation[] => hits.filter(v => v.rule === 'focused-chat')
  const crumbHits = scan([{ path: 'src/components/x.tsx', content: "const label = '" + crumb + "'" }])
  check('§3 self-test: the crumb phrase trips as screen text', crumbRule(crumbHits).length === 1, JSON.stringify(crumbHits))
  const crumbComment = scan([{ path: 'src/components/x.tsx', content: '// the ' + crumb + ' route' }])
  check('§3 self-test: a comment outside the concourse stays silent under the crumb rule', crumbRule(crumbComment).length === 0, JSON.stringify(crumbComment))
  const crumbConcourse = scan([{ path: 'src/components/concourse/x.tsx', content: '// the ' + crumb + ' route' }])
  check('§3 self-test: the concourse holds the rule on every line', crumbRule(crumbConcourse).length === 1, JSON.stringify(crumbConcourse))
  check('§3 self-test: the screen word itself trips on every line, comments included', [crumbHits, crumbComment, crumbConcourse].every(hits => hits.some(v => v.rule === 'retired:screen-chat-word')))
  const routeId = scan([{ path: 'src/components/x.tsx', content: "const id = '" + J('main-re', 'pl') + "'" }])
  check('§3 self-test: the route id stays legal', routeId.length === 0, JSON.stringify(routeId))
}

{
  const settingsHits = (path: string, content: string): string[] => scan([{ path, content }]).filter(v => v.rule.startsWith('settings:')).map(v => v.rule)
  const everyRoot = [...RETIRED_SETTINGS_ROOTS, ...RETIRED_SETTINGS_GENERIC_ROOTS]
  check('§4 self-test: every former root trips as a settings write in a proof', everyRoot.every(key => settingsHits('scripts/settings/prove-x.ts', `writeFileSync(join(home, 'settings.json'), JSON.stringify({ ${key}: value }))`).length === 1))
  check('§4 self-test: every former root trips as an updateSettingsForSource write', everyRoot.every(key => settingsHits('src/x.ts', `updateSettingsForSource('userSettings', { ${key}: value })`).length === 1))
  check('§4 self-test: every former root trips as a read off the settings', everyRoot.every(key => settingsHits('src/x.ts', `const v = getInitialSettings().${key} ?? settings.${key}`).length === 1))
  check('§4 self-test: every former root trips as a SettingsJson index', everyRoot.every(key => settingsHits('scripts/settings/prove-x.ts', `type T = SettingsJson['${key}']`).length === 1))
  check('§4 self-test: every former root trips as a dotted path in the docs', everyRoot.every(key => settingsHits('docs/x.md', 'set `' + key + '.leaf` in settings.json').length === 1))
  check('§4 self-test: a distinct former root trips as a backticked name and as a settings word in the docs', RETIRED_SETTINGS_ROOTS.every(key => settingsHits('README.md', 'toggle `' + key + '` in /config').length === 1 && settingsHits('docs/x.md', `the ${key} setting (toggled in /config)`).length === 1))
  check('§4 self-test: a distinct former root trips as a JSON key unless it lives on as a leaf name under a group', RETIRED_SETTINGS_ROOTS.every(key => settingsHits('scripts/settings/fixture.json', `  "${key}": true,`).length === (SETTINGS_LEAF_NAMES.has(key) ? 0 : 1)))
  check('§4 self-test: every former adoption field trips in a settings file', RETIRED_SETTINGS_FIELDS.every(key => settingsHits('scripts/settings/fixture.json', `  "${key}": true,`).length === 1))
  check('§4 self-test: every retired module name trips in src', RETIRED_SETTINGS_MODULES.every(name => settingsHits('src/x.ts', `import { x } from './migrations/${name}.js'`).length === 1))
  check('§4 self-test: the two former policy places trip in src', RETIRED_POLICY_PLACES.every(place => settingsHits('src/utils/settings/mdm/x.ts', `const DOMAIN = '${place}'`).length === 1))
  const quiet: Array<[string, string]> = [
    ['src/x.ts', "const prefersReducedMotion = useAppState(state => state.settings.view?.reducedMotion === true)"],
    ['src/x.ts', "const effortLevel = (opts.effort as EffortLevel | undefined) ?? getInitialSettings().engine?.effort"],
    ['src/x.ts', "facts: { modelId, effortLevel: 'high', instructionProfile: 'native' }"],
    ['src/x.ts', "const shell = manifest.shellEngine as { vendored?: boolean }"],
    ['src/x.ts', "body: JSON.stringify({ model: tag, stream: true })"],
    ['src/x.ts', "const id = `agent:${agentId}`; const row = `model:${modelId}`; env: subprocessEnv()"],
    ['src/x.ts', "import { localServerSettingsOf } from '../../services/localServer/localServerKnobs.js'"],
    ['src/x.ts', "updateSettingsForSource('userSettings', { guardrails: { allow: rules }, events: { hooks }, extensions: { exclusive: true }, local: { server: { keepAlive: '30m' } } })"],
    ['src/x.ts', "const centred = settings.view?.modelPicker?.centred ?? settings.view?.sessionsBar; const m = getInitialSettings().engine?.model"],
    ['scripts/settings/settings-schema.json', '        "sessionsBar": {'],
    ['scripts/settings/settings-schema.json', '        "backgroundKey": {'],
    ['docs/x.md', 'Set `guardrails.allow`, `events.hooks.PreToolUse`, `view.sessionsBar`, `engine.model` and `local.server.keepAlive` in settings.json.'],
    ['docs/x.md', 'The `/model` picker and the `agent` definitions, with `permissions` in the plain sense.'],
    ['src/x.ts', "process.env.MERCURY_SHELL_ENGINE ?? process.env.MERCURY_REDUCED_MOTION"],
  ]
  check('§4 self-test: the current nested forms, the ordinary identifiers and the API bodies stay quiet', quiet.every(([path, content]) => settingsHits(path, content).length === 0), quiet.filter(([path, content]) => settingsHits(path, content).length > 0).map(([, content]) => content).join(' | '))
  check('§4 self-test: the settings rows reach the whole script estate', settingsHits('scripts/ui/prove-x.ts', "writeFileSync(join(home, 'settings.json'), JSON.stringify({ prefersReducedMotion: true }))").length === 1 && settingsHits('scripts/settings/prove-x.ts', "writeFileSync(join(home, 'settings.json'), JSON.stringify({ prefersReducedMotion: true }))").length === 1 && settingsHits('scripts/ui/prove-x.ts', "writeFileSync(join(home, 'settings.json'), JSON.stringify({ view: { reducedMotion: true } }))").length === 0)
  check('§4 self-test: the two published release lines keep their recorded bytes, and a changed line trips', Object.entries(RELEASE_SETTINGS_LINES).every(([path, content]) => settingsHits(path, content).length === 0 && settingsHits(path, content + ' more').length === 1))
}

{
  const retiredHits = (path: string, content: string): string[] => scan([{ path, content }]).filter(v => v.rule.startsWith('retired:')).map(v => v.rule.slice('retired:'.length))
  const trips: Array<[string, string]> = [
    ['mode-deepthink', 'type ' + J('deep', 'think') + ' to raise the effort'],
    ['mode-supercode', 'the /' + J('super', 'code') + ' command'],
    ['mode-ultraplan', '`' + J('ultra', 'plan') + '`'],
    ['mode-autopilot', '--mode ' + J('auto', 'pilot')],
    ['mode-tier-tool', "name: '" + J('Set', 'Tier') + "'"],
    ['mode-autopilot-env', 'process.env.' + J('MERCURY_AUTO', 'PILOT_MODELS')],
    ['mode-effort-keys', 'settings.' + J('super', 'codeEffort')],
    ['mode-trigger-machinery', "import { glow } from './" + J('keyword', 'Glow') + ".js'"],
    ['mode-spelling-accept-bypass', "permissionMode: '" + J('accept', 'Edits') + "'"],
    ['mode-spelling-accept-bypass', 'permissionMode: ' + J('bypass', 'Permissions')],
    ['mode-spelling-plan-auto', 'mercury run --mode plan'],
    ['mode-spelling-plan-auto', "{ defaultMode: 'auto' }"],
    ['mode-spelling-table', 'export const ' + J('RETIRED_PERMISSION_', 'MODE_SPELLINGS') + ' = {}'],
    ['strategy-mode-tools', J('Exit', 'PlanModeV2')],
    ['strategy-slash', 'type /' + J('strat', 'egy') + ' to plan'],
    ['strategy-mode-value', '--mode ' + J('strat', 'egy')],
    ['strategy-mode-value', "if (mode === '" + J('strat', 'egy') + "')"],
    ['strategy-mode-names', J('pre', 'StrategyMode')],
    ['strategy-plan-names', J('plan_', 'approval_request')],
    ['strategy-plan-names', J('plans', 'Directory')],
    ['strategy-band', J('Strat', 'egy Mode')],
    ['strategy-settings', '`' + J('strat', 'egy.directory') + '`'],
    ['strategy-opusplan', "model: '" + J('opus', 'plan') + "'"],
    ['strategy-floors', "reason: '" + J('plan-', 'floor') + "'"],
    ['ide-editor-link-keys', 'settings.' + J('auto', 'ConnectIde')],
    ['ide-diff-tool-type', 'type ' + J('Diff', 'Tool') + ' = string'],
    ['ide-fs-right', J('_cla', 'ude_fs_right')],
    ['ide-mcp-ide', J('mcp__', 'ide__getDiagnostics')],
    ['ide-companion', J('register', 'EditorCompanion') + '()'],
    ['ide-visual-bell', 'a ' + J('visual', ' bell') + ' on completion'],
    ['verb-extensions', 'run `mercury ' + J('extensions', ' validate') + '`'],
    ['helper-steward', 'mercury ' + J('ste', 'ward') + ' run'],
    ['agent-type-general', "subagent_type: '" + J('mercury-', 'general') + "'"],
    ['agent-type-general-purpose', "agentType: '" + J('general', '-purpose') + "'"],
    ['agent-type-verifier', 'the ' + J('mercury-', 'verifier') + ' agent'],
    ['push-tool', J('Push', 'NotificationTool')],
    ['push-saturn-exempt', J('MERCURY_SATURN_', 'EXEMPT_PUSH')],
    ['push-notif-keys', J('agentPush', 'NotifEnabled')],
    ['push-os-notification', 'context.' + J('sendOS', 'Notification')],
    ['push-proof-name', 'scripts/notifications/' + J('prove-push-', 'notification-honest') + '.ts'],
    ['mode-ultrathink', 'say ' + J('ultra', 'think')],
    ['mode-ultracode', 'say ' + J('ultra', 'code')],
    ['mode-tier-readout', 'the ' + J('self-', 'tier') + ' readout'],
    ['strategy-flags', '--require-' + J('strat', 'egy')],
    ['agent-type-background', J('mercury-', 'background')],
    ['agent-type-architect', J('mercury-', 'architect')],
    ['agent-type-guide', J('mercury-', 'guide')],
    ['agent-type-reviewer', J('mercury-', 'reviewer')],
    ['ide-companion-name', J('mercury-editor', '-companion')],
    ['memory-gate-env', 'process.env.' + J('MERCURY_', 'MNEME')],
    ['memory-gate-env', J('MERCURY_RELEVANT', '_RECALL') + '=1'],
    ['option-debug-words', 'mercury ' + J('--debug', '-file') + ' out.log'],
    ['option-debug-words', 'mercury -' + J('d2', 'e')],
    ['option-run-words', 'mercury run ' + J('--append-system', '-prompt') + ' x'],
    ['option-run-words', "['" + J('--tm', 'ux') + "']"],
    ['option-crew-words', J('--crew', '-name') + ' alpha'],
    ['option-editor-link', J('--editor', '-link')],
    ['verb-mcp', 'mercury ' + J('mcp add', '-json')],
    ['verb-auth-token', '`mercury ' + J('auth ', 'token') + '`'],
    ['verb-extensions', "'" + J('extensions ', 'approve') + "'"],
    ['verb-root', 'mercury ' + J('join', '-kit')],
    ['verb-root', 'run `mercury ' + J('agen', 'ts') + '`'],
    ['rule-prefix-form', "allow: ['Bash(npm run" + J(':', '*)') + "']"],
    ['rule-prefix-form', 'Skill(deploy' + J(':', '*)')],
    ['rule-prefix-form', "rule.endsWith('" + J(':', '*') + "')"],
    ['rule-sentences', 'this command is blocked by a ' + J('deny ', 'rule')],
    ['rule-sentences', J('Permission ', "rule 'Bash(rm *)' requires approval for this command")],
    ['rule-sentences', 'Permission to edit src/x.ts ' + J('requires ', 'confirmation')],
    ['rule-sentences', J('Permission rules can be ', 'changed in /permissions')],
    ['sdk-result-fields', 'row.' + J('duration_api', '_ms') + ' === 0'],
    ['sdk-result-fields', '{ ' + J('num_', 'turns') + ': 3 }'],
    ['sdk-result-error-word', "subtype === '" + J('error_during', '_execution') + "'"],
    ['sdk-wire-words', 'mercury run --format ' + J('stream-', 'json')],
    ['sdk-wire-words', J('--permission-', 'channel') + ' stdio'],
    ['sdk-wire-names', 'const spec: ' + J('Stream', 'JsonChildSpec') + ' = x'],
    ['sdk-wire-names', 'import { guard } from "./' + J('stream', 'JsonStdoutGuard') + '.js"'],
    ['sdk-home', "import type { Row } from '../" + J('entrypoints/', 'sdk') + "/types.js'"],
    ['sdk-home', 'const frame: ' + J('SDKAssistant', 'Message') + ' = x'],
    ['sdk-init-names', 'import { ' + J('SdkInit', 'Owner') + " } from './runtime/" + J('sdk-', 'init') + ".js'"],
    ['control-frames', "if (frame.type === '" + J('control_', 'request') + "') {"],
    ['control-frames', "{ subtype: '" + J('can_use', '_tool') + "' }"],
    ['activity-stream-arms', "name: '" + J('stream-', 'file-change') + "',"],
    ['activity-stream-arms', 'for (const sub of ' + J('explodeActivity', 'Inputs') + '(input))'],
    ['screen-chat-path', "import { Chat } from '../" + J('screens/', 'RE', 'PL') + ".js'"],
    ['screen-chat-launcher', J('launch', 'Repl') + '(root)'],
    ['screen-chat-word', 'the ' + J('RE', 'PL') + ' screen'],
    ['flow-classifier-names', "import { classify } from './" + J('yolo', 'Classifier') + ".js'"],
    ['mneme-home-name', "join(home, '" + J('mem', 'dir') + "')"],
    ['mneme-home-name', 'const ' + J('mem', 'Dir') + ' = home'],
    ['turn-engine-names', 'new ' + J('Query', 'Engine') + '(opts)'],
    ['crew-names', J('isAgent', 'SwarmsEnabled') + '()'],
    ['engine-model-name', 'const m = ' + J('main', 'LoopModel')],
    ['respond-to-model-name', J('handleRespondTo', 'Claude') + '()'],
    ['shell-snapshot-name', J('getClaudeCode', 'SnapshotContent') + '()'],
    ['skill-scope-name', J('getClaudeSkill', 'Scope') + '()'],
    ['command-words', 'type ' + J('/co', 'st') + ' to see the spend'],
    ['command-words', "'" + J('/fi', 'les') + "'"],
    ['health-word', 'mercury doc' + 'tor --json'],
    ['stop-checker-slash', 'type /' + J('super', 'visor') + ' on to check stops'],
    ['stop-checker-env', 'process.env.' + J('MERCURY_SUPER', 'VISOR') + " === '1'"],
    ['stop-checker-key', 'getGlobalConfig().' + J('super', 'visorEnabled') + ' === true'],
    ['stop-checker-key', "import { " + J('setSuper', 'visorEnabled') + " } from './" + J('super', 'visorGate') + ".js'"],
    ['identity-old-ids', J('legacyOperator', 'PrincipalIds') + '()'],
    ['identity-old-ids', J('principalId', 'OwnsRecord') + '(caller, owner)'],
  ]
  check('§5 self-test: every retired-word row has a spelling here and trips on it in src', RETIRED.every(([label]) => trips.some(([l]) => l === label)) && trips.every(([label, content]) => retiredHits('src/x.ts', content).includes(label)), trips.filter(([label, content]) => !retiredHits('src/x.ts', content).includes(label)).map(([label]) => label).join(','))
  check('§5 self-test: the rows reach docs, the README and the script estate', retiredHits('docs/x.md', trips[0]![1]).length === 1 && retiredHits('README.md', trips[0]![1]).length === 1 && retiredHits('scripts/x/prove-x.ts', trips[0]![1]).length === 1)
  check('§5 self-test: the rows stop at the owned surfaces', retiredHits('bench/x.py', trips[0]![1]).length === 0 && retiredHits('assets/x.gd', trips[0]![1]).length === 0 && retiredHits('.github/x.yml', trips[0]![1]).length === 0)
  const quiet: string[] = [
    "allow: ['Bash(npm run *)', 'Skill(deploy*)']; const ids = ['node:*', 'command:*', 'scroll:*', 'lane:lsp:*', 'ansi:*', 'surface:*', '**']",
    'Permission to use X has been denied: the mode denies it; Permission to read from /x has not been granted.; A subcommand was denied.; the hook requires approval for this command; denied by a rule',
    'const ' + J('accept', 'EditsFastPath') + ' = true; ' + J('isBypass', 'PermissionsModeAvailable') + '()',
    'const diffToolInputs = []; ' + J('bypass', 'PermissionsKillswitch') + '.js',
    "versionNegotiation: { mode: 'auto' }",
    'the compaction strategy keeps the plan; a planning mode; the plan is ready',
    "effort: 'max'; thinking raised; the mode is implement",
    "const plan = 'ae-1'; input.plan; plan_ready; ultraplanPhase",
    'autopilots are not this word; a general-purpose-ish phrase is not the type; mercury-generalist',
    'PushNotifications in the plural are another word; sendOSNotifications too',
    'the daemon is the helper; a stewardship word is not the verb',
    'Both an auth token and an API key are configured; the extensions check their manifests; git init --quiet; i--; mercury image > file',
    'mercury roster; mercury bridge install; --log-file out.log; --crew alpha --seat bravo; MERCURY_MEMORY_OBSERVE=1',
    "type: 'hook_error_during_execution'; api_ms: 12; steps: 3; session/set_mode; permission/request; the stream-fault row; { type: 'callback' }; the SDK of the provider; sdkErrors.ts; the MCP SDK",
    't(a, /' + J('co', 'lor') + "=\\{tokens\\.success\\}/.test(src)); t(b, /" + J('fi', 'les') + " stay on disk/.test(msg)); t(c, /" + J('co', 'lor') + " = 'warning'/.test(dialog)); t(d, /" + J('co', 'lor') + '/.test(grid)); src/commands/' + J('co', 'st') + '/; the replay; replace(); mercury health --json; the Mneme home; crew; flowClassifier; getEngineModel()',
  ]
  check('§5 self-test: kept identifiers, ordinary English and other programs stay quiet', quiet.every(content => retiredHits('src/x.ts', content).length === 0), quiet.filter(content => retiredHits('src/x.ts', content).length > 0).join(' | '))
  check('§5 self-test: a published record and a forbidden-words list keep their lines', retiredHits('src/constants/changelog.ts', trips[1]![1]).length === 0 && retiredHits('docs/releases/1.0.0-beta.9.md', trips[1]![1]).length === 0 && retiredHits('scripts/identity/prove-release-notes-words.ts', trips[1]![1]).length === 0)
  check('§5 self-test: a label-scoped exemption excuses its own word and no other', retiredHits('scripts/effort/prove-effort-persistence.ts', trips[1]![1]).length === 0 && retiredHits('scripts/effort/prove-effort-persistence.ts', trips[0]![1]).length === 1)
  check('§5 self-test: the one stored sidecar fixture keeps its type word and nothing beside it', retiredHits('scripts/sessionStorage/prove-old-transcript-kinds-parse.ts', trips[33]![1]).length === 0 && retiredHits('scripts/sessionStorage/prove-old-transcript-kinds-parse.ts', trips[32]![1]).length === 1)
}

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
  for (const v of violations) console.log(`${v.path}:${v.line}  [${v.rule}]  ${v.text}`)
  console.log(`\n${violations.length} hit(s)`)
  process.exit(0)
}
check(`tracked tree speaks the product vocabulary (${tracked.length} files)`, violations.length === 0,
  violations.slice(0, 12).map(v => `${v.path}:${v.line} [${v.rule}]`).join(' · '))

{
  const mootRows = (rows: ReadonlyArray<[string, string, string]>): string[] =>
    rows.filter(([prefix]) => !tracked.some(p => p === prefix || p.startsWith(prefix))).map(([prefix]) => prefix)
  const moot = mootRows(ALLOW)
  check('every exemption names a path the tracked tree still holds', moot.length === 0, moot.join(' · '))
  check('every external-client reference scope names a tracked file', [...XAI_CLIENT_REFERENCES].every(path => tracked.includes(path)))
  const planted = mootRows([...ALLOW, ['src/no-such-home/', 'words', 'poison: a row for a path that is gone']])
  check('exemption self-test: a planted row for an absent path is reported', planted.length === 1 && planted[0] === 'src/no-such-home/', planted.join(' · '))
}

const distPath = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(distPath)) {
  console.log('  [SKIP] dist/mercury.mjs not built — run `bun run build.ts` for the dist rule')
} else {
  const dist = readFileSync(distPath, 'utf8')
  check('dist: zero occurrences of the other Enter glyph (the bundle speaks the kit vocabulary)', !dist.includes(OTHER_ENTER_GLYPH))
  check('dist needle control: a planted glyph trips', ('legend ' + OTHER_ENTER_GLYPH).includes(OTHER_ENTER_GLYPH))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ vocabulary: ${failures} FAILED`)
  process.exit(1)
}
console.log('✅ vocabulary: clean')
