export interface KeyboardMode {
	kittyProtocolActive: boolean;
	windowsTerminalSession: boolean;
}

type Letter =
	| "a"
	| "b"
	| "c"
	| "d"
	| "e"
	| "f"
	| "g"
	| "h"
	| "i"
	| "j"
	| "k"
	| "l"
	| "m"
	| "n"
	| "o"
	| "p"
	| "q"
	| "r"
	| "s"
	| "t"
	| "u"
	| "v"
	| "w"
	| "x"
	| "y"
	| "z";

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

type SymbolKey =
	| "`"
	| "-"
	| "="
	| "["
	| "]"
	| "\\"
	| ";"
	| "'"
	| ","
	| "."
	| "/"
	| "!"
	| "@"
	| "#"
	| "$"
	| "%"
	| "^"
	| "&"
	| "*"
	| "("
	| ")"
	| "_"
	| "+"
	| "|"
	| "~"
	| "{"
	| "}"
	| ":"
	| "<"
	| ">"
	| "?";

type SpecialKey =
	| "escape"
	| "esc"
	| "enter"
	| "return"
	| "tab"
	| "space"
	| "backspace"
	| "delete"
	| "insert"
	| "clear"
	| "home"
	| "end"
	| "pageUp"
	| "pageDown"
	| "up"
	| "down"
	| "left"
	| "right"
	| "f1"
	| "f2"
	| "f3"
	| "f4"
	| "f5"
	| "f6"
	| "f7"
	| "f8"
	| "f9"
	| "f10"
	| "f11"
	| "f12";

type BaseKey = Letter | Digit | SymbolKey | SpecialKey;
type ModifierName = "ctrl" | "shift" | "alt" | "super";

type ModifiedKeyId<Key extends string, RemainingModifiers extends ModifierName = ModifierName> = {
	[M in RemainingModifiers]: `${M}+${Key}` | `${M}+${ModifiedKeyId<Key, Exclude<RemainingModifiers, M>>}`;
}[RemainingModifiers];

export type KeyId = BaseKey | ModifiedKeyId<BaseKey>;

export const Key = {
	escape: "escape" as const,
	esc: "esc" as const,
	enter: "enter" as const,
	return: "return" as const,
	tab: "tab" as const,
	space: "space" as const,
	backspace: "backspace" as const,
	delete: "delete" as const,
	insert: "insert" as const,
	clear: "clear" as const,
	home: "home" as const,
	end: "end" as const,
	pageUp: "pageUp" as const,
	pageDown: "pageDown" as const,
	up: "up" as const,
	down: "down" as const,
	left: "left" as const,
	right: "right" as const,
	f1: "f1" as const,
	f2: "f2" as const,
	f3: "f3" as const,
	f4: "f4" as const,
	f5: "f5" as const,
	f6: "f6" as const,
	f7: "f7" as const,
	f8: "f8" as const,
	f9: "f9" as const,
	f10: "f10" as const,
	f11: "f11" as const,
	f12: "f12" as const,

	backtick: "`" as const,
	hyphen: "-" as const,
	equals: "=" as const,
	leftbracket: "[" as const,
	rightbracket: "]" as const,
	backslash: "\\" as const,
	semicolon: ";" as const,
	quote: "'" as const,
	comma: "," as const,
	period: "." as const,
	slash: "/" as const,
	exclamation: "!" as const,
	at: "@" as const,
	hash: "#" as const,
	dollar: "$" as const,
	percent: "%" as const,
	caret: "^" as const,
	ampersand: "&" as const,
	asterisk: "*" as const,
	leftparen: "(" as const,
	rightparen: ")" as const,
	underscore: "_" as const,
	plus: "+" as const,
	pipe: "|" as const,
	tilde: "~" as const,
	leftbrace: "{" as const,
	rightbrace: "}" as const,
	colon: ":" as const,
	lessthan: "<" as const,
	greaterthan: ">" as const,
	question: "?" as const,

	ctrl: <K extends BaseKey>(key: K): `ctrl+${K}` => `ctrl+${key}`,
	shift: <K extends BaseKey>(key: K): `shift+${K}` => `shift+${key}`,
	alt: <K extends BaseKey>(key: K): `alt+${K}` => `alt+${key}`,
	super: <K extends BaseKey>(key: K): `super+${K}` => `super+${key}`,

	ctrlShift: <K extends BaseKey>(key: K): `ctrl+shift+${K}` => `ctrl+shift+${key}`,
	shiftCtrl: <K extends BaseKey>(key: K): `shift+ctrl+${K}` => `shift+ctrl+${key}`,
	ctrlAlt: <K extends BaseKey>(key: K): `ctrl+alt+${K}` => `ctrl+alt+${key}`,
	altCtrl: <K extends BaseKey>(key: K): `alt+ctrl+${K}` => `alt+ctrl+${key}`,
	shiftAlt: <K extends BaseKey>(key: K): `shift+alt+${K}` => `shift+alt+${key}`,
	altShift: <K extends BaseKey>(key: K): `alt+shift+${K}` => `alt+shift+${key}`,
	ctrlSuper: <K extends BaseKey>(key: K): `ctrl+super+${K}` => `ctrl+super+${key}`,
	superCtrl: <K extends BaseKey>(key: K): `super+ctrl+${K}` => `super+ctrl+${key}`,
	shiftSuper: <K extends BaseKey>(key: K): `shift+super+${K}` => `shift+super+${key}`,
	superShift: <K extends BaseKey>(key: K): `super+shift+${K}` => `super+shift+${key}`,
	altSuper: <K extends BaseKey>(key: K): `alt+super+${K}` => `alt+super+${key}`,
	superAlt: <K extends BaseKey>(key: K): `super+alt+${K}` => `super+alt+${key}`,

	ctrlShiftAlt: <K extends BaseKey>(key: K): `ctrl+shift+alt+${K}` => `ctrl+shift+alt+${key}`,
	ctrlShiftSuper: <K extends BaseKey>(key: K): `ctrl+shift+super+${K}` => `ctrl+shift+super+${key}`,
} as const;

