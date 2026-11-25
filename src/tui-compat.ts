/**
 * Self-contained TUI compatibility primitives for context-forge.
 *
 * omp v19.2+ removed the upstream `@earendil-works/pi-tui` / `@mariozechner/pi-tui`
 * component package and rejects extensions importing it at load time. Instead,
 * extensions may return plain rows objects `{ render(width): string[], handleInput?(data), invalidate() }`
 * from `ctx.ui.custom`, `renderCall`, `renderResult`, and custom renderers.
 *
 * This module provides lightweight, zero-dependency implementations of the
 * text-width, ANSI, keyboard, fuzzy-search, and rows-component helpers used
 * across context-forge and its vendored pi-blackhole modules, while remaining
 * structurally compatible with both omp v19.2+ (`ExtensionRows` / `ExtensionUiHost`)
 * and upstream pi test harnesses.
 */

// ── Shared Types ──────────────────────────────────────────────────────────────

export interface Component {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate(): void;
}

export interface TUI {
	requestRender(force?: boolean): void;
	/** omp v19.2+ ExtensionUiHost viewport query. */
	size?(): { readonly columns: number; readonly rows: number };
	/** Upstream pi-tui viewport query (used in legacy hosts and tests). */
	terminal?: {
		readonly columns?: number;
		readonly rows?: number;
	};
}

export interface OverlayOptions {
	width?: number | `${number}%`;
	minWidth?: number;
	maxHeight?: number | `${number}%`;
	anchor?:
		| "center"
		| "top-left"
		| "top-right"
		| "bottom-left"
		| "bottom-right"
		| "top-center"
		| "bottom-center"
		| "left-center"
		| "right-center";
	offsetX?: number;
	offsetY?: number;
	row?: number | `${number}%`;
	col?: number | `${number}%`;
	margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
	visible?: (termWidth: number, termHeight: number) => boolean;
	nonCapturing?: boolean;
}

export interface SelectItem {
	value: string;
	label: string;
	description?: string;
}

export interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
}

export interface EditorTheme {
	borderColor: (text: string) => string;
	selectList?: SelectListTheme;
}

export interface ThemeLike {
	fg(color: any, text: string): string;
	bg?(color: any, text: string): string;
	bold?(text: string): string;
	inverse?(text: string): string;
}

export interface FuzzyMatch {
	matches: boolean;
	score: number;
}

/** Read terminal row count across both omp v19.2+ (`ui.size()`) and legacy `tui.terminal.rows`. */
export function getTerminalRows(tui: TUI | undefined, fallback = 24): number {
	if (!tui) return fallback;
	if (typeof tui.size === "function") {
		try {
			const rows = tui.size()?.rows;
			if (typeof rows === "number" && Number.isFinite(rows) && rows > 0) return rows;
		} catch {
			// Fall through to legacy check.
		}
	}
	const legacyRows = tui.terminal?.rows;
	if (typeof legacyRows === "number" && Number.isFinite(legacyRows) && legacyRows > 0) {
		return legacyRows;
	}
	return fallback;
}

/** Build a SelectListTheme from the host extension theme (replaces removed `getSelectListTheme`). */
export function createSelectListTheme(theme: ThemeLike): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}

// ── ANSI & Terminal Width Helpers ─────────────────────────────────────────────

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const TAB_WIDTH = 4;
const ANSI_RESET = "\x1b[0m";

// Matches CSI, OSC (BEL or ST terminated), APC/DCS/PM/SOS (BEL or ST terminated), and 2-char ESC sequences.
const TERMINAL_SEQUENCE_RE =
	/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/** Remove ANSI, OSC, APC, and other terminal control sequences while preserving visible text. */
export function stripTerminalSequences(str: string): string {
	if (!str) return "";
	return str.replace(TERMINAL_SEQUENCE_RE, "");
}

/** Extract an ANSI/terminal escape sequence starting at `pos`, or null if none starts there. */
function extractEscapeAt(str: string, pos: number): string | null {
	if (str.charCodeAt(pos) !== 0x1b) return null;
	if (pos + 1 >= str.length) return "\x1b";
	const next = str.charCodeAt(pos + 1);
	// CSI: ESC [ ... final byte 0x40..0x7E
	if (next === 0x5b) {
		let i = pos + 2;
		while (i < str.length) {
			const c = str.charCodeAt(i);
			if (c >= 0x40 && c <= 0x7e) return str.slice(pos, i + 1);
			i++;
		}
		return str.slice(pos);
	}
	// OSC / DCS / SOS / PM / APC: terminated by BEL (\x07) or ST (\x1b\\)
	if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
		let i = pos + 2;
		while (i < str.length) {
			const c = str.charCodeAt(i);
			if (c === 0x07) return str.slice(pos, i + 1);
			if (c === 0x1b && str.charCodeAt(i + 1) === 0x5c) return str.slice(pos, i + 2);
			i++;
		}
		return str.slice(pos);
	}
	// Single 2-byte ESC sequence
	return str.slice(pos, pos + 2);
}

