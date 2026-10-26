/**
 * Reflector tool schema, factored out of agent.ts so the consolidation stage
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
export const RecordReflectionsSchema = {
  type: "object",
  properties: {
    reflections: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["content", "supportingObservationIds"],
        properties: {
          content: { type: "string", minLength: 1 },
          supportingObservationIds: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
        },
      },
    },
    // Optional on purpose: a model that omits the flag must lose only the
    // early-stop hint, never the batch itself (a required field would fail
    // host-side validation and drop every reflection in the call).
    complete: {
      type: "boolean",
      description:
        "Whether this batch completes reflection review. Set false when more reflections or corrections remain.",
    },
  },
  required: ["reflections"],
};

export interface RecordReflectionsArgs {
  reflections: {
    content: string;
    supportingObservationIds: string[];
  }[];
  complete?: boolean;
}