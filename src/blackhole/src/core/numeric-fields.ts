/** Shared numeric semantics and modal metadata. UI ranges are editing guides, not runtime caps. */
import type { UnifiedConfig } from "./unified-config.js";
import type { Field } from "../pi-base/settings/types.ts";
export const NUMERIC_FIELDS = [
  {
    key: "observeAfterTokens",
    type: "number",
    label: "Observer threshold",
    description:
      "Tokens accumulated since last observer run before triggering next observe",
    min: 1_000,
    max: 200_000,
    step: 1_000,
  },
  {
    key: "reflectAfterTokens",
    type: "number",
    label: "Reflect + dropper threshold",
    description:
      "Tokens accumulated since last reflect before triggering reflector and dropper",
    min: 1_000,
    max: 200_000,
    step: 1_000,
  },
  {
    key: "retainedToolOutputMaxTokens",
    type: "number",
    label: "Retained tool outputs",
    description:
      "Token budget for historical tool-output text; newest is retained first and older text remains available via recall",
    min: 0,
    max: 200_000,
    step: 1_000,
  },
  {
    key: "recallResponseMaxChars",
    type: "number",
    label: "Recall response max characters",
    description:
      "Bounds recall search/expansion responses; 0 disables the bound",
    min: 0,
    max: 2_000_000,
    step: 1_000,
  },
  {
    key: "observationsPoolMaxTokens",
    type: "number",
    label: "Observation pool max",
    description:
      "Full-fold pressure and max estimated rendered observation-line tokens in compaction output",
    min: 1_000,
    max: 200_000,
    step: 1_000,
  },
  {
    key: "reflectionsPoolMaxTokens",
    type: "number",
    label: "Reflection output max",
    description:
      "Max estimated rendered reflection-line tokens in compaction output. 0 disables the cap. Full source records remain available through recall.",
    min: 0,
    max: 200_000,
    step: 1_000,
  },
  {
    key: "observationsPoolTargetTokens",
    type: "number",
    label: "Observation pool target",
    description:
      "Target tokens after dropper prunes (defaults to half of pool max)",
    min: 500,
    max: 200_000,
    step: 500,
  },
  {
    key: "reflectorInputMaxTokens",
    type: "number",
    label: "Reflector input max",
    description:
      "Max prompt tokens for reflector model input (rolling window cap)",
    min: 1_000,
    max: 500_000,
    step: 1_000,
  },
  {
    key: "dropperInputMaxTokens",
    type: "number",
    label: "Dropper input max",
    description:
      "Max prompt tokens for dropper model input (rolling window cap)",
    min: 1_000,
    max: 500_000,
    step: 1_000,
  },
  {
    key: "observerChunkMaxTokens",
    type: "number",
    label: "Observer chunk max",
    description: "Max source entry tokens sent to observer per chunk",
    min: 1_000,
    max: 200_000,
    step: 1_000,
  },
  {
    key: "observerPreambleMaxTokens",
    type: "number",
    label: "Observer preamble max",
    description:
      "Preamble budget in manual compaction mode (0=auto-compute 30% of chunk)",
    min: 0,
    max: 100_000,
    step: 500,
  },
  {
    key: "agentMaxTurns",
    type: "number",
    label: "Max turns per agent",
    description: "Shared turn cap for background memory agents",
    min: 1,
    max: 100,
    step: 1,
  },
  {
    key: "providerIdleTimeoutMs",
    type: "number",
    label: "Provider idle timeout (ms)",
    description:
      "Body-idle timeout for background provider streams; 0 = disabled, unset = inherit pi's default",
    min: 0,
    max: 3_600_000,
    step: 1000,
  },
] as const;
export type NumericKey =
  | (typeof NUMERIC_FIELDS)[number]["key"]
  | "workerOutputMaxTokens";
export const NUMERIC_KEYS: readonly NumericKey[] = [
  ...NUMERIC_FIELDS.map((field) => field.key),
  "workerOutputMaxTokens",
];
const ZERO_ALLOWED = new Set<string>([
  "retainedToolOutputMaxTokens",
  "recallResponseMaxChars",
  "reflectionsPoolMaxTokens",
  "observerPreambleMaxTokens",
  "providerIdleTimeoutMs",
]);
export function validNumericValue(
  key: NumericKey,
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= (ZERO_ALLOWED.has(key) ? 0 : 1)
  );
}
export function numericField(
  key: (typeof NUMERIC_FIELDS)[number]["key"],
  cfg: UnifiedConfig,
): Field {
  const field = NUMERIC_FIELDS.find((field) => field.key === key)!;
  return { ...field, value: cfg[key] ?? 0 };
}

/** Keep saved/displayed targets consistent with the execution target guard. */
export function normalizePoolTarget(
  config: Pick<
    UnifiedConfig,
    "observationsPoolTargetTokens" | "observationsPoolMaxTokens"
  >,
): void {
  if (
    config.observationsPoolTargetTokens === undefined ||
    config.observationsPoolTargetTokens >= config.observationsPoolMaxTokens
  ) {
    config.observationsPoolTargetTokens = Math.floor(
      config.observationsPoolMaxTokens / 2,
    );
  }
}
