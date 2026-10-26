/**
 * Observer tool schema, factored out of agent.ts so the consolidation stage
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
import type { Relevance } from "../../ledger/index.js";

export const OBSERVATION_TIMESTAMP_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$";

export const RecordObservationsSchema = {
  type: "object",
  properties: {
    observations: {
      type: "array",
      description:
        "Batch of new observations. May be empty only alongside complete=true, " +
        "which closes a run that found nothing new.",
      items: {
        type: "object",
        required: ["content", "relevance", "sourceEntryIds"],
        properties: {
          content: {
            type: "string",
            minLength: 1,
            description: "Single-line plain prose. No markdown, no tags, no embedded timestamp.",
          },
          relevance: {
            type: "string",
            enum: ["low", "medium", "high", "critical"],
          },
          sourceEntryIds: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
            description:
              "Exact source entry ids from the chunk that directly support this observation. " +
              "Use only ids shown in '[Source entry id: ...]' labels; never invent ids.",
          },
        },
      },
    },
    // Optional on purpose: a model that omits the flag must lose only the
    // early-stop hint, never the batch itself (a required field would fail
    // host-side validation and drop every observation in the call).
    complete: {
      type: "boolean",
      description:
        "Whether this batch completes chunk coverage. Set false when more observations or corrections remain.",
    },
  },
  required: ["observations"],
};

export interface RecordObservationsArgs {
  observations: {
    content: string;
    relevance: Relevance;
    sourceEntryIds: string[];
  }[];
  complete?: boolean;
}