function isZeroWidthCodePoint(cp: number): boolean {
	return (
		cp === 0 ||
		cp === 0x200b || // ZWSP
		cp === 0x200c || // ZWNJ
		cp === 0x200d || // ZWJ
		cp === 0xfeff || // BOM
		(cp >= 0xfe00 && cp <= 0xfe0f) || // Variation selectors
		(cp >= 0xe0100 && cp <= 0xe01ef) || // Variation selectors supplement
		(cp >= 0x0300 && cp <= 0x036f) || // Combining diacritical marks
		(cp >= 0x1ab0 && cp <= 0x1aff) ||
		(cp >= 0x1dc0 && cp <= 0x1dff) ||
		(cp >= 0x20d0 && cp <= 0x20ff) ||
		(cp >= 0xfe20 && cp <= 0xfe2f) ||
		(cp >= 0x00 && cp < 0x20) ||
		(cp >= 0x7f && cp < 0xa0)
	);
}

function isFullwidthCodePoint(cp: number): boolean {
	return (
		cp >= 0x1100 &&
		(cp <= 0x115f || // Hangul Jamo init
			cp === 0x2329 ||
			cp === 0x232a ||
			(cp >= 0x2e80 && cp <= 0x3247 && cp !== 0x303f) || // CJK Radicals .. Enclosed CJK
			(cp >= 0x3250 && cp <= 0x4dbf) ||
			(cp >= 0x4e00 && cp <= 0xa4c6) || // CJK Unified Ideographs
			(cp >= 0xa960 && cp <= 0xa97c) ||
			(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
			(cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
			(cp >= 0xfe10 && cp <= 0xfe19) ||
			(cp >= 0xfe30 && cp <= 0xfe6b) ||
			(cp >= 0xff01 && cp <= 0xff60) || // Fullwidth ASCII
			(cp >= 0xffe0 && cp <= 0xffe6) ||
			(cp >= 0x1b000 && cp <= 0x1b001) ||
			(cp >= 0x1f200 && cp <= 0x1f251) ||
			(cp >= 0x20000 && cp <= 0x3fffd))
	);
}

const EMOJI_WIDE_RE = /\p{Extended_Pictographic}/u;

function graphemeWidth(segment: string): number {
	if (segment === "\t") return TAB_WIDTH;
	if (segment.length === 1) {
		const code = segment.charCodeAt(0);
		if (code >= 0x20 && code <= 0x7e) return 1;
		if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
	}
	if (EMOJI_WIDE_RE.test(segment)) {
		// Text presentation selector (U+FE0E) narrows emoji to 1 cell.
		if (segment.includes("\ufe0e")) return 1;
		return 2;
	}
	// Regional indicator pairs (flags) occupy 2 cells.
	const firstCp = segment.codePointAt(0);
	if (firstCp === undefined) return 0;
	if (firstCp >= 0x1f1e6 && firstCp <= 0x1f1ff) return 2;
	if (isZeroWidthCodePoint(firstCp)) return 0;
	if (isFullwidthCodePoint(firstCp)) return 2;
	return 1;
}

const PRINTABLE_ASCII_RE = /^[\x20-\x7e]*$/;

/** Calculate visible terminal column width of a string (ignoring ANSI escape sequences). */
export function visibleWidth(str: string): number {
	if (!str) return 0;
	if (PRINTABLE_ASCII_RE.test(str)) return str.length;
	const plain = str.includes("\x1b") ? stripTerminalSequences(str) : str;
	if (PRINTABLE_ASCII_RE.test(plain)) return plain.length;
	let width = 0;
	for (const { segment } of GRAPHEME_SEGMENTER.segment(plain)) {
		width += graphemeWidth(segment);
	}
	return width;
}

interface AnsiToken {
	readonly text: string;
	readonly isEscape: boolean;
	readonly width: number;
}

function tokenizeAnsi(text: string): AnsiToken[] {
	const tokens: AnsiToken[] = [];
	let i = 0;
	while (i < text.length) {
		if (text.charCodeAt(i) === 0x1b) {
			const esc = extractEscapeAt(text, i);
			if (esc) {
				tokens.push({ text: esc, isEscape: true, width: 0 });
				i += esc.length;
				continue;
			}
		}
		const nextEsc = text.indexOf("\x1b", i);
		const chunk = nextEsc === -1 ? text.slice(i) : text.slice(i, nextEsc);
		for (const { segment } of GRAPHEME_SEGMENTER.segment(chunk)) {
			tokens.push({ text: segment, isEscape: false, width: graphemeWidth(segment) });
		}
		i = nextEsc === -1 ? text.length : nextEsc;
	}
	return tokens;
}

function updateActiveSgr(activeSgr: string[], esc: string): void {
	// Only track CSI SGR sequences (`ESC [ ... m`) for carrying style across line breaks.
	if (!esc.startsWith("\x1b[") || !esc.endsWith("m")) return;
	const params = esc.slice(2, -1);
	if (params === "" || params === "0") {
		activeSgr.length = 0;
	} else {
		activeSgr.push(esc);
	}
}

/**
 * Truncate text to fit within `maxWidth` visible columns, preserving ANSI codes.
 * Appends `ellipsis` when truncated and optionally pads with spaces to `maxWidth`.
 */
export function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsis = "...",
	pad = false,
): string {
	const target = Math.max(0, Math.floor(maxWidth));
	if (target === 0) return "";
	const fullWidth = visibleWidth(text);
	if (fullWidth <= target) {
		return pad ? `${text}${" ".repeat(target - fullWidth)}` : text;
	}

	const ellipsisWidth = visibleWidth(ellipsis);
	if (ellipsisWidth >= target) {
		const cut = slicePlainToWidth(ellipsis, target);
		const w = visibleWidth(cut);
		return pad && w < target ? `${cut}${" ".repeat(target - w)}` : cut;
	}

	const budget = target - ellipsisWidth;
	const tokens = tokenizeAnsi(text);
	let out = "";
	let col = 0;
	let hasEscape = false;
	for (const tok of tokens) {
		if (tok.isEscape) {
			out += tok.text;
			hasEscape = true;
			continue;
		}
		if (col + tok.width > budget) break;
		out += tok.text;
		col += tok.width;
	}
	if (hasEscape) out += ANSI_RESET;
	out += ellipsis;
	const finalWidth = col + ellipsisWidth;
	if (pad && finalWidth < target) {
		out += " ".repeat(target - finalWidth);
	}
	return out;
}

function slicePlainToWidth(text: string, maxWidth: number): string {
	let out = "";
	let col = 0;
	for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
		const w = graphemeWidth(segment);
		if (col + w > maxWidth) break;
		out += segment;
		col += w;
	}
	return out;
}