const SYMBOL_KEYS = new Set([
	"`",
	"-",
	"=",
	"[",
	"]",
	"\\",
	";",
	"'",
	",",
	".",
	"/",
	"!",
	"@",
	"#",
	"$",
	"%",
	"^",
	"&",
	"*",
	"(",
	")",
	"_",
	"+",
	"|",
	"~",
	"{",
	"}",
	":",
	"<",
	">",
	"?",
]);

const SHIFTED_SYMBOL_KEYS = new Set("~!@#$%^&*()_+|{}:<>?");

const MODIFIER_NAMES = ["shift", "alt", "ctrl", "super"] as const;

const MODIFIERS = {
	shift: 1,
	alt: 2,
	ctrl: 4,
	super: 8,
} as const;

const LOCK_MASK = 64 + 128;

const CODEPOINTS = {
	escape: 27,
	tab: 9,
	enter: 13,
	space: 32,
	backspace: 127,
	kpEnter: 57414,
} as const;

const ARROW_CODEPOINTS = {
	up: -1,
	down: -2,
	right: -3,
	left: -4,
} as const;

const FUNCTIONAL_CODEPOINTS = {
	delete: -10,
	insert: -11,
	pageUp: -12,
	pageDown: -13,
	home: -14,
	end: -15,
	f1: -21,
	f2: -22,
	f3: -23,
	f4: -24,
	f5: -25,
	f6: -26,
	f7: -27,
	f8: -28,
	f9: -29,
	f10: -30,
	f11: -31,
	f12: -32,
} as const;

const KITTY_FUNCTIONAL_PUA_START = 57344;
const KITTY_FUNCTIONAL_PUA_END = 63743;
const MAX_CODEPOINT = 0x10ffff;

const KITTY_FUNCTIONAL_KEY_EQUIVALENTS = new Map<number, number>([
	[57399, 48],
	[57400, 49],
	[57401, 50],
	[57402, 51],
	[57403, 52],
	[57404, 53],
	[57405, 54],
	[57406, 55],
	[57407, 56],
	[57408, 57],
	[57409, 46],
	[57410, 47],
	[57411, 42],
	[57412, 45],
	[57413, 43],
	[57415, 61],
	[57416, 44],
	[57417, ARROW_CODEPOINTS.left],
	[57418, ARROW_CODEPOINTS.right],
	[57419, ARROW_CODEPOINTS.up],
	[57420, ARROW_CODEPOINTS.down],
	[57421, FUNCTIONAL_CODEPOINTS.pageUp],
	[57422, FUNCTIONAL_CODEPOINTS.pageDown],
	[57423, FUNCTIONAL_CODEPOINTS.home],
	[57424, FUNCTIONAL_CODEPOINTS.end],
	[57425, FUNCTIONAL_CODEPOINTS.insert],
	[57426, FUNCTIONAL_CODEPOINTS.delete],
]);

function normalizeKittyFunctionalCodepoint(codepoint: number): number {
	return KITTY_FUNCTIONAL_KEY_EQUIVALENTS.get(codepoint) ?? codepoint;
}

function normalizeShiftedLetterIdentityCodepoint(codepoint: number, modifier: number): number {
	const effectiveModifier = modifier & ~LOCK_MASK;
	if ((effectiveModifier & MODIFIERS.shift) !== 0 && codepoint >= 65 && codepoint <= 90) {
		return codepoint + 32;
	}
	return codepoint;
}

function getLogicalShiftedSymbolCandidate(
	codepoint: number | undefined,
	modifier: number,
	allowedSymbols: ReadonlySet<string>,
): { codepoint: number; modifier: number } | undefined {
	if (codepoint === undefined || (modifier & MODIFIERS.shift) === 0) return undefined;
	const normalizedCodepoint = normalizeKittyFunctionalCodepoint(codepoint);
	if (!allowedSymbols.has(String.fromCharCode(normalizedCodepoint))) return undefined;
	return { codepoint: normalizedCodepoint, modifier: modifier & ~MODIFIERS.shift };
}

const LEGACY_KEY_SEQUENCES = {
	up: ["\x1b[A", "\x1bOA"],
	down: ["\x1b[B", "\x1bOB"],
	right: ["\x1b[C", "\x1bOC"],
	left: ["\x1b[D", "\x1bOD"],
	home: ["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"],
	end: ["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"],
	insert: ["\x1b[2~"],
	delete: ["\x1b[3~"],
	pageUp: ["\x1b[5~", "\x1b[[5~"],
	pageDown: ["\x1b[6~", "\x1b[[6~"],
	clear: ["\x1b[E", "\x1bOE"],
	f1: ["\x1bOP", "\x1b[11~", "\x1b[[A"],
	f2: ["\x1bOQ", "\x1b[12~", "\x1b[[B"],
	f3: ["\x1bOR", "\x1b[13~", "\x1b[[C"],
	f4: ["\x1bOS", "\x1b[14~", "\x1b[[D"],
	f5: ["\x1b[15~", "\x1b[[E"],
	f6: ["\x1b[17~"],
	f7: ["\x1b[18~"],
	f8: ["\x1b[19~"],
	f9: ["\x1b[20~"],
	f10: ["\x1b[21~"],
	f11: ["\x1b[23~"],
	f12: ["\x1b[24~"],
} as const;

const LEGACY_SHIFT_SEQUENCES = {
	up: ["\x1b[a"],
	down: ["\x1b[b"],
	right: ["\x1b[c"],
	left: ["\x1b[d"],
	clear: ["\x1b[e"],
	insert: ["\x1b[2$"],
	delete: ["\x1b[3$"],
	pageUp: ["\x1b[5$"],
	pageDown: ["\x1b[6$"],
	home: ["\x1b[7$"],
	end: ["\x1b[8$"],
} as const;

const LEGACY_CTRL_SEQUENCES = {
	up: ["\x1bOa"],
	down: ["\x1bOb"],
	right: ["\x1bOc"],
	left: ["\x1bOd"],
	clear: ["\x1bOe"],
	insert: ["\x1b[2^"],
	delete: ["\x1b[3^"],
	pageUp: ["\x1b[5^"],
	pageDown: ["\x1b[6^"],
	home: ["\x1b[7^"],
	end: ["\x1b[8^"],
} as const;

const LEGACY_SEQUENCE_KEY_IDS: ReadonlyMap<string, KeyId> = new Map<string, KeyId>([
	["\x1bOA", "up"],
	["\x1bOB", "down"],
	["\x1bOC", "right"],
	["\x1bOD", "left"],
	["\x1bOH", "home"],
	["\x1bOF", "end"],
	["\x1b[E", "clear"],
	["\x1bOE", "clear"],
	["\x1bOe", "ctrl+clear"],
	["\x1b[e", "shift+clear"],
	["\x1b[2~", "insert"],
	["\x1b[2$", "shift+insert"],
	["\x1b[2^", "ctrl+insert"],
	["\x1b[3$", "shift+delete"],
	["\x1b[3^", "ctrl+delete"],
	["\x1b[[5~", "pageUp"],
	["\x1b[[6~", "pageDown"],
	["\x1b[a", "shift+up"],
	["\x1b[b", "shift+down"],
	["\x1b[c", "shift+right"],
	["\x1b[d", "shift+left"],
	["\x1bOa", "ctrl+up"],
	["\x1bOb", "ctrl+down"],
	["\x1bOc", "ctrl+right"],
	["\x1bOd", "ctrl+left"],
	["\x1b[5$", "shift+pageUp"],
	["\x1b[6$", "shift+pageDown"],
	["\x1b[7$", "shift+home"],
	["\x1b[8$", "shift+end"],
	["\x1b[5^", "ctrl+pageUp"],
	["\x1b[6^", "ctrl+pageDown"],
	["\x1b[7^", "ctrl+home"],
	["\x1b[8^", "ctrl+end"],
	["\x1bOP", "f1"],
	["\x1bOQ", "f2"],
	["\x1bOR", "f3"],
	["\x1bOS", "f4"],
	["\x1b[11~", "f1"],
	["\x1b[12~", "f2"],
	["\x1b[13~", "f3"],
	["\x1b[14~", "f4"],
	["\x1b[[A", "f1"],
	["\x1b[[B", "f2"],
	["\x1b[[C", "f3"],
	["\x1b[[D", "f4"],
	["\x1b[[E", "f5"],
	["\x1b[15~", "f5"],
	["\x1b[17~", "f6"],
	["\x1b[18~", "f7"],
	["\x1b[19~", "f8"],
	["\x1b[20~", "f9"],
	["\x1b[21~", "f10"],
	["\x1b[23~", "f11"],
	["\x1b[24~", "f12"],
	["\x1bb", "alt+left"],
	["\x1bf", "alt+right"],
	["\x1bp", "alt+up"],
	["\x1bn", "alt+down"],
]);

type LegacyModifierKey = keyof typeof LEGACY_SHIFT_SEQUENCES;

const matchesLegacySequence = (data: string, sequences: readonly string[]): boolean => sequences.includes(data);

const matchesLegacyModifierSequence = (data: string, key: LegacyModifierKey, modifier: number): boolean => {
	if (modifier === MODIFIERS.shift) {
		return matchesLegacySequence(data, LEGACY_SHIFT_SEQUENCES[key]);
	}
	if (modifier === MODIFIERS.ctrl) {
		return matchesLegacySequence(data, LEGACY_CTRL_SEQUENCES[key]);
	}
	return false;
};

export type KeyEventType = "press" | "repeat" | "release";

interface ParsedKittySequence {
	codepoint: number;
	shiftedKey?: number;
	baseLayoutKey?: number;
	modifier: number;
	eventType: KeyEventType;
}

interface ParsedModifyOtherKeysSequence {
	codepoint: number;
	modifier: number;
}

export function isKeyRelease(data: string): boolean {
	if (data.includes("\x1b[200~")) {
		return false;
	}

	if (
		data.includes(":3u") ||
		data.includes(":3~") ||
		data.includes(":3A") ||
		data.includes(":3B") ||
		data.includes(":3C") ||
		data.includes(":3D") ||
		data.includes(":3H") ||
		data.includes(":3F") ||
		data.includes(":3P") ||
		data.includes(":3Q") ||
		data.includes(":3S")
	) {
		return true;
	}
	return false;
}

export function isKeyRepeat(data: string): boolean {
	if (data.includes("\x1b[200~")) {
		return false;
	}

	if (
		data.includes(":2u") ||
		data.includes(":2~") ||
		data.includes(":2A") ||
		data.includes(":2B") ||
		data.includes(":2C") ||
		data.includes(":2D") ||
		data.includes(":2H") ||
		data.includes(":2F") ||
		data.includes(":2P") ||
		data.includes(":2Q") ||
		data.includes(":2S")
	) {
		return true;
	}
	return false;
}

function parseEventType(eventTypeStr: string | undefined): KeyEventType {
	if (!eventTypeStr) return "press";
	const eventType = parseInt(eventTypeStr, 10);
	if (eventType === 2) return "repeat";
	if (eventType === 3) return "release";
	return "press";
}

function parseKittySequence(data: string): ParsedKittySequence | null {
	const csiUMatch = data.match(/^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/);
	if (csiUMatch) {
		const codepoint = parseInt(csiUMatch[1]!, 10);
		const shiftedKey = csiUMatch[2] && csiUMatch[2].length > 0 ? parseInt(csiUMatch[2], 10) : undefined;
		const baseLayoutKey = csiUMatch[3] ? parseInt(csiUMatch[3], 10) : undefined;
		const modValue = csiUMatch[4] ? parseInt(csiUMatch[4], 10) : 1;
		const eventType = parseEventType(csiUMatch[5]);
		return { codepoint, shiftedKey, baseLayoutKey, modifier: modValue - 1, eventType };
	}

	const arrowMatch = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([ABCD])$/);
	if (arrowMatch) {
		const modValue = parseInt(arrowMatch[1]!, 10);
		const eventType = parseEventType(arrowMatch[2]);
		const arrowCodes: Record<string, number> = { A: -1, B: -2, C: -3, D: -4 };
		return { codepoint: arrowCodes[arrowMatch[3]!]!, modifier: modValue - 1, eventType };
	}

	const funcMatch = data.match(/^\x1b\[(\d+)(?:;(\d+))?(?::(\d+))?~$/);
	if (funcMatch) {
		const keyNum = parseInt(funcMatch[1]!, 10);
		const modValue = funcMatch[2] ? parseInt(funcMatch[2], 10) : 1;
		const eventType = parseEventType(funcMatch[3]);
		const funcCodes: Record<number, number> = {
			2: FUNCTIONAL_CODEPOINTS.insert,
			3: FUNCTIONAL_CODEPOINTS.delete,
			5: FUNCTIONAL_CODEPOINTS.pageUp,
			6: FUNCTIONAL_CODEPOINTS.pageDown,
			7: FUNCTIONAL_CODEPOINTS.home,
			8: FUNCTIONAL_CODEPOINTS.end,
			11: FUNCTIONAL_CODEPOINTS.f1,
			12: FUNCTIONAL_CODEPOINTS.f2,
			13: FUNCTIONAL_CODEPOINTS.f3,
			14: FUNCTIONAL_CODEPOINTS.f4,
			15: FUNCTIONAL_CODEPOINTS.f5,
			17: FUNCTIONAL_CODEPOINTS.f6,
			18: FUNCTIONAL_CODEPOINTS.f7,
			19: FUNCTIONAL_CODEPOINTS.f8,
			20: FUNCTIONAL_CODEPOINTS.f9,
			21: FUNCTIONAL_CODEPOINTS.f10,
			23: FUNCTIONAL_CODEPOINTS.f11,
			24: FUNCTIONAL_CODEPOINTS.f12,
		};
		const codepoint = funcCodes[keyNum];
		if (codepoint !== undefined) {
			return { codepoint, modifier: modValue - 1, eventType };
		}
	}

	const homeEndMatch = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([HF])$/);
	if (homeEndMatch) {
		const modValue = parseInt(homeEndMatch[1]!, 10);
		const eventType = parseEventType(homeEndMatch[2]);
		const codepoint = homeEndMatch[3] === "H" ? FUNCTIONAL_CODEPOINTS.home : FUNCTIONAL_CODEPOINTS.end;
		return { codepoint, modifier: modValue - 1, eventType };
	}

	const fKeyMatch = data.match(/^\x1b\[(?:1;(\d+)(?::(\d+))?)?([PQS])$/);
	if (fKeyMatch) {
		const modValue = fKeyMatch[1] ? parseInt(fKeyMatch[1], 10) : 1;
		const eventType = parseEventType(fKeyMatch[2]);
		const fKeyCodes: Record<string, number> = {
			P: FUNCTIONAL_CODEPOINTS.f1,
			Q: FUNCTIONAL_CODEPOINTS.f2,
			S: FUNCTIONAL_CODEPOINTS.f4,
		};
		return { codepoint: fKeyCodes[fKeyMatch[3]!]!, modifier: modValue - 1, eventType };
	}

	return null;
}

function matchesKittySequence(data: string, expectedCodepoint: number, expectedModifier: number): boolean {
	const parsed = parseKittySequence(data);
	if (!parsed) return false;
	const actualMod = parsed.modifier & ~LOCK_MASK;
	const expectedMod = expectedModifier & ~LOCK_MASK;

	const normalizedCodepoint = normalizeShiftedLetterIdentityCodepoint(
		normalizeKittyFunctionalCodepoint(parsed.codepoint),
		parsed.modifier,
	);
	const normalizedExpectedCodepoint = normalizeShiftedLetterIdentityCodepoint(
		normalizeKittyFunctionalCodepoint(expectedCodepoint),
		expectedModifier,
	);

	if (actualMod === expectedMod && normalizedCodepoint === normalizedExpectedCodepoint) return true;

	const logicalShiftedSymbol = getLogicalShiftedSymbolCandidate(parsed.shiftedKey, actualMod, SYMBOL_KEYS);
	if (
		logicalShiftedSymbol &&
		(logicalShiftedSymbol.modifier & ~LOCK_MASK) === expectedMod &&
		logicalShiftedSymbol.codepoint === normalizeKittyFunctionalCodepoint(expectedCodepoint)
	) {
		return true;
	}

	if (actualMod !== expectedMod) return false;

	if (parsed.baseLayoutKey !== undefined && parsed.baseLayoutKey === expectedCodepoint) {
		const cp = normalizedCodepoint;
		const isLatinLetter = cp >= 97 && cp <= 122;
		const isKnownSymbol = SYMBOL_KEYS.has(String.fromCharCode(cp));
		if (!isLatinLetter && !isKnownSymbol) return true;
	}

	return false;
}

