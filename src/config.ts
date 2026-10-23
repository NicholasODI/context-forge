/*
 * context-forge — unified configuration.
 *
 * One JSON file (context-forge.json) toggles every mechanism. Resolution:
 *   defaults ← global (~/.omp/agent/context-forge.json) ← project (<cwd>/.omp/context-forge.json)
 *
 * The pi-blackhole-derived mechanisms (observational memory, VCC compaction
 * content, unified recall) additionally read pi-blackhole's own
 * blackhole-config.json for fine-grained tuning; this file only gates whether
 * those mechanisms are registered at all.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_REDUCER_MODEL,
	DEFAULT_REDUCER_PROVIDER,
} from "./extensions/evidence-preserving-reducer/config.ts";

export const DEFAULT_CACHE_WRITE_READ_RATIO = 12.5;

export interface ContextForgeConfig {
	readonly version: 1;
	// SoL-Pi mechanisms
	readonly actionFusion: boolean;
	readonly observationPack: boolean;
	readonly evidencePreservingReducer: boolean;
	readonly evidencePreservingReducerModel: string;
	readonly evidencePreservingReducerProvider: string;
	readonly onlineContextCompact: boolean;
	readonly cacheWriteReadRatio: number;
	// pi-blackhole-derived mechanisms
	readonly observationalMemory: boolean;
	readonly vccCompaction: boolean;
	readonly unifiedRecall: boolean;
}

export const DEFAULT_CONFIG: ContextForgeConfig = Object.freeze({
	version: 1,
	actionFusion: true,
	observationPack: true,
	evidencePreservingReducer: false,
	evidencePreservingReducerModel: DEFAULT_REDUCER_MODEL,
	evidencePreservingReducerProvider: DEFAULT_REDUCER_PROVIDER,
	onlineContextCompact: true,
	cacheWriteReadRatio: DEFAULT_CACHE_WRITE_READ_RATIO,
	observationalMemory: true,
	vccCompaction: true,
	unifiedRecall: true,
});

const FEATURE_KEYS = [
	"actionFusion",
	"observationPack",
	"evidencePreservingReducer",
	"onlineContextCompact",
	"observationalMemory",
	"vccCompaction",
	"unifiedRecall",
] as const;
const STRING_KEYS = ["evidencePreservingReducerModel", "evidencePreservingReducerProvider"] as const;
const CONFIG_KEYS = new Set<string>(["version", ...FEATURE_KEYS, ...STRING_KEYS, "cacheWriteReadRatio"]);

export function findConfigPath(
	cwd = process.cwd(),
	agentDir = getAgentDir(),
	allowProjectConfig = false,
): string | undefined {
	if (allowProjectConfig) {
		const projectPath = join(cwd, CONFIG_DIR_NAME, "context-forge.json");
		if (existsSync(projectPath)) return projectPath;
	}

	const globalPath = join(agentDir, "context-forge.json");
	return existsSync(globalPath) ? globalPath : undefined;
}

export function loadContextForgeConfig(
	cwd = process.cwd(),
	agentDir = getAgentDir(),
	allowProjectConfig = false,
): ContextForgeConfig {
	const path = findConfigPath(cwd, agentDir, allowProjectConfig);
	if (!path) return DEFAULT_CONFIG;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read context-forge config ${path}: ${reason}`);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`context-forge config must be a JSON object: ${path}`);
	}

	const record = parsed as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!CONFIG_KEYS.has(key)) throw new Error(`Unknown context-forge config key: ${key}`);
	}
	if (record.version !== 1) throw new Error(`context-forge config version must be 1: ${path}`);

	for (const key of FEATURE_KEYS) {
		if (record[key] !== undefined && typeof record[key] !== "boolean") {
			throw new Error(`context-forge config ${key} must be boolean: ${path}`);
		}
	}
	const cacheWriteReadRatio = Object.hasOwn(record, "cacheWriteReadRatio")
		? record.cacheWriteReadRatio
		: DEFAULT_CACHE_WRITE_READ_RATIO;
	if (
		typeof cacheWriteReadRatio !== "number" ||
		!Number.isFinite(cacheWriteReadRatio) ||
		cacheWriteReadRatio < 0
	) {
		throw new Error(`context-forge config cacheWriteReadRatio must be a finite non-negative number: ${path}`);
	}
	const evidencePreservingReducerModel = stringConfigValue(
		record,
		"evidencePreservingReducerModel",
		DEFAULT_REDUCER_MODEL,
		path,
	);
	const evidencePreservingReducerProvider = stringConfigValue(
		record,
		"evidencePreservingReducerProvider",
		DEFAULT_REDUCER_PROVIDER,
		path,
	);

	return Object.freeze({
		...DEFAULT_CONFIG,
		...record,
		cacheWriteReadRatio,
		evidencePreservingReducerModel,
		evidencePreservingReducerProvider,
	}) as ContextForgeConfig;
}

function stringConfigValue(
	record: Record<string, unknown>,
	key: (typeof STRING_KEYS)[number],
	defaultValue: string,
	path: string,
): string {
	const value = Object.hasOwn(record, key) ? record[key] : defaultValue;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`context-forge config ${key} must be a non-empty string: ${path}`);
	}
	return value;
}