/**
 * Word-wrap text to `width` visible columns while preserving ANSI escape codes across breaks.
 */
export function wrapTextWithAnsi(text: string, width: number): string[] {
	const maxWidth = Math.max(1, Math.floor(width));
	if (!text) return [""];

	const rawLines = text.split(/\r?\n/);
	const out: string[] = [];
	const activeSgr: string[] = [];

	for (const rawLine of rawLines) {
		if (rawLine.length === 0) {
			out.push(activeSgr.length > 0 ? `${activeSgr.join("")}${ANSI_RESET}` : "");
			continue;
		}

		// Split line into word/whitespace runs while preserving escape sequences.
		const tokens = tokenizeAnsi(rawLine);
		let current = activeSgr.join("");
		let currentWidth = 0;

		const flushLine = () => {
			if (activeSgr.length > 0 && current.length > 0) {
				out.push(`${current}${ANSI_RESET}`);
			} else {
				out.push(current);
			}
			current = activeSgr.join("");
			currentWidth = 0;
		};

		// Group contiguous non-whitespace tokens into words so we can break at word boundaries.
		let idx = 0;
		while (idx < tokens.length) {
			const tok = tokens[idx]!;
			if (tok.isEscape) {
				current += tok.text;
				updateActiveSgr(activeSgr, tok.text);
				idx++;
				continue;
			}

			// Whitespace token
			if (/^\s+$/.test(tok.text)) {
				if (currentWidth + tok.width <= maxWidth) {
					current += tok.text;
					currentWidth += tok.width;
				} else if (currentWidth > 0) {
					flushLine();
				}
				idx++;
				continue;
			}

			// Collect a word (non-whitespace printable tokens, plus any interleaved escapes)
			const wordStart = idx;
			let wordWidth = 0;
			while (idx < tokens.length) {
				const t = tokens[idx]!;
				if (!t.isEscape && /^\s+$/.test(t.text)) break;
				wordWidth += t.width;
				idx++;
			}

			// If the word fits on a fresh line (and doesn't fit on the current non-empty line), wrap before it.
			if (currentWidth > 0 && currentWidth + wordWidth > maxWidth && wordWidth <= maxWidth) {
				flushLine();
			}

			// Emit the word token-by-token, hard-breaking if a single word exceeds maxWidth.
			for (let j = wordStart; j < idx; j++) {
				const t = tokens[j]!;
				if (t.isEscape) {
					current += t.text;
					updateActiveSgr(activeSgr, t.text);
					continue;
				}
				if (currentWidth > 0 && currentWidth + t.width > maxWidth) {
					flushLine();
				}
				current += t.text;
				currentWidth += t.width;
			}
		}

		// Trim trailing spaces only when line was non-empty? Keep exact line content as pi-tui does.
		if (activeSgr.length > 0 && current.length > 0) {
			out.push(`${current}${ANSI_RESET}`);
		} else {
			out.push(current);
		}
	}

	return out;
}