function parseModifyOtherKeysSequence(data: string): ParsedModifyOtherKeysSequence | null {
	const match = data.match(/^\x1b\[27;(\d+);(\d+)~$/);
	if (!match) return null;
	const modValue = parseInt(match[1]!, 10);
	const codepoint = parseInt(match[2]!, 10);
	return { codepoint, modifier: modValue - 1 };
}

function matchesModifyOtherKeys(data: string, expectedKeycode: number, expectedModifier: number): boolean {
	const parsed = parseModifyOtherKeysSequence(data);
	if (!parsed) return false;
	return parsed.codepoint === expectedKeycode && parsed.modifier === expectedModifier;
}

export function isWindowsTerminalSession(env: Record<string, string | undefined>): boolean {
	return Boolean(env.WT_SESSION) && !env.SSH_CONNECTION && !env.SSH_CLIENT && !env.SSH_TTY;
}

function matchesRawBackspace(data: string, expectedModifier: number, mode: KeyboardMode): boolean {
	if (data === "\x7f") return expectedModifier === 0;
	if (data !== "\x08") return false;
	return mode.windowsTerminalSession ? expectedModifier === MODIFIERS.ctrl : expectedModifier === 0;
}

function rawCtrlChar(key: string): string | null {
	const char = key.toLowerCase();
	const code = char.charCodeAt(0);
	if ((code >= 97 && code <= 122) || char === "[" || char === "\\" || char === "]" || char === "_") {
		return String.fromCharCode(code & 0x1f);
	}
	if (char === "-") {
		return String.fromCharCode(31);
	}
	return null;
}

function isDigitKey(key: string): boolean {
	return key >= "0" && key <= "9";
}

function matchesPrintableModifyOtherKeys(data: string, expectedKeycode: number, expectedModifier: number): boolean {
	const parsed = parseModifyOtherKeysSequence(data);
	if (!parsed) return false;
	const physicalMatch =
		parsed.modifier === expectedModifier &&
		normalizeShiftedLetterIdentityCodepoint(parsed.codepoint, parsed.modifier) ===
			normalizeShiftedLetterIdentityCodepoint(expectedKeycode, expectedModifier);
	if (physicalMatch) return true;
	const logicalShiftedSymbol = getLogicalShiftedSymbolCandidate(
		parsed.codepoint,
		parsed.modifier,
		SHIFTED_SYMBOL_KEYS,
	);
	return logicalShiftedSymbol?.modifier === expectedModifier && logicalShiftedSymbol.codepoint === expectedKeycode;
}

function formatKeyNameWithModifiers(keyName: string, modifier: number): string | undefined {
	const mods: string[] = [];
	const effectiveMod = modifier & ~LOCK_MASK;
	const supportedModifierMask = MODIFIERS.shift | MODIFIERS.ctrl | MODIFIERS.alt | MODIFIERS.super;
	if ((effectiveMod & ~supportedModifierMask) !== 0) return undefined;
	if (effectiveMod & MODIFIERS.shift) mods.push("shift");
	if (effectiveMod & MODIFIERS.ctrl) mods.push("ctrl");
	if (effectiveMod & MODIFIERS.alt) mods.push("alt");
	if (effectiveMod & MODIFIERS.super) mods.push("super");
	return mods.length > 0 ? `${mods.join("+")}+${keyName}` : keyName;
}

function parseKeyId(
	keyId: string,
): { key: string; ctrl: boolean; shift: boolean; alt: boolean; super: boolean } | null {
	let key = keyId.toLowerCase();
	const modifiers = new Set<(typeof MODIFIER_NAMES)[number]>();
	while (true) {
		const modifier = MODIFIER_NAMES.find((name) => key.startsWith(`${name}+`));
		if (!modifier) break;
		if (modifiers.has(modifier)) return null;
		modifiers.add(modifier);
		key = key.slice(modifier.length + 1);
	}
	if (!key || (key.includes("+") && key !== "+")) return null;
	return {
		key,
		ctrl: modifiers.has("ctrl"),
		shift: modifiers.has("shift"),
		alt: modifiers.has("alt"),
		super: modifiers.has("super"),
	};
}

function matchesEscapeKey(data: string, modifier: number): boolean {
	if (modifier !== 0) return false;
	return (
		data === "\x1b" ||
		matchesKittySequence(data, CODEPOINTS.escape, 0) ||
		matchesModifyOtherKeys(data, CODEPOINTS.escape, 0)
	);
}

function matchesSpaceKey(data: string, modifier: number, mode: KeyboardMode): boolean {
	if (!mode.kittyProtocolActive) {
		if (modifier === MODIFIERS.ctrl && data === "\x00") {
			return true;
		}
		if (modifier === MODIFIERS.alt && data === "\x1b ") {
			return true;
		}
	}
	if (modifier === 0) {
		return (
			data === " " ||
			matchesKittySequence(data, CODEPOINTS.space, 0) ||
			matchesModifyOtherKeys(data, CODEPOINTS.space, 0)
		);
	}
	return (
		matchesKittySequence(data, CODEPOINTS.space, modifier) ||
		matchesModifyOtherKeys(data, CODEPOINTS.space, modifier)
	);
}

function matchesTabKey(data: string, modifier: number): boolean {
	if (modifier === MODIFIERS.shift) {
		return (
			data === "\x1b[Z" ||
			matchesKittySequence(data, CODEPOINTS.tab, MODIFIERS.shift) ||
			matchesModifyOtherKeys(data, CODEPOINTS.tab, MODIFIERS.shift)
		);
	}
	if (modifier === 0) {
		return data === "\t" || matchesKittySequence(data, CODEPOINTS.tab, 0);
	}
	return (
		matchesKittySequence(data, CODEPOINTS.tab, modifier) ||
		matchesModifyOtherKeys(data, CODEPOINTS.tab, modifier)
	);
}

function matchesEnterKey(data: string, modifier: number, mode: KeyboardMode): boolean {
	if (modifier === MODIFIERS.shift) {
		if (
			matchesKittySequence(data, CODEPOINTS.enter, MODIFIERS.shift) ||
			matchesKittySequence(data, CODEPOINTS.kpEnter, MODIFIERS.shift)
		) {
			return true;
		}
		if (matchesModifyOtherKeys(data, CODEPOINTS.enter, MODIFIERS.shift)) {
			return true;
		}
		if (mode.kittyProtocolActive) {
			return data === "\x1b\r" || data === "\n";
		}
		return false;
	}
	if (modifier === MODIFIERS.alt) {
		if (
			matchesKittySequence(data, CODEPOINTS.enter, MODIFIERS.alt) ||
			matchesKittySequence(data, CODEPOINTS.kpEnter, MODIFIERS.alt)
		) {
			return true;
		}
		if (matchesModifyOtherKeys(data, CODEPOINTS.enter, MODIFIERS.alt)) {
			return true;
		}
		if (!mode.kittyProtocolActive) {
			return data === "\x1b\r";
		}
		return false;
	}
	if (modifier === 0) {
		return (
			data === "\r" ||
			(!mode.kittyProtocolActive && data === "\n") ||
			data === "\x1bOM" ||
			matchesKittySequence(data, CODEPOINTS.enter, 0) ||
			matchesKittySequence(data, CODEPOINTS.kpEnter, 0)
		);
	}
	return (
		matchesKittySequence(data, CODEPOINTS.enter, modifier) ||
		matchesKittySequence(data, CODEPOINTS.kpEnter, modifier) ||
		matchesModifyOtherKeys(data, CODEPOINTS.enter, modifier)
	);
}

function matchesBackspaceKey(data: string, modifier: number, mode: KeyboardMode): boolean {
	if (modifier === MODIFIERS.alt) {
		if (data === "\x1b\x7f" || data === "\x1b\b") {
			return true;
		}
		return (
			matchesKittySequence(data, CODEPOINTS.backspace, MODIFIERS.alt) ||
			matchesModifyOtherKeys(data, CODEPOINTS.backspace, MODIFIERS.alt)
		);
	}
	if (modifier === MODIFIERS.ctrl) {
		if (matchesRawBackspace(data, MODIFIERS.ctrl, mode)) return true;
		return (
			matchesKittySequence(data, CODEPOINTS.backspace, MODIFIERS.ctrl) ||
			matchesModifyOtherKeys(data, CODEPOINTS.backspace, MODIFIERS.ctrl)
		);
	}
	if (modifier === 0) {
		return (
			matchesRawBackspace(data, 0, mode) ||
			matchesKittySequence(data, CODEPOINTS.backspace, 0) ||
			matchesModifyOtherKeys(data, CODEPOINTS.backspace, 0)
		);
	}
	return (
		matchesKittySequence(data, CODEPOINTS.backspace, modifier) ||
		matchesModifyOtherKeys(data, CODEPOINTS.backspace, modifier)
	);
}

type NavigationKey = "insert" | "delete" | "home" | "end" | "pageUp" | "pageDown";

function matchesNavigationKey(data: string, key: NavigationKey, modifier: number): boolean {
	if (modifier === 0) {
		return (
			matchesLegacySequence(data, LEGACY_KEY_SEQUENCES[key]) ||
			matchesKittySequence(data, FUNCTIONAL_CODEPOINTS[key], 0)
		);
	}
	if (matchesLegacyModifierSequence(data, key, modifier)) {
		return true;
	}
	return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS[key], modifier);
}

