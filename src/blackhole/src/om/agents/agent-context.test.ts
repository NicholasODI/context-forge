/**
 * Regression for the confirmed observer failure:
 * SyntaxError: JSON Parse error: Unexpected identifier "undefined".
 *
 * pi-ai's toToolDeclaration round-trips `parameters` through
 * JSON.parse(JSON.stringify(...)); an undefined schema is exactly
 * JSON.parse("undefined"), the native Bun error above, thrown at declaration
 * time before any model call. buildAgentContext must fail at the boundary
 * naming the tool instead of through that framework path.
 */
import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import {
  buildAgentContext,
  supportsTranscriptSystemMessages,
} from "./agent-context";
import type { AgentContext, AgentTool } from "@earendil-works/pi-agent-core";

function toolMissingParameters(): AgentTool<any> {
  return {
    name: "record_observations",
    label: "Record observations",
    description: "broken test tool",
    parameters: undefined,
    // `content` elements are the only ones consumed here.
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  } as unknown as AgentTool<any>;
}

function toolNonObjectParameters(): AgentTool<any> {
  return {
    name: "broken",
    label: "Broken",
    description: "non-object schema",
    parameters: "not-a-schema",
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  } as unknown as AgentTool<any>;
}

function validTool(): AgentTool<any> {
  const NoteSchema = Type.Object({
    note: Type.String({ minLength: 1 }),
  });
  return {
    name: "note",
    label: "Note",
    description: "working test tool",
    parameters: NoteSchema,
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  } as unknown as AgentTool<any>;
}

function plainLiteralTool(): AgentTool<any> {
  return {
    name: "note2",
    label: "Note2",
    description: "plain literal test tool",
    parameters: {
      type: "object",
      properties: { note: { type: "string", minLength: 1 } },
      required: ["note"],
    },
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  } as unknown as AgentTool<any>;
}

describe("buildAgentContext tool schema guard", () => {
  it("throws naming the tool when its parameters schema is undefined", () => {
    expect(() => buildAgentContext("SYSTEM", [toolMissingParameters()])).toThrowError(
      /tool "record_observations" has no usable parameters schema \(got undefined\)/,
    );
  });

  it("throws naming the tool when its parameters schema is not a JSON object", () => {
    expect(() => buildAgentContext("SYSTEM", [toolNonObjectParameters()])).toThrowError(
      /tool "broken" has no usable parameters schema \(got string\)/,
    );
  });

  it("keeps an intact TypeBox schema usable through the declaration conversion", () => {
    const tools = [validTool()];
    const context = buildAgentContext("SYSTEM", tools) as AgentContext;
    expect(context.tools).toBe(tools);
    if (supportsTranscriptSystemMessages()) {
      const system = (context.messages as Record<string, unknown>[])?.[0] as {
        role?: string;
        toolsAdded?: Array<{ name?: string; parameters?: unknown }>;
      } | undefined;
      expect(system?.role).toBe("system");
      const declaration = system?.toolsAdded?.[0];
      // The exact pi-ai call the confirmed run crashed at: round-trip the
      // declared schema the way toToolDeclaration does.
      const roundTripped = JSON.parse(JSON.stringify(declaration?.parameters)) as {
        properties?: Record<string, { type?: string }>;
      };
      expect(declaration?.name).toBe("note");
      expect(roundTripped.properties?.note?.type).toBe("string");
    }
  });

  it("keeps a plain JSON literal schema usable (the shape the shipped tools now use)", () => {
    const tools = [plainLiteralTool()];
    const context = buildAgentContext("SYSTEM", tools) as AgentContext;
    expect(context.tools).toBe(tools);
    if (supportsTranscriptSystemMessages()) {
      const system = (context.messages as Record<string, unknown>[])?.[0] as {
        role?: string;
        toolsAdded?: Array<{ name?: string; parameters?: unknown }>;
      } | undefined;
      expect(system?.role).toBe("system");
      const declaration = system?.toolsAdded?.[0];
      const roundTripped = JSON.parse(JSON.stringify(declaration?.parameters)) as {
        type?: string;
        properties?: Record<string, { type?: string; minLength?: number }>;
      };
      expect(declaration?.name).toBe("note2");
      expect(roundTripped.type).toBe("object");
      expect(roundTripped.properties?.note?.type).toBe("string");
      expect(roundTripped.properties?.note?.minLength).toBe(1);
    }
  });
});