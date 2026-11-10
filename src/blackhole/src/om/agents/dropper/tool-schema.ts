/**
 * Dropper tool schema, factored out of agent.ts so the consolidation stage
 * can measure the exact serialized schema as part of the worker prompt budget
 * (src/om/prompt-budget.ts) without importing the agent loop. Single source
 * of truth: the agent builds its tool from these same objects.
 *
 * Plain JSON Schema on purpose, not typebox: pi-ai consumes `parameters` as
 * plain JSON (toToolDeclaration round-trips it through
 * JSON.parse(JSON.stringify(...)), and validateToolArguments has a plain-schema
 * branch). typebox's `Type.Object` evaluated to a function under the extension
 * worker's virtual-module loader, which made that round-trip throw
 * (JSON Parse error: Unexpected identifier "undefined") at declaration time,
 * before any model call. Keep this an object literal.
 */
export const DropObservationsSchema = {
  type: "object",
  properties: {
    ids: {
      type: "array",
      minItems: 1,
      maxItems: 128,
      items: { type: "string", minLength: 1 },
    },
    // Required for an auditable removal; omitted reasons cannot authorize drops.
    reason: { type: "string", minLength: 1, maxLength: 1000 },
    replacements: {
      type: "object",
      description: "For each proposed observation ID, give IDs of provided reflections that preserve it with equivalent fidelity.",
      additionalProperties: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
    },
  },
  required: ["ids", "replacements", "reason"],
};

export interface DropObservationsArgs {
  ids: string[];
  reason: string;
  replacements: Record<string, string[]>;
}