function matchesClearKey(data: string, modifier: number): boolean {
	if (modifier === 0) {
		return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.clear);
	}
	return matchesLegacyModifierSequence(data, "clear", modifier);
}

function matchesUpKey(data: string, modifier: number): boolean {
	if (modifier === MODIFIERS.alt) {
		return data === "\x1bp" || matchesKittySequence(data, ARROW_CODEPOINTS.up, MODIFIERS.alt);
	}
	if (modifier === 0) {
		return (
			matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.up) ||
			matchesKittySequence(data, ARROW_CODEPOINTS.up, 0)
		);
	}
	if (matchesLegacyModifierSequence(data, "up", modifier)) {
		return true;
	}
	return matchesKittySequence(data, ARROW_CODEPOINTS.up, modifier);
}

function matchesDownKey(data: string, modifier: number): boolean {
	if (modifier === MODIFIERS.alt) {
		return data === "\x1bn" || matchesKittySequence(data, ARROW_CODEPOINTS.down, MODIFIERS.alt);
	}
	if (modifier === 0) {
		return (
			matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.down) ||
			matchesKittySequence(data, ARROW_CODEPOINTS.down, 0)
		);
	}
	if (matchesLegacyModifierSequence(data, "down", modifier)) {
		return true;
	}
	return matchesKittySequence(data, ARROW_CODEPOINTS.down, modifier);
}

function matchesLeftKey(data: string, modifier: number, mode: KeyboardMode): boolean {
	if (modifier === MODIFIERS.alt) {
		return (
			data === "\x1b[1;3D" ||
			(!mode.kittyProtocolActive && data === "\x1bB") ||
			data === "\x1bb" ||
			matchesKittySequence(data, ARROW_CODEPOINTS.left, MODIFIERS.alt)
		);
	}
	if (modifier === MODIFIERS.ctrl) {
		return (
			data === "\x1b[1;5D" ||
			matchesLegacyModifierSequence(data, "left", MODIFIERS.ctrl) ||
			matchesKittySequence(data, ARROW_CODEPOINTS.left, MODIFIERS.ctrl)
		);
	}
	if (modifier === 0) {
		return (
			matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.left) ||
			matchesKittySequence(data, ARROW_CODEPOINTS.left, 0)
		);
	}
	if (matchesLegacyModifierSequence(data, "left", modifier)) {
		return true;
	}
	return matchesKittySequence(data, ARROW_CODEPOINTS.left, modifier);
}

function matchesRightKey(data: string, modifier: number, mode: KeyboardMode): boolean {
	if (modifier === MODIFIERS.alt) {
		return (
			data === "\x1b[1;3C" ||
			(!mode.kittyProtocolActive && data === "\x1bF") ||
			data === "\x1bf" ||
			matchesKittySequence(data, ARROW_CODEPOINTS.right, MODIFIERS.alt)
		);
	}
	if (modifier === MODIFIERS.ctrl) {
		return (
			data === "\x1b[1;5C" ||
			matchesLegacyModifierSequence(data, "right", MODIFIERS.ctrl) ||
			matchesKittySequence(data, ARROW_CODEPOINTS.right, MODIFIERS.ctrl)
		);
	}
	if (modifier === 0) {
		return (
			matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.right) ||
			matchesKittySequence(data, ARROW_CODEPOINTS.right, 0)
		);
	}
	if (matchesLegacyModifierSequence(data, "right", modifier)) {
		return true;
	}
	return matchesKittySequence(data, ARROW_CODEPOINTS.right, modifier);
}

type FunctionKey = "f1" | "f2" | "f3" | "f4" | "f5" | "f6" | "f7" | "f8" | "f9" | "f10" | "f11" | "f12";

function matchesFunctionKey(data: string, key: FunctionKey, modifier: number): boolean {
	if (modifier === 0 && matchesLegacySequence(data, LEGACY_KEY_SEQUENCES[key])) {
		return true;
	}
	return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS[key], modifier);
}