// ── Keyboard Helpers (Legacy + Kitty CSI-u) ───────────────────────────────────

const KITTY_SHIFT = 1;
const KITTY_ALT = 2;
const KITTY_CTRL = 4;
const KITTY_SUPER = 8;

interface ParsedKey {
	key: string;
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
	superKey: boolean;
	isRelease: boolean;
}

const KITTY_CODEPOINT_NAMES: Record<number, string> = {
	9: "tab",
	13: "enter",
	27: "escape",
	32: "space",
	127: "backspace",
	57358: "capsLock",
	57414: "enter", // KP_Enter
};

const TILDE_KEY_NAMES: Record<number, string> = {
	1: "home",
	2: "insert",
	3: "delete",
	4: "end",
	5: "pageUp",
	6: "pageDown",
	7: "home",
	8: "end",
	11: "f1",
	12: "f2",
	13: "f3",
	14: "f4",
	15: "f5",
	17: "f6",
	18: "f7",
	19: "f8",
	20: "f9",
	21: "f10",
	23: "f11",
	24: "f12",
};

const FINAL_LETTER_KEYS: Record<string, string> = {
	A: "up",
	B: "down",
	C: "right",
	D: "left",
	F: "end",
	H: "home",
	P: "f1",
	Q: "f2",
	R: "f3",
	S: "f4",
};

function decodeModifiers(modParam: string | undefined): {
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
	superKey: boolean;
	isRelease: boolean;
} {
	if (!modParam) {
		return { ctrl: false, alt: false, shift: false, superKey: false, isRelease: false };
	}
	const [modStr, eventTypeStr] = modParam.split(":");
	const modNum = Math.max(1, Number.parseInt(modStr || "1", 10) || 1);
	const bits = modNum - 1;
	const eventType = eventTypeStr ? Number.parseInt(eventTypeStr, 10) : 1;
	return {
		shift: (bits & KITTY_SHIFT) !== 0,
		alt: (bits & KITTY_ALT) !== 0,
		ctrl: (bits & KITTY_CTRL) !== 0,
		superKey: (bits & KITTY_SUPER) !== 0,
		isRelease: eventType === 3,
	};
}

