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
  readonly projectMemory: boolean;
}

export const FORGE_FIELDS = [
  {
    key: "actionFusion",
    label: "Action fusion",
    kind: "boolean",
    defaultValue: true,
  },
  {
    key: "observationPack",
    label: "Observation pack",
    kind: "boolean",
    defaultValue: true,
  },
  {
    key: "evidencePreservingReducer",
    label: "Evidence-preserving reducer",
    kind: "boolean",
    defaultValue: false,
  },
  {
    key: "onlineContextCompact",
    label: "Online context compact",
    kind: "boolean",
    defaultValue: true,
  },
  {
    key: "observationalMemory",
    label: "Observational memory",
    kind: "boolean",
    defaultValue: true,
  },
  {
    key: "vccCompaction",
    label: "VCC compaction",
    kind: "boolean",
    defaultValue: true,
  },
  {
    key: "unifiedRecall",
    label: "Unified recall",
    kind: "boolean",
    defaultValue: true,
  },
  {
    key: "projectMemory",
    label: "Project memory",
    kind: "boolean",
    defaultValue: true,
  },
  {
    key: "evidencePreservingReducerModel",
    label: "Reducer model",
    kind: "string",
    defaultValue: DEFAULT_REDUCER_MODEL,
  },
  {
    key: "evidencePreservingReducerProvider",
    label: "Reducer provider",
    kind: "string",
    defaultValue: DEFAULT_REDUCER_PROVIDER,
  },
  {
    key: "cacheWriteReadRatio",
    label: "Cache write/read ratio",
    kind: "number",
    defaultValue: DEFAULT_CACHE_WRITE_READ_RATIO,
  },
] as const;
export type ForgeField = (typeof FORGE_FIELDS)[number];
export const DEFAULT_CONFIG: ContextForgeConfig = Object.freeze({
  version: 1,
  ...Object.fromEntries(
    FORGE_FIELDS.map((field) => [field.key, field.defaultValue]),
  ),
}) as ContextForgeConfig;
const CONFIG_KEYS = new Set<string>([
  "version",
  ...FORGE_FIELDS.map((field) => field.key),
]);

export function validForgeValue(field: ForgeField, value: unknown): boolean {
  if (field.kind === "boolean") return typeof value === "boolean";
  if (field.kind === "string")
    return typeof value === "string" && value.trim().length > 0;
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

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
    if (!CONFIG_KEYS.has(key))
      throw new Error(`Unknown context-forge config key: ${key}`);
  }
  if (record.version !== 1)
    throw new Error(`context-forge config version must be 1: ${path}`);

  for (const field of FORGE_FIELDS) {
    if (
      record[field.key] !== undefined &&
      !validForgeValue(field, record[field.key])
    ) {
      const expected =
        field.kind === "number"
          ? "a finite non-negative number"
          : field.kind === "string"
            ? "a non-empty string"
            : "boolean";
      throw new Error(
        `context-forge config ${field.key} must be ${expected}: ${path}`,
      );
    }
  }
  return Object.freeze({ ...DEFAULT_CONFIG, ...record }) as ContextForgeConfig;
}