function matchesPrintableKey(data: string, key: string, modifier: number, mode: KeyboardMode): boolean {
	const codepoint = key.charCodeAt(0);
	const rawCtrl = rawCtrlChar(key);
	const isLetter = key >= "a" && key <= "z";
	const isDigit = isDigitKey(key);

	if (modifier === MODIFIERS.ctrl + MODIFIERS.alt && !mode.kittyProtocolActive && rawCtrl) {
		if (data === `\x1b${rawCtrl}`) return true;
	}

	if (modifier === MODIFIERS.alt && !mode.kittyProtocolActive && (isLetter || isDigit || SYMBOL_KEYS.has(key))) {
		if (data === `\x1b${key}`) return true;
	}

	if (modifier === MODIFIERS.ctrl) {
		if (rawCtrl && data === rawCtrl) return true;
		return (
			matchesKittySequence(data, codepoint, MODIFIERS.ctrl) ||
			matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.ctrl)
		);
	}

	if (modifier === MODIFIERS.shift + MODIFIERS.ctrl) {
		return (
			matchesKittySequence(data, codepoint, MODIFIERS.shift + MODIFIERS.ctrl) ||
			matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.shift + MODIFIERS.ctrl)
		);
	}

	if (modifier === MODIFIERS.shift) {
		if (isLetter && data === key.toUpperCase()) return true;
		return (
			matchesKittySequence(data, codepoint, MODIFIERS.shift) ||
			matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.shift)
		);
	}

	if (modifier !== 0) {
		return (
			matchesKittySequence(data, codepoint, modifier) ||
			matchesPrintableModifyOtherKeys(data, codepoint, modifier)
		);
	}

	return (
		data === key || matchesKittySequence(data, codepoint, 0) || matchesPrintableModifyOtherKeys(data, codepoint, 0)
	);
}

export function matchesKey(data: string, keyId: KeyId, mode: KeyboardMode): boolean {
	const parsed = parseKeyId(keyId);
	if (!parsed) return false;

	const { key, ctrl, shift, alt, super: superModifier } = parsed;
	let modifier = 0;
	if (shift) modifier |= MODIFIERS.shift;
	if (alt) modifier |= MODIFIERS.alt;
	if (ctrl) modifier |= MODIFIERS.ctrl;
	if (superModifier) modifier |= MODIFIERS.super;

	switch (key) {
		case "escape":
		case "esc":
			return matchesEscapeKey(data, modifier);

		case "space":
			return matchesSpaceKey(data, modifier, mode);

		case "tab":
			return matchesTabKey(data, modifier);

		case "enter":
		case "return":
			return matchesEnterKey(data, modifier, mode);

		case "backspace":
			return matchesBackspaceKey(data, modifier, mode);

		case "insert":
		case "delete":
		case "home":
		case "end":
			return matchesNavigationKey(data, key, modifier);

		case "pageup":
			return matchesNavigationKey(data, "pageUp", modifier);

		case "pagedown":
			return matchesNavigationKey(data, "pageDown", modifier);

		case "clear":
			return matchesClearKey(data, modifier);

		case "up":
			return matchesUpKey(data, modifier);

		case "down":
			return matchesDownKey(data, modifier);

		case "left":
			return matchesLeftKey(data, modifier, mode);

		case "right":
			return matchesRightKey(data, modifier, mode);

		case "f1":
		case "f2":
		case "f3":
		case "f4":
		case "f5":
		case "f6":
		case "f7":
		case "f8":
		case "f9":
		case "f10":
		case "f11":
		case "f12":
			return matchesFunctionKey(data, key, modifier);
	}

	if (key.length === 1 && ((key >= "a" && key <= "z") || isDigitKey(key) || SYMBOL_KEYS.has(key))) {
		return matchesPrintableKey(data, key, modifier, mode);
	}

	return false;
}

function formatParsedKey(codepoint: number, modifier: number, baseLayoutKey?: number): string | undefined {
	const normalizedCodepoint = normalizeKittyFunctionalCodepoint(codepoint);
	const identityCodepoint = normalizeShiftedLetterIdentityCodepoint(normalizedCodepoint, modifier);

	const isLatinLetter = identityCodepoint >= 97 && identityCodepoint <= 122;
	const isDigit = identityCodepoint >= 48 && identityCodepoint <= 57;
	const isKnownSymbol = SYMBOL_KEYS.has(String.fromCharCode(identityCodepoint));
	const effectiveCodepoint =
		isLatinLetter || isDigit || isKnownSymbol ? identityCodepoint : (baseLayoutKey ?? identityCodepoint);

	let keyName: string | undefined;
	if (effectiveCodepoint === CODEPOINTS.escape) keyName = "escape";
	else if (effectiveCodepoint === CODEPOINTS.tab) keyName = "tab";
	else if (effectiveCodepoint === CODEPOINTS.enter || effectiveCodepoint === CODEPOINTS.kpEnter) keyName = "enter";
	else if (effectiveCodepoint === CODEPOINTS.space) keyName = "space";
	else if (effectiveCodepoint === CODEPOINTS.backspace) keyName = "backspace";
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.delete) keyName = "delete";
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.insert) keyName = "insert";
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.home) keyName = "home";
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.end) keyName = "end";
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.pageUp) keyName = "pageUp";
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.pageDown) keyName = "pageDown";
	else if (effectiveCodepoint <= FUNCTIONAL_CODEPOINTS.f1 && effectiveCodepoint >= FUNCTIONAL_CODEPOINTS.f12)
		keyName = `f${FUNCTIONAL_CODEPOINTS.f1 - effectiveCodepoint + 1}`;
	else if (effectiveCodepoint === ARROW_CODEPOINTS.up) keyName = "up";
	else if (effectiveCodepoint === ARROW_CODEPOINTS.down) keyName = "down";
	else if (effectiveCodepoint === ARROW_CODEPOINTS.left) keyName = "left";
	else if (effectiveCodepoint === ARROW_CODEPOINTS.right) keyName = "right";
	else if (effectiveCodepoint >= 48 && effectiveCodepoint <= 57) keyName = String.fromCharCode(effectiveCodepoint);
	else if (effectiveCodepoint >= 97 && effectiveCodepoint <= 122) keyName = String.fromCharCode(effectiveCodepoint);
	else if (SYMBOL_KEYS.has(String.fromCharCode(effectiveCodepoint))) keyName = String.fromCharCode(effectiveCodepoint);

	if (!keyName) return undefined;
	return formatKeyNameWithModifiers(keyName, modifier);
}

