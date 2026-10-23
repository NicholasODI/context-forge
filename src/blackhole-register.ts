/*
 * context-forge — pi-blackhole-derived mechanism registration.
 *
 * Sets up the observational-memory Runtime and registers, in deterministic
 * order: provider-stream capture, consolidation (memory workers), VCC
 * before-compact content, compact-failed handling, compaction-context
 * projection, pre-compaction output archive, and the unified recall tool.
 *
 * Compaction TRIGGERING is owned by pi-blackhole's threshold trigger
 * (compaction-trigger.ts), registered with the VCC compaction mechanisms
 * below. The SoL-Pi online-context-compact economic trigger is disabled via
 * context-forge.json (onlineContextCompact: false) so the two never both fire.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Runtime } from "./blackhole/src/om/runtime.ts";
import { captureRegisteredProviderStreams } from "./blackhole/src/om/provider-stream.ts";
import { installHostInlineCompactionAdapter } from "./blackhole/src/om/inline-compaction.ts";
import { registerConsolidationTrigger } from "./blackhole/src/om/consolidation.ts";
import { registerCompactionTrigger } from "./blackhole/src/om/compaction-trigger.ts";
import { registerBeforeCompactHook } from "./blackhole/src/hooks/before-compact.ts";
import { registerCompactFailedHook } from "./blackhole/src/hooks/compact-failed.ts";
import { registerCompactionContextHook } from "./blackhole/src/hooks/compaction-context.ts";
import { registerPreCompactionOutput } from "./blackhole/src/hooks/cosmetic-output.ts";
import { registerRecallTool } from "./blackhole/src/tools/recall.ts";
import { scaffoldSettings } from "./blackhole/src/core/settings.ts";
import { registerPiVccCommand } from "./blackhole/src/commands/pi-vcc.ts";
import { registerMemoryCommand } from "./blackhole/src/commands/memory.ts";
import { registerBlackholeExportCommand } from "./blackhole/src/commands/blackhole-export.ts";
import { registerVccRecallCommand } from "./blackhole/src/commands/vcc-recall.ts";

export interface BlackholeMechanisms {
	readonly observationalMemory: boolean;
	readonly vccCompaction: boolean;
	readonly unifiedRecall: boolean;
}

export function registerBlackholeCommands(
	pi: ExtensionAPI,
	omRuntime: Runtime,
): void {
	registerPiVccCommand(pi, omRuntime);
	registerMemoryCommand(pi, omRuntime);
	registerBlackholeExportCommand(pi);
	registerVccRecallCommand(pi);
}

export async function registerBlackholeMechanisms(
	pi: ExtensionAPI,
	omRuntime: Runtime,
	mechanisms: BlackholeMechanisms,
): Promise<void> {
	// Resolve the host AgentSession identity before this returns so the inline
	// compaction adapter patches the right class. Reload-idempotent; fails
	// closed (status surfaced via runtime) on unknown host internals.
	const inlineCompactionAdapterStatus = await installHostInlineCompactionAdapter();

	// Bridge: capture custom provider stream functions for jiti-loaded agents.
	const PROVIDER_STREAMS_KEY = Symbol.for("pi-blackhole:provider-streams");
	const providerStreams: Map<string, Function> = ((globalThis as any)[PROVIDER_STREAMS_KEY] ??=
		new Map());

	omRuntime.inlineCompactionAdapterStatus = inlineCompactionAdapterStatus;

	pi.on("agent_start", (_event: unknown, ctx: ExtensionContext) => {
		captureRegisteredProviderStreams(ctx.modelRegistry, providerStreams);
		omRuntime.resetNoticeGate();
	});

	scaffoldSettings();

	if (mechanisms.observationalMemory) {
		registerConsolidationTrigger(pi, omRuntime);
	}
	if (mechanisms.vccCompaction) {
		registerBeforeCompactHook(pi, omRuntime);
		registerCompactionTrigger(pi, omRuntime);
		registerCompactFailedHook(pi, omRuntime);
		registerCompactionContextHook(pi, omRuntime);
		registerPreCompactionOutput(pi, omRuntime);
	}
	if (mechanisms.unifiedRecall) {
		registerRecallTool(pi, omRuntime);
	}
}