function parseRawKey(data: string): ParsedKey | null {
	if (!data) return null;

	// Single-byte control / special keys
	if (data === "\r" || data === "\n") {
		return { key: "enter", ctrl: false, alt: false, shift: false, superKey: false, isRelease: false };
	}
	if (data === "\t") {
		return { key: "tab", ctrl: false, alt: false, shift: false, superKey: false, isRelease: false };
	}
	if (data === "\x1b") {
		return { key: "escape", ctrl: false, alt: false, shift: false, superKey: false, isRelease: false };
	}
	if (data === "\x7f") {
		return { key: "backspace", ctrl: false, alt: false, shift: false, superKey: false, isRelease: false };
	}
	if (data === " ") {
		return { key: "space", ctrl: false, alt: false, shift: false, superKey: false, isRelease: false };
	}
	if (data === "\x1b[Z") {
		return { key: "tab", ctrl: false, alt: false, shift: true, superKey: false, isRelease: false };
	}

	// Single ASCII control bytes (\x01..\x1a -> ctrl+a..z; note \x08=ctrl+h, \x09=tab, \x0d=enter)
	if (data.length === 1) {
		const code = data.charCodeAt(0);
		if (code >= 1 && code <= 26) {
			const letter = String.fromCharCode(code + 96);
			return { key: letter, ctrl: true, alt: false, shift: false, superKey: false, isRelease: false };
		}
		if (code >= 0x20 && code <= 0x7e) {
			const lower = data.toLowerCase();
			return {
				key: lower,
				ctrl: false,
				alt: false,
				shift: data >= "A" && data <= "Z",
				superKey: false,
				isRelease: false,
			};
		}
		return null;
	}

	// Alt + single char: ESC <char>
	if (data.length === 2 && data.charCodeAt(0) === 0x1b) {
		const ch = data[1]!;
		const code = ch.charCodeAt(0);
		if (ch === "\r" || ch === "\n") {
			return { key: "enter", ctrl: false, alt: true, shift: false, superKey: false, isRelease: false };
		}
		if (ch === "\x7f" || ch === "\x08") {
			return { key: "backspace", ctrl: false, alt: true, shift: false, superKey: false, isRelease: false };
		}
		if (code >= 1 && code <= 26) {
			return {
				key: String.fromCharCode(code + 96),
				ctrl: true,
				alt: true,
				shift: false,
				superKey: false,
				isRelease: false,
			};
		}
		if (code >= 0x20 && code <= 0x7e) {
			return {
				key: ch.toLowerCase(),
				ctrl: false,
				alt: true,
				shift: ch >= "A" && ch <= "Z",
				superKey: false,
				isRelease: false,
			};
		}
	}

	// SS3 sequences: ESC O <A|B|C|D|F|H|P|Q|R|S>
	if (data.length === 3 && data.startsWith("\x1bO")) {
		const mapped = FINAL_LETTER_KEYS[data[2]!];
		if (mapped) {
			return { key: mapped, ctrl: false, alt: false, shift: false, superKey: false, isRelease: false };
		}
	}

	// Legacy alt+arrow (ESC ESC [ A/B/C/D)
	if (data.length === 4 && data.startsWith("\x1b\x1b[")) {
		const mapped = FINAL_LETTER_KEYS[data[3]!];
		if (mapped) {
			return { key: mapped, ctrl: false, alt: true, shift: false, superKey: false, isRelease: false };
		}
	}

	// Kitty CSI-u: ESC [ <cp>(:<shifted>(:<base>)?)?(;<mod>(:<event>)?)? u
	const kittyMatch = data.match(/^\x1b\[(\d+)(?::(\d*))?(?::(\d*))?(?:;(\d+(?::\d+)?))?u$/);
	if (kittyMatch) {
		const cp = Number.parseInt(kittyMatch[1]!, 10);
		const baseCp = kittyMatch[3] ? Number.parseInt(kittyMatch[3], 10) : undefined;
		const mods = decodeModifiers(kittyMatch[4]);
		const named = KITTY_CODEPOINT_NAMES[cp];
		let key: string;
		if (named) {
			key = named;
		} else {
			const effectiveCp = baseCp && Number.isFinite(baseCp) ? baseCp : cp;
			key = String.fromCodePoint(effectiveCp).toLowerCase();
		}
		return { key, ...mods };
	}

	// CSI letter keys: ESC [ (1;<mod>)? <A|B|C|D|F|H|P|Q|R|S>
	const csiLetter = data.match(/^\x1b\[(?:1;(\d+(?::\d+)?))?([ABCDFHPQRS])$/);
	if (csiLetter) {
		const mapped = FINAL_LETTER_KEYS[csiLetter[2]!];
		if (mapped) {
			const mods = decodeModifiers(csiLetter[1]);
			return { key: mapped, ...mods };
		}
	}

	// CSI tilde keys: ESC [ <num>(;<mod>)? ~
	const csiTilde = data.match(/^\x1b\[(\d+)(?:;(\d+(?::\d+)?))?~$/);
	if (csiTilde) {
		const num = Number.parseInt(csiTilde[1]!, 10);
		const mapped = TILDE_KEY_NAMES[num];
		if (mapped) {
			const mods = decodeModifiers(csiTilde[2]);
			return { key: mapped, ...mods };
		}
	}

	// xterm modifyOtherKeys: ESC [ 27 ; <mod> ; <cp> ~
	const modOther = data.match(/^\x1b\[27;(\d+);(\d+)~$/);
	if (modOther) {
		const mods = decodeModifiers(modOther[1]);
		const cp = Number.parseInt(modOther[2]!, 10);
		const key = KITTY_CODEPOINT_NAMES[cp] ?? String.fromCodePoint(cp).toLowerCase();
		return { key, ...mods };
	}

	return null;
}

function normalizeKeyName(name: string): string {
	const lower = name.toLowerCase();
	if (lower === "esc") return "escape";
	if (lower === "return") return "enter";
	if (lower === "pageup") return "pageUp";
	if (lower === "pagedown") return "pageDown";
	return lower;
}

/** Check whether raw terminal input `data` matches a key identifier like `"ctrl+c"`, `"escape"`, `"up"`, `"shift+tab"`. */
export function matchesKey(data: string, keyId: string): boolean {
	if (!data || !keyId) return false;
	const parts = keyId.split("+");
	let wantCtrl = false;
	let wantAlt = false;
	let wantShift = false;
	let wantSuper = false;
	let base = "";

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		const lower = part.toLowerCase();
		if (i < parts.length - 1) {
			if (lower === "ctrl" || lower === "control") wantCtrl = true;
			else if (lower === "alt" || lower === "meta" || lower === "opt") wantAlt = true;
			else if (lower === "shift") wantShift = true;
			else if (lower === "super" || lower === "cmd" || lower === "win") wantSuper = true;
			else base = part;
		} else {
			base = part;
		}
	}
	const wantKey = normalizeKeyName(base);

	// Special legacy alias: Backspace is often sent as \x08 (ctrl+h) on Windows terminals.
	if (wantKey === "backspace" && !wantCtrl && !wantAlt && !wantShift && !wantSuper) {
		if (data === "\x7f" || data === "\x08") return true;
	}

	const parsed = parseRawKey(data);
	if (!parsed || parsed.isRelease) return false;

	return (
		parsed.key === wantKey &&
		parsed.ctrl === wantCtrl &&
		parsed.alt === wantAlt &&
		parsed.shift === wantShift &&
		parsed.superKey === wantSuper
	);
}

/**
 * Decode a Kitty keyboard protocol CSI-u sequence into a printable character, if applicable.
 * Accepts plain or Shift-modified printable keys; ignores Ctrl/Alt/Super combinations and release events.
 */
export function decodeKittyPrintable(data: string): string | undefined {
	if (!data || !data.startsWith("\x1b[") || !data.endsWith("u")) return undefined;
	const m = data.match(/^\x1b\[(\d+)(?::(\d*))?(?::(\d*))?(?:;(\d+(?::\d+)?))?u$/);
	if (!m) return undefined;
	const mods = decodeModifiers(m[4]);
	if (mods.isRelease || mods.ctrl || mods.alt || mods.superKey) return undefined;

	const cp = Number.parseInt(m[1]!, 10);
	const shiftedCp = m[2] ? Number.parseInt(m[2], 10) : undefined;
	const chosen = mods.shift && shiftedCp && Number.isFinite(shiftedCp) ? shiftedCp : cp;
	if (!Number.isFinite(chosen) || chosen < 0x20 || chosen === 0x7f) return undefined;
	// Ignore Kitty Private Use Area functional key codes (57344..63743)
	if (chosen >= 0xe000 && chosen <= 0xf8ff) return undefined;
	try {
		const ch = String.fromCodePoint(chosen);
		if (mods.shift && !shiftedCp && ch >= "a" && ch <= "z") {
			return ch.toUpperCase();
		}
		return ch;
	} catch {
		return undefined;
	}
}

// ── Fuzzy Match ───────────────────────────────────────────────────────────────

/**
 * Case-insensitive fuzzy subsequence matcher (lower score = better match).
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch {
	const q = query.toLowerCase();
	const t = text.toLowerCase();
	if (q.length === 0) return { matches: true, score: 0 };
	if (q.length > t.length) return { matches: false, score: 0 };

	let qi = 0;
	let score = 0;
	let lastMatch = -1;
	let consecutive = 0;

	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) {
			const isBoundary =
				ti === 0 || t[ti - 1] === " " || t[ti - 1] === "-" || t[ti - 1] === "_" || t[ti - 1] === "/" || t[ti - 1] === ".";
			if (lastMatch === ti - 1) {
				consecutive++;
				score -= consecutive * 5;
			} else {
				consecutive = 0;
				if (lastMatch >= 0) score += (ti - lastMatch - 1) * 2;
			}
			if (isBoundary) score -= 10;
			score += ti * 0.1;
			lastMatch = ti;
			qi++;
		}
	}

	if (qi < q.length) return { matches: false, score: 0 };
	return { matches: true, score };
}

// ── Rows Components ───────────────────────────────────────────────────────────

/** Multi-line text component with word wrapping and optional padding. */
export class Text implements Component {
	private text: string;
	private paddingX: number;
	private paddingY: number;
	private customBgFn?: (text: string) => string;

	constructor(text = "", paddingX = 0, paddingY = 0, customBgFn?: (text: string) => string) {
		this.text = text;
		this.paddingX = Math.max(0, paddingX);
		this.paddingY = Math.max(0, paddingY);
		this.customBgFn = customBgFn;
	}

	setText(text: string): void {
		this.text = text;
	}

	setCustomBgFn(customBgFn?: (text: string) => string): void {
		this.customBgFn = customBgFn;
	}

	setPaddingX(paddingX: number): void {
		this.paddingX = Math.max(0, paddingX);
	}

	invalidate(): void {
		// Stateless render
	}

	render(width: number): string[] {
		if (!this.text && this.paddingY === 0) return [];
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const padX = " ".repeat(this.paddingX);
		const wrapped = this.text ? wrapTextWithAnsi(this.text, contentWidth) : [];
		const lines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) lines.push("");
		for (const line of wrapped) {
			const row = `${padX}${line}${padX}`;
			lines.push(this.customBgFn ? this.customBgFn(row) : row);
		}
		for (let i = 0; i < this.paddingY; i++) lines.push("");
		return lines;
	}
}

/** Vertical container of child rows components. */
export class Container implements Component {
	children: Component[] = [];

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const idx = this.children.indexOf(component);
		if (idx >= 0) this.children.splice(idx, 1);
	}

	clear(): void {
		this.children = [];
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			lines.push(...child.render(width));
		}
		return lines;
	}
}

/** Lightweight plain/wrapped Markdown rows component (no host markdown-theme dependency). */
export class Markdown implements Component {
	private text: string;
	private paddingX: number;
	private paddingY: number;

	constructor(text: string, paddingX = 0, paddingY = 0) {
		this.text = text;
		this.paddingX = Math.max(0, paddingX);
		this.paddingY = Math.max(0, paddingY);
	}

	setText(text: string): void {
		this.text = text;
	}

	invalidate(): void {
		// Stateless render
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const padX = " ".repeat(this.paddingX);
		const lines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) lines.push("");
		for (const wrapped of wrapTextWithAnsi(this.text, contentWidth)) {
			lines.push(`${padX}${wrapped}${padX}`);
		}
		for (let i = 0; i < this.paddingY; i++) lines.push("");
		return lines;
	}
}