export function parseKey(data: string, mode: KeyboardMode): string | undefined {
	const kitty = parseKittySequence(data);
	if (kitty) {
		const logicalShiftedSymbol = getLogicalShiftedSymbolCandidate(kitty.shiftedKey, kitty.modifier, SYMBOL_KEYS);
		return formatParsedKey(
			logicalShiftedSymbol?.codepoint ?? kitty.codepoint,
			logicalShiftedSymbol?.modifier ?? kitty.modifier,
			kitty.baseLayoutKey,
		);
	}

	const modifyOtherKeys = parseModifyOtherKeysSequence(data);
	if (modifyOtherKeys) {
		const logicalShiftedSymbol = getLogicalShiftedSymbolCandidate(
			modifyOtherKeys.codepoint,
			modifyOtherKeys.modifier,
			SHIFTED_SYMBOL_KEYS,
		);
		return formatParsedKey(
			logicalShiftedSymbol?.codepoint ?? modifyOtherKeys.codepoint,
			logicalShiftedSymbol?.modifier ?? modifyOtherKeys.modifier,
		);
	}

	if (mode.kittyProtocolActive) {
		if (data === "\x1b\r" || data === "\n") return "shift+enter";
	}

	const legacySequenceKeyId = LEGACY_SEQUENCE_KEY_IDS.get(data);
	if (legacySequenceKeyId) return legacySequenceKeyId;

	if (data === "\x1b") return "escape";
	if (data === "\x1c") return "ctrl+\\";
	if (data === "\x1d") return "ctrl+]";
	if (data === "\x1f") return "ctrl+-";
	if (data === "\x1b\x1b") return "ctrl+alt+[";
	if (data === "\x1b\x1c") return "ctrl+alt+\\";
	if (data === "\x1b\x1d") return "ctrl+alt+]";
	if (data === "\x1b\x1f") return "ctrl+alt+-";
	if (data === "\t") return "tab";
	if (data === "\r" || (!mode.kittyProtocolActive && data === "\n") || data === "\x1bOM") return "enter";
	if (data === "\x00") return "ctrl+space";
	if (data === " ") return "space";
	if (data === "\x7f") return "backspace";
	if (data === "\x08") return mode.windowsTerminalSession ? "ctrl+backspace" : "backspace";
	if (data === "\x1b[Z") return "shift+tab";
	if (!mode.kittyProtocolActive && data === "\x1b\r") return "alt+enter";
	if (!mode.kittyProtocolActive && data === "\x1b ") return "alt+space";
	if (data === "\x1b\x7f" || data === "\x1b\b") return "alt+backspace";
	if (!mode.kittyProtocolActive && data === "\x1bB") return "alt+left";
	if (!mode.kittyProtocolActive && data === "\x1bF") return "alt+right";
	if (!mode.kittyProtocolActive && data.length === 2 && data[0] === "\x1b") {
		const code = data.charCodeAt(1);
		if (code >= 1 && code <= 26) {
			return `ctrl+alt+${String.fromCharCode(code + 96)}`;
		}
		const key = String.fromCharCode(code);
		if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57) || SYMBOL_KEYS.has(key)) {
			return `alt+${key}`;
		}
	}
	if (data === "\x1b[A") return "up";
	if (data === "\x1b[B") return "down";
	if (data === "\x1b[C") return "right";
	if (data === "\x1b[D") return "left";
	if (data === "\x1b[H" || data === "\x1bOH") return "home";
	if (data === "\x1b[F" || data === "\x1bOF") return "end";
	if (data === "\x1b[3~") return "delete";
	if (data === "\x1b[5~") return "pageUp";
	if (data === "\x1b[6~") return "pageDown";

	if (data.length === 1) {
		const code = data.charCodeAt(0);
		if (code >= 1 && code <= 26) {
			return `ctrl+${String.fromCharCode(code + 96)}`;
		}
		if (code >= 32 && code <= 126) {
			return data;
		}
	}

	return undefined;
}

const KITTY_CSI_U_REGEX = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;
const KITTY_PRINTABLE_ALLOWED_MODIFIERS = MODIFIERS.shift | LOCK_MASK;

export function decodeKittyPrintable(data: string): string | undefined {
	const match = data.match(KITTY_CSI_U_REGEX);
	if (!match) return undefined;

	const codepoint = Number.parseInt(match[1] ?? "", 10);
	if (!Number.isFinite(codepoint)) return undefined;

	const shiftedKey = match[2] && match[2].length > 0 ? Number.parseInt(match[2], 10) : undefined;
	const modValue = match[4] ? Number.parseInt(match[4], 10) : 1;
	const modifier = Number.isFinite(modValue) ? modValue - 1 : 0;

	if ((modifier & ~KITTY_PRINTABLE_ALLOWED_MODIFIERS) !== 0) return undefined;
	if (modifier & (MODIFIERS.alt | MODIFIERS.ctrl)) return undefined;

	let effectiveCodepoint = codepoint;
	if (modifier & MODIFIERS.shift && typeof shiftedKey === "number") {
		effectiveCodepoint = shiftedKey;
	}
	effectiveCodepoint = normalizeKittyFunctionalCodepoint(effectiveCodepoint);
	if (!Number.isFinite(effectiveCodepoint) || effectiveCodepoint < 32) return undefined;
	if (effectiveCodepoint >= KITTY_FUNCTIONAL_PUA_START && effectiveCodepoint <= KITTY_FUNCTIONAL_PUA_END) {
		return undefined;
	}
	if (effectiveCodepoint > MAX_CODEPOINT) return undefined;

	return String.fromCodePoint(effectiveCodepoint);
}

function decodeModifyOtherKeysPrintable(data: string): string | undefined {
	const parsed = parseModifyOtherKeysSequence(data);
	if (!parsed) return undefined;
	const modifier = parsed.modifier & ~LOCK_MASK;
	if ((modifier & ~MODIFIERS.shift) !== 0) return undefined;
	if (!Number.isFinite(parsed.codepoint) || parsed.codepoint < 32) return undefined;
	if (parsed.codepoint > MAX_CODEPOINT) return undefined;

	return String.fromCodePoint(parsed.codepoint);
}

export function decodePrintableKey(data: string): string | undefined {
	return decodeKittyPrintable(data) ?? decodeModifyOtherKeysPrintable(data);
}
