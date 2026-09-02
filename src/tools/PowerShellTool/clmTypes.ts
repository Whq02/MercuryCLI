/**
 * The ConstrainedLanguage type allowlist. Microsoft's ConstrainedLanguageMode
 * restricts .NET type usage to a published allowlist; this slice INVERTS it —
 * a type literal (or a New-Object type name) not in the set forces an ask.
 * That replaces enumerating individual dangerous types.
 *
 * The table is a factual data table derived from Microsoft's
 * `about_Language_Modes`, stored lowercase, carrying both short accelerator
 * names and fully-qualified names, MINUS deliberate security removals (adsi /
 * wmi / cimsession families — casting to those performs an unvalidated network
 * bind or remote query; do not re-add).
 */

/** The allowed .NET/PowerShell type names (contract data, lowercase). */
export const CLM_ALLOWED_TYPES: ReadonlySet<string> = new Set([
  // Accelerators (short names)
  'alias', 'allowemptycollection', 'allowemptystring', 'allownull',
  'argumentcompleter', 'argumentcompletions', 'array', 'bigint', 'bool', 'byte',
  'char', 'cimclass', 'cimconverter', 'ciminstance', 'cimtype', 'cmdletbinding',
  'cultureinfo', 'datetime', 'decimal', 'double', 'dsclocalconfigurationmanager',
  'dscproperty', 'dscresource', 'experimentaction', 'experimental',
  'experimentalfeature', 'float', 'guid', 'hashtable', 'int', 'int16', 'int32',
  'int64', 'ipaddress', 'ipendpoint', 'long', 'mailaddress', 'norunspaceaffinity',
  'nullstring', 'objectsecurity', 'ordered', 'outputtype', 'parameter',
  'physicaladdress', 'pscredential', 'pscustomobject', 'psdefaultvalue',
  'pslistmodifier', 'psobject', 'psprimitivedictionary', 'pstypenameattribute',
  'ref', 'regex', 'sbyte', 'securestring', 'semver', 'short', 'single', 'string',
  'supportswildcards', 'switch', 'timespan', 'uint', 'uint16', 'uint32', 'uint64',
  'ulong', 'uri', 'ushort', 'validatecount', 'validatedrive', 'validatelength',
  'validatenotnull', 'validatenotnullorempty', 'validatenotnullorwhitespace',
  'validatepattern', 'validaterange', 'validatescript', 'validateset',
  'validatetrusteddata', 'validateuserdrive', 'version', 'void', 'wildcardpattern',
  'x500distinguishedname', 'x509certificate', 'xml',
  // Fully-qualified forms of the primitive/BCL accelerators
  'system.array', 'system.boolean', 'system.byte', 'system.char',
  'system.datetime', 'system.decimal', 'system.double', 'system.guid',
  'system.int16', 'system.int32', 'system.int64', 'system.numerics.biginteger',
  'system.sbyte', 'system.single', 'system.string', 'system.timespan',
  'system.uint16', 'system.uint32', 'system.uint64', 'system.uri',
  'system.version', 'system.void', 'system.collections.hashtable',
  'system.text.regularexpressions.regex', 'system.globalization.cultureinfo',
  'system.net.ipaddress', 'system.net.ipendpoint', 'system.net.mail.mailaddress',
  'system.net.networkinformation.physicaladdress', 'system.security.securestring',
  'system.security.cryptography.x509certificates.x509certificate',
  'system.security.cryptography.x509certificates.x500distinguishedname',
  'system.xml.xmldocument',
  // PowerShell-specific fully-qualified forms
  'system.management.automation.pscredential',
  'system.management.automation.pscustomobject',
  'system.management.automation.pslistmodifier',
  'system.management.automation.psobject',
  'system.management.automation.psprimitivedictionary',
  'system.management.automation.psreference',
  'system.management.automation.semanticversion',
  'system.management.automation.switchparameter',
  'system.management.automation.wildcardpattern',
  'system.management.automation.language.nullstring',
  // CIM fully-qualified forms
  'microsoft.management.infrastructure.cimclass',
  'microsoft.management.infrastructure.cimconverter',
  'microsoft.management.infrastructure.ciminstance',
  'microsoft.management.infrastructure.cimtype',
  // Remaining fully-qualified entries
  'system.collections.specialized.ordereddictionary',
  'system.security.accesscontrol.objectsecurity', 'object', 'system.object',
  'microsoft.powershell.commands.modulespecification',
])

/** Lowercase; strip a trailing `[]` array suffix and a trailing generic arg list; trim. */
export function normalizeTypeName(name: string): string {
  let out = name.toLowerCase().trim()
  out = out.replace(/\[\s*\]$/, '') // array suffix (arrays of allowed types are allowed)
  out = out.replace(/\[[^\]]*\]$/, '') // trailing bracketed generic argument list
  return out.trim()
}

/** Membership of the normalised name in the allowlist. */
export function isClmAllowedType(typeName: string): boolean {
  return CLM_ALLOWED_TYPES.has(normalizeTypeName(typeName))
}
