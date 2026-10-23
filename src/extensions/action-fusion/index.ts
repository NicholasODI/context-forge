/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Action Fusion - fuse a file mutation and its follow-up command into one turn.
 *
 * Base pi rollouts repeatedly showed the same pair of turns: edit or write a
 * file, then run a command to test, build, or start it. This extension replaces
 * the built-in `edit` and `write` tools with versions that take an optional
 * `then_run` object, apply the mutation, run the command, and return one
 * combined observation. The model decision between the two turns disappears.
 *
 * Everything else about `edit` and `write` is inherited from the built-in
 * definitions: their schemas, prompt text, argument shims, and renderers.
 *
 * This standalone version composes only Pi's public tool definitions.
 */

import {
	type BashToolOptions,
	createEditToolDefinition,
	createWriteToolDefinition,
	type EditToolDetails,
	type EditToolOptions,
	type ExtensionAPI,
	type ExtensionFactory,
	type WriteToolOptions,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveToolPath } from "./file-queue.ts";
import { showSolPiSavings } from "../../tui.ts";
import {
	createThenRunSchema,
	executeMutationThenRun,
	THEN_RUN_SUCCEEDED,
	type ThenRunInput,
} from "./then-run.ts";

const EDIT_THEN_RUN_DESCRIPTION =
	"Command to run next on this file after the edit succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the edit fails; a non-zero exit is reported but keeps the edit.";
const WRITE_THEN_RUN_DESCRIPTION =
	"Command to run next on this file after the write succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the write fails; a non-zero exit is reported but keeps the write.";

export interface ActionFusionOptions {
	/** Optional programmatic bash overrides, primarily for tests and embedded runtimes. */
	readonly bashOptions?: BashToolOptions;
	/** Overrides for the underlying built-in `edit` tool. */
	readonly editOptions?: EditToolOptions;
	/** Overrides for the underlying built-in `write` tool. */
	readonly writeOptions?: WriteToolOptions;
}

/**
 * Built-in tool definitions capture their cwd in closures, so keep one per
 * working directory instead of rebuilding them on every call and every redraw.
 */
function memoizeByCwd<T>(create: (cwd: string) => T): (cwd: string) => T {
	const cache = new Map<string, T>();
	return (cwd) => {
		const cached = cache.get(cwd);
		if (cached) return cached;
		const created = create(cwd);
		cache.set(cwd, created);
		return created;
	};
}

/**
 * omp compat: the host's `edit` tool takes an `input` patch blob (with
 * `[PATH#TAG]` headers) instead of a structured `path`; derive the first
 * target file from the leading header for the queue and hash guard.
 */
function editTargetPath(input: unknown): string {
	if (typeof input === "string") {
		const header = input.match(/^\s*\[([^\]]+?)#/m);
		if (header) return header[1];
	}
	const path = (input as { path?: unknown } | null)?.path;
	return typeof path === "string" ? path : ".";
}

export function createActionFusionExtension(options: ActionFusionOptions = {}): ExtensionFactory {
	const baseEdit = memoizeByCwd((cwd: string) => createEditToolDefinition(cwd, options.editOptions));
	const baseWrite = memoizeByCwd((cwd: string) => createWriteToolDefinition(cwd, options.writeOptions));

	return (pi: ExtensionAPI) => {
		const editTemplate = baseEdit(process.cwd());
		const writeTemplate = baseWrite(process.cwd());

		// omp compat: the host's built-in definitions expose `parameters` as a
		// compiled omptype builder without `.properties`, so declare the base
		// contracts explicitly (write: path+content, edit: the input patch blob).
		const editParameters = Type.Object({
			input: Type.String({ description: "One or more [PATH#TAG] sections containing hashline operations." }),
			then_run: createThenRunSchema(EDIT_THEN_RUN_DESCRIPTION),
		});
		const writeParameters = Type.Object({
			path: Type.String({ description: "Target path. Plain paths write files; writable internal URLs, archive entries, and SQLite rows are supported." }),
			content: Type.String({ description: "Full replacement content." }),
			then_run: createThenRunSchema(WRITE_THEN_RUN_DESCRIPTION),
		});

		pi.registerTool<typeof editParameters, EditToolDetails | undefined>({
			...editTemplate,
			parameters: editParameters,
			async execute(toolCallId, input, signal, onUpdate, ctx) {
				const { then_run, ...editInput } = input as typeof input & { then_run?: ThenRunInput };
				const result = await executeMutationThenRun({
					toolCallId,
					absolutePath: resolveToolPath(ctx.cwd, editTargetPath(input)),
					thenRun: then_run,
					bashOptions: options.bashOptions,
					signal,
					ctx,
					mutate: () => baseEdit(ctx.cwd).execute(toolCallId, editInput, signal, onUpdate, ctx),
				});
				if (
					then_run &&
					result.content.some((block) => block.type === "text" && block.text.includes(THEN_RUN_SUCCEEDED))
				) {
					showSolPiSavings(ctx, "Action Fusion", "1 model round-trip avoided");
				}
				return result;
			},
			// omp compat: the host's built-in definitions carry no renderCall/renderResult;
			// omit them so the host renders fused calls with its native tool renderers.
		});

		pi.registerTool<typeof writeParameters, undefined>({
			...writeTemplate,
			parameters: writeParameters,
			async execute(toolCallId, input, signal, onUpdate, ctx) {
				const { then_run, ...writeInput } = input as typeof input & { then_run?: ThenRunInput };
				const result = await executeMutationThenRun({
					toolCallId,
					absolutePath: resolveToolPath(ctx.cwd, input.path),
					thenRun: then_run,
					bashOptions: options.bashOptions,
					signal,
					ctx,
					mutate: () => baseWrite(ctx.cwd).execute(toolCallId, writeInput, signal, onUpdate, ctx),
				});
				if (
					then_run &&
					result.content.some((block) => block.type === "text" && block.text.includes(THEN_RUN_SUCCEEDED))
				) {
					showSolPiSavings(ctx, "Action Fusion", "1 model round-trip avoided");
				}
				return result;
			},
			// (renderers omitted — see the edit registration above)
		});
	};
}

export type { ThenRunInput } from "./then-run.ts";
export {
	assertUnchangedBeforeCommand,
	executeMutationThenRun,
	THEN_RUN_FAILED,
	THEN_RUN_SKIPPED,
	THEN_RUN_SUCCEEDED,
} from "./then-run.ts";

export function registerActionFusion(pi: ExtensionAPI): void {
	createActionFusionExtension()(pi);
}

export default registerActionFusion;