/** Scrollable single-select list component for settings submenus. */
export class SelectList implements Component {
	private items: SelectItem[];
	private filteredItems: SelectItem[];
	private selectedIndex = 0;
	private maxVisible: number;
	private theme: SelectListTheme;

	onSelect?: (item: SelectItem) => void;
	onCancel?: () => void;
	onSelectionChange?: (item: SelectItem) => void;

	constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme) {
		this.items = [...items];
		this.filteredItems = [...items];
		this.maxVisible = Math.max(1, maxVisible);
		this.theme = theme;
	}

	setFilter(filter: string): void {
		const q = filter.trim().toLowerCase();
		this.filteredItems = q
			? this.items.filter(
					(item) =>
						item.label.toLowerCase().includes(q) ||
						item.value.toLowerCase().includes(q) ||
						(item.description?.toLowerCase().includes(q) ?? false),
				)
			: [...this.items];
		this.selectedIndex = 0;
	}

	setSelectedIndex(index: number): void {
		if (this.filteredItems.length === 0) {
			this.selectedIndex = 0;
			return;
		}
		this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
	}

	getSelectedItem(): SelectItem | null {
		return this.filteredItems[this.selectedIndex] ?? null;
	}

	invalidate(): void {
		// Stateless render
	}

	render(width: number): string[] {
		if (this.filteredItems.length === 0) {
			return [this.theme.noMatch("  No items")];
		}

		const count = this.filteredItems.length;
		const visible = Math.min(this.maxVisible, count);
		const start = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(visible / 2), count - visible),
		);
		const end = Math.min(count, start + visible);
		const lines: string[] = [];

		if (start > 0) {
			lines.push(this.theme.scrollInfo(`  ↑ ${start} earlier`));
		}

		for (let i = start; i < end; i++) {
			const item = this.filteredItems[i]!;
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? this.theme.selectedPrefix("→ ") : "  ";
			const label = isSelected ? this.theme.selectedText(item.label) : item.label;
			const desc = item.description ? `  ${this.theme.description(item.description)}` : "";
			lines.push(truncateToWidth(`${prefix}${label}${desc}`, width, "…"));
		}

		if (end < count) {
			lines.push(this.theme.scrollInfo(`  ↓ ${count - end} more`));
		}

		return lines;
	}

	handleInput(keyData: string): void {
		const count = this.filteredItems.length;
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "ctrl+c")) {
			this.onCancel?.();
			return;
		}
		if (count === 0) return;

		if (matchesKey(keyData, "up")) {
			this.selectedIndex = (this.selectedIndex - 1 + count) % count;
			const item = this.filteredItems[this.selectedIndex];
			if (item) this.onSelectionChange?.(item);
			return;
		}
		if (matchesKey(keyData, "down")) {
			this.selectedIndex = (this.selectedIndex + 1) % count;
			const item = this.filteredItems[this.selectedIndex];
			if (item) this.onSelectionChange?.(item);
			return;
		}
		if (matchesKey(keyData, "pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
			const item = this.filteredItems[this.selectedIndex];
			if (item) this.onSelectionChange?.(item);
			return;
		}
		if (matchesKey(keyData, "pageDown")) {
			this.selectedIndex = Math.min(count - 1, this.selectedIndex + this.maxVisible);
			const item = this.filteredItems[this.selectedIndex];
			if (item) this.onSelectionChange?.(item);
			return;
		}
		if (matchesKey(keyData, "home")) {
			this.selectedIndex = 0;
			const item = this.filteredItems[this.selectedIndex];
			if (item) this.onSelectionChange?.(item);
			return;
		}
		if (matchesKey(keyData, "end")) {
			this.selectedIndex = count - 1;
			const item = this.filteredItems[this.selectedIndex];
			if (item) this.onSelectionChange?.(item);
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return")) {
			const item = this.filteredItems[this.selectedIndex];
			if (item) this.onSelect?.(item);
		}
	}
}

