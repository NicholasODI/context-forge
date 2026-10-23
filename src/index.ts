/*
 * context-forge — merged context-engineering extension for omp.
 *
 * Combines SoL-Pi's four mechanisms (Action Fusion, Observation Pack,
 * Evidence-Preserving Reducer, Online Context Compact) with pi-blackhole's
 * observational memory, VCC compaction content, and unified recall into a
 * single extension.
 *
 * Registration order is deterministic: SoL-Pi mechanisms first (their
 * `context` handlers see raw messages and archive/placeholder them), then
 * pi-blackhole's compaction-context projection (which sees the placeholders).
 * Compaction triggering belongs to online-context-compact; pi-blackhole's
 * compaction-trigger is not registered.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { loadContextForgeConfig, type ContextForgeConfig } from "./config.ts";
import { registerActionFusion } from "./extensions/action-fusion/index.ts";
import { registerObservationPack } from "./extensions/observation-pack/index.ts";
import { registerEvidencePreservingReducer } from "./extensions/evidence-preserving-reducer/index.ts";
import { registerOnlineContextCompact } from "./extensions/online-context-compact/index.ts";
import { Runtime } from "./blackhole/src/om/runtime.ts";
import { registerBlackholeCommands, registerBlackholeMechanisms } from "./blackhole-register.ts";

export type ContextForgeConfigLoader = (ctx: ExtensionContext) => ContextForgeConfig;

export function createContextForgeExtension(
	loadConfig: ContextForgeConfigLoader = (ctx) =>
		loadContextForgeConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted()),
): ExtensionFactory {
	return (pi) => {
		let initialized = false;

		// Eager slash command registration — available immediately without
		// waiting for session_start, so commands work after omp restart.
		const omRuntime = new Runtime();
		registerBlackholeCommands(pi, omRuntime);

		pi.on("session_start", async (_event, ctx) => {
			if (initialized) return;
			initialized = true;
			const config = loadConfig(ctx);

			// ── SoL-Pi mechanisms (context handlers see raw messages first) ──
			if (config.actionFusion) registerActionFusion(pi);
			if (config.observationPack) registerObservationPack(pi);
			if (config.evidencePreservingReducer) {
				registerEvidencePreservingReducer(pi, {
					reducerModel: config.evidencePreservingReducerModel,
					reducerProvider: config.evidencePreservingReducerProvider,
				});
			}
			if (config.onlineContextCompact) {
				registerOnlineContextCompact(pi, config.cacheWriteReadRatio);
			}

			// ── pi-blackhole-derived mechanisms (see placeholders, not raw data) ──
			await registerBlackholeMechanisms(pi, omRuntime, {
				observationalMemory: config.observationalMemory,
				vccCompaction: config.vccCompaction,
				unifiedRecall: config.unifiedRecall,
			});
		});
	};
}

export default function contextForgeExtension(pi: ExtensionAPI): void {
	createContextForgeExtension()(pi);
}
