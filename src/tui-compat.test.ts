import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	Container,
	createSelectListTheme,
	decodeKittyPrintable,
	Editor,
	fuzzyMatch,
	getTerminalRows,
	Markdown,
	matchesKey,
	SelectList,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "./tui-compat.ts";

describe("tui-compat", () => {
	it("strips ANSI, OSC, and APC terminal sequences and measures visible width", () => {
		const styled = "\x1b[32mhello\x1b[0m \x1b]8;;https://example.com\x07link\x1b]8;;\x07";
		expect(stripTerminalSequences(styled)).toBe("hello link");
		expect(visibleWidth(styled)).toBe(10);
		expect(visibleWidth("中文")).toBe(4);
		expect(visibleWidth("a\tb")).toBe(6);
	});

	it("truncates with ellipsis and optional padding while preserving ANSI safety", () => {
		expect(truncateToWidth("hello world", 8, "…")).toBe("hello w…");
		expect(truncateToWidth("hi", 5, "…", true)).toBe("hi   ");
		const styled = "\x1b[31mabcdefghij\x1b[0m";
		const cut = truncateToWidth(styled, 5, "…");
		expect(visibleWidth(cut)).toBe(5);
		expect(cut).toContain("\x1b[0m…");
	});

	it("wraps long lines while keeping ANSI style active across wrapped rows", () => {
		const wrapped = wrapTextWithAnsi("\x1b[33malpha beta gamma\x1b[0m", 10);
		expect(wrapped.length).toBeGreaterThanOrEqual(2);
		for (const row of wrapped) {
			expect(visibleWidth(row)).toBeLessThanOrEqual(10);
			expect(row).toContain("\x1b[33m");
		}
	});

	it("matches legacy and Kitty keyboard protocol keys and decodes Kitty printables", () => {
		expect(matchesKey("\r", "enter")).toBe(true);
		expect(matchesKey("\r", "return")).toBe(true);
		expect(matchesKey("\x1b", "escape")).toBe(true);
		expect(matchesKey("\x1b[A", "up")).toBe(true);
		expect(matchesKey("\x1b[1;3A", "alt+up")).toBe(true);
		expect(matchesKey("\x1b[Z", "shift+tab")).toBe(true);
		expect(matchesKey("\x03", "ctrl+c")).toBe(true);
		expect(matchesKey("\x1b[99;5u", "ctrl+c")).toBe(true);
		expect(matchesKey("\x1b[99;5:3u", "ctrl+c")).toBe(false); // key release ignored
		expect(matchesKey("\x1br", "alt+r")).toBe(true);

		expect(decodeKittyPrintable("\x1b[53u")).toBe("5");
		expect(decodeKittyPrintable("\x1b[97:65;2u")).toBe("A");
		expect(decodeKittyPrintable("\x1b[99;5u")).toBeUndefined(); // ctrl+c is not printable
		expect(decodeKittyPrintable("\x1b[53;1:3u")).toBeUndefined(); // release ignored
	});

	it("supports fuzzy subsequence matching", () => {
		expect(fuzzyMatch("obs", "observationalMemory").matches).toBe(true);
		expect(fuzzyMatch("xyz", "observationalMemory").matches).toBe(false);
	});

	it("reads terminal rows from both omp ui.size() and legacy tui.terminal.rows", () => {
		expect(getTerminalRows({ requestRender() {}, size: () => ({ columns: 120, rows: 40 }) })).toBe(40);
		expect(getTerminalRows({ requestRender() {}, terminal: { columns: 100, rows: 32 } })).toBe(32);
		expect(getTerminalRows({ requestRender() {} }, 24)).toBe(24);
	});

	it("renders Text, Container, Markdown, SelectList, and Editor as rows objects", () => {
		const theme = { fg: (_c: string, t: string) => t };
		const container = new Container();
		container.addChild(new Text("first line", 0, 0));
		container.addChild(new Markdown("second line", 0, 0));
		expect(container.render(40)).toEqual(["first line", "second line"]);

		const onSelect = vi.fn();
		const list = new SelectList(
			[
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
			],
			5,
			createSelectListTheme(theme),
		);
		list.onSelect = onSelect;
		list.handleInput("\x1b[B");
		expect(list.getSelectedItem()?.value).toBe("b");
		list.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith({ value: "b", label: "Beta" });

		const tui = { requestRender: vi.fn() };
		const editor = new Editor(tui, { borderColor: (s) => s });
		editor.disableSubmit = true;
		editor.setText("hi");
		editor.handleInput("\r");
		editor.handleInput("there");
		expect(editor.getExpandedText()).toBe("hi\nthere");
		expect(editor.render(20).length).toBeGreaterThanOrEqual(4);
	});

	it("contains no forbidden upstream pi-tui or removed coding-agent theme imports in src/", () => {
		const srcRoot = join(import.meta.dirname);
		const forbidden = [
			/(?:from|import\s*\()\s*["']@(?:earendil-works|mariozechner)\/pi-tui(?:\/[^"']*)?["']/,
			/import\s*\{[^}]*\b(?:getSelectListTheme|getMarkdownTheme)\b[^}]*\}\s*from\s*["']@/,
		];
		const offenders: string[] = [];

		function walk(dir: string): void {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
				} else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
					const content = readFileSync(full, "utf8");
					for (const pattern of forbidden) {
						if (pattern.test(content)) {
							offenders.push(`${full}: matched ${pattern}`);
						}
					}
				}
			}
		}

		walk(srcRoot);
		expect(offenders).toEqual([]);
	});
});