/** Lightweight multiline text editor component for `type: "text"` settings fields. */
export class Editor implements Component {
	private lines: string[] = [""];
	private row = 0;
	private col = 0;
	private theme: EditorTheme;
	private tui: TUI;
	private paddingX: number;

	focused = false;
	disableSubmit = false;
	onChange?: (text: string) => void;
	onSubmit?: (text: string) => void;

	constructor(tui: TUI, theme: EditorTheme, options?: { paddingX?: number }) {
		this.tui = tui;
		this.theme = theme;
		this.paddingX = Math.max(0, options?.paddingX ?? 0);
	}

	setText(text: string): void {
		const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		this.lines = normalized.split("\n");
		if (this.lines.length === 0) this.lines = [""];
		this.row = this.lines.length - 1;
		this.col = this.lines[this.row]!.length;
	}

	getText(): string {
		return this.lines.join("\n");
	}

	getExpandedText(): string {
		return this.getText();
	}

	invalidate(): void {
		// Stateless render
	}

	render(width: number): string[] {
		const safeWidth = Math.max(4, width);
		const padX = " ".repeat(this.paddingX);
		const innerWidth = Math.max(1, safeWidth - this.paddingX * 2);
		const rule = this.theme.borderColor("─".repeat(safeWidth));
		const out: string[] = [rule];

		for (let r = 0; r < this.lines.length; r++) {
			const line = this.lines[r]!;
			const display =
				this.focused && r === this.row
					? `${line.slice(0, this.col)}█${line.slice(this.col)}`
					: line;
			const wrapped = wrapTextWithAnsi(display || " ", innerWidth);
			for (const seg of wrapped) {
				out.push(`${padX}${truncateToWidth(seg, innerWidth, "")}${padX}`);
			}
		}

		out.push(rule);
		return out;
	}

