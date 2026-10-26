/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * omp compat: verbatim logic port of @earendil-works/pi-coding-agent internals
 * that the omp host bundle does not export. Sources (Pi 0.84.2 dist):
 *   core/messages.ts               createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage
 *   core/session-manager.ts        sessionEntryToContextMessages
 *   core/compaction/compaction.ts  estimateTokens, findCutPoint + private helpers
 *
 * Kept inside the extension so online-context-compact runs unchanged under omp;
 * if omp starts exporting the originals, this file can be deleted and the
 * extension.ts imports pointed back at the host package.
 */

type PortedBlock = {
	readonly type: string;
	readonly text?: string;
	readonly thinking?: string;
	readonly name?: string;
	readonly arguments?: unknown;
};

type PortedMessage = {
	readonly role: string;
	readonly content?: string | readonly PortedBlock[];
	readonly summary?: string;
	readonly command?: string;
	readonly output?: string;
};

type PortedEntry = {
	readonly type: string;
	readonly message?: PortedMessage;
	readonly customType?: string;
	readonly content?: unknown;
	readonly display?: boolean;
	readonly details?: unknown;
	readonly timestamp?: string;
	readonly summary?: string;
	readonly fromId?: string;
	readonly tokensBefore?: number;
};

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(content: string | readonly PortedBlock[]): number {
	if (typeof content === "string") {
		return content.length;
	}
	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is conservative (overestimates tokens).
 */
function estimateTokens(message: PortedMessage): number {
	let chars = 0;
	switch (message.role) {
		case "user": {
			chars = estimateTextAndImageContentChars(message.content ?? "");
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message;
			for (const block of (assistant.content as readonly PortedBlock[]) ?? []) {
				if (block.type === "text") {
					chars += block.text?.length ?? 0;
				} else if (block.type === "thinking") {
					chars += block.thinking?.length ?? 0;
				} else if (block.type === "toolCall") {
					chars += (block.name?.length ?? 0) + JSON.stringify(block.arguments ?? {}).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			chars = estimateTextAndImageContentChars(message.content ?? "");
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = (message.command?.length ?? 0) + (message.output?.length ?? 0);
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary?.length ?? 0;
			return Math.ceil(chars / 4);
		}
	}
	return 0;
}

function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string) {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

function createCompactionSummaryMessage(summary: string, tokensBefore: number, timestamp: string) {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert a custom-message entry to AgentMessage format. */
function createCustomMessage(
	customType: string,
	content: string | readonly PortedBlock[],
	display: boolean,
	details: unknown,
	timestamp: string,
) {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * Project one selected session entry into LLM/runtime messages.
 * Plain custom entries are display/state entries and do not participate in context.
 */
export function sessionEntryToContextMessages(entry: PortedEntry): PortedMessage[] {
	if (entry.type === "message") {
		const message = entry.message;
		// Session files are parsed without validation; a `message` entry can carry
		// no message object at all (old versions, forks, hand-edits) — drop it.
		if (message == null) return [];
		// Session files are parsed without validation; old versions, forks, or
		// hand-edited files can contain messages with null/missing content.
		if (
			(message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
			message.content == null
		) {
			return [{ ...message, content: [] }];
		}
		return [message];
	}
	if (entry.type === "custom_message") {
		// Raw session content is unvalidated; keep only the shapes createCustomMessage accepts.
		const content: string | readonly PortedBlock[] =
			typeof entry.content === "string" || Array.isArray(entry.content) ? entry.content : [];
		return [createCustomMessage(entry.customType ?? "", content, entry.display ?? false, entry.details, entry.timestamp ?? "")];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [createBranchSummaryMessage(entry.summary, entry.fromId ?? "", entry.timestamp ?? "")];
	}
	if (entry.type === "compaction") {
		return [createCompactionSummaryMessage(entry.summary ?? "", entry.tokensBefore ?? 0, entry.timestamp ?? "")];
	}
	return [];
}

function isCutPointMessage(message: PortedMessage): boolean {
	switch (message.role) {
		case "user":
		case "assistant":
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "toolResult":
			return false;
	}
	return false;
}

function isTurnStartMessage(message: PortedMessage): boolean {
	switch (message.role) {
		case "user":
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "assistant":
		case "toolResult":
			return false;
	}
	return false;
}

function isTurnStartEntry(entry: PortedEntry): boolean {
	if (entry.type === "compaction") {
		return false;
	}
	return sessionEntryToContextMessages(entry).some(isTurnStartMessage);
}

/**
 * Find valid cut points: indices of context-visible user-like or assistant messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 */
function findValidCutPoints(entries: readonly PortedEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (entry.type === "compaction") {
			continue;
		}
		if (sessionEntryToContextMessages(entry).some(isCutPointMessage)) {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * Find the context-visible user-role message that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 */
function findTurnStartIndex(entries: readonly PortedEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		if (isTurnStartEntry(entries[i])) {
			return i;
		}
	}
	return -1;
}

/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: readonly PortedEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): { firstKeptEntryIndex: number; turnStartIndex: number; isSplitTurn: boolean } {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);
	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}
	// Walk backwards from newest, accumulating estimated message sizes
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // Default: keep from first message (not header)
	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		const messageTokens = sessionEntryToContextMessages(entry).reduce((sum, message) => sum + estimateTokens(message), 0);
		if (messageTokens === 0) {
			continue;
		}
		accumulatedTokens += messageTokens;
		// Check if we've exceeded the budget
		if (accumulatedTokens >= keepRecentTokens) {
			// Find the closest valid cut point at or after this entry
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}
	// Scan backwards from cutIndex to include adjacent metadata entries that do not affect context.
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// Stop at compaction boundaries or context-visible entries.
		if (prevEntry.type === "compaction" || sessionEntryToContextMessages(prevEntry).length > 0) {
			break;
		}
		cutIndex--;
	}
	// Determine if this is a split turn
	const cutEntry = entries[cutIndex];
	const startsTurn = isTurnStartEntry(cutEntry);
	const turnStartIndex = startsTurn ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);
	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !startsTurn && turnStartIndex !== -1,
	};
}