	handleInput(data: string): void {
		if (!data) return;

		if (matchesKey(data, "up")) {
			if (this.row > 0) {
				this.row--;
				this.col = Math.min(this.col, this.lines[this.row]!.length);
			}
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			if (this.row < this.lines.length - 1) {
				this.row++;
				this.col = Math.min(this.col, this.lines[this.row]!.length);
			}
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "left")) {
			if (this.col > 0) {
				this.col--;
			} else if (this.row > 0) {
				this.row--;
				this.col = this.lines[this.row]!.length;
			}
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "right")) {
			const line = this.lines[this.row]!;
			if (this.col < line.length) {
				this.col++;
			} else if (this.row < this.lines.length - 1) {
				this.row++;
				this.col = 0;
			}
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) {
			this.col = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) {
			this.col = this.lines[this.row]!.length;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h")) {
			const line = this.lines[this.row]!;
			if (this.col > 0) {
				this.lines[this.row] = line.slice(0, this.col - 1) + line.slice(this.col);
				this.col--;
			} else if (this.row > 0) {
				const prev = this.lines[this.row - 1]!;
				this.col = prev.length;
				this.lines[this.row - 1] = prev + line;
				this.lines.splice(this.row, 1);
				this.row--;
			}
			this.onChange?.(this.getText());
			return;
		}
		if (matchesKey(data, "delete")) {
			const line = this.lines[this.row]!;
			if (this.col < line.length) {
				this.lines[this.row] = line.slice(0, this.col) + line.slice(this.col + 1);
			} else if (this.row < this.lines.length - 1) {
				this.lines[this.row] = line + this.lines[this.row + 1]!;
				this.lines.splice(this.row + 1, 1);
			}
			this.onChange?.(this.getText());
			return;
		}
		if (matchesKey(data, "ctrl+w")) {
			const line = this.lines[this.row]!;
			let start = this.col;
			while (start > 0 && /\s/.test(line[start - 1]!)) start--;
			while (start > 0 && !/\s/.test(line[start - 1]!)) start--;
			this.lines[this.row] = line.slice(0, start) + line.slice(this.col);
			this.col = start;
			this.onChange?.(this.getText());
			return;
		}
		if (matchesKey(data, "ctrl+k")) {
			const line = this.lines[this.row]!;
			this.lines[this.row] = line.slice(0, this.col);
			this.onChange?.(this.getText());
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || matchesKey(data, "shift+enter")) {
			if (!this.disableSubmit && !matchesKey(data, "shift+enter")) {
				this.onSubmit?.(this.getText());
				return;
			}
			const line = this.lines[this.row]!;
			this.lines[this.row] = line.slice(0, this.col);
			this.lines.splice(this.row + 1, 0, line.slice(this.col));
			this.row++;
			this.col = 0;
			this.onChange?.(this.getText());
			return;
		}

		// Printable characters (single char, Kitty CSI-u, or pasted text)
		const decoded = decodeKittyPrintable(data);
		const insertText = decoded ?? (data.startsWith("\x1b") ? "" : data);
		if (!insertText) return;
		const normalized = insertText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		const parts = normalized.split("\n");
		const line = this.lines[this.row]!;
		const before = line.slice(0, this.col);
		const after = line.slice(this.col);
		if (parts.length === 1) {
			this.lines[this.row] = before + parts[0]! + after;
			this.col += parts[0]!.length;
		} else {
			const first = before + parts[0]!;
			const last = parts[parts.length - 1]! + after;
			const middle = parts.slice(1, -1);
			this.lines.splice(this.row, 1, first, ...middle, last);
			this.row += parts.length - 1;
			this.col = parts[parts.length - 1]!.length;
		}
		this.onChange?.(this.getText());
	}
}
