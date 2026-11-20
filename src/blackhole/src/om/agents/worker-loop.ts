import { agentLoop, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { CacheRetention, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../model-budget.js";
import { createBridgeStreamFn, createProviderFetch, neverThrow, type ProviderFetchOption } from "../provider-stream.js";
import { withDiscardedCount } from "../retryable-error.js";
import { buildAgentContext } from "./agent-context.js";
import { agentCompletionError, agentFailureStopReason } from "./completion.js";
import { createTurnCap, type LegacyTurnCapOption } from "./turn-cap.js";

export interface WorkerLoopOptions {
  model: Model<any>;
  apiKey: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  signal?: AbortSignal;
  agentLoop?: typeof agentLoop;
  streamFn?: Parameters<typeof agentLoop>[4];
  maxTurns?: number;
  /** Must match the output allowance reserved during stage preflight. */
  maxOutputTokens?: number;
  thinkingLevel?: ModelThinkingLevel;
  providerIdleTimeoutMs?: number;
  modelRegistry?: Parameters<typeof createBridgeStreamFn>[1];
  sessionId?: string;
  cacheRetention?: CacheRetention;
}

interface WorkerCompletion {
  closedByCompleteBatch: () => boolean;
  recordedCount: () => number;
  /** Some hosts ignore tool-result termination. Enforce the dropper close in both turn hooks. */
  shouldStop?: () => boolean;
}

export async function runWorkerLoop(
  options: WorkerLoopOptions,
  systemPrompt: string,
  tool: AgentTool<any>,
  userText: string,
  completion: WorkerCompletion,
) {
  const { model, apiKey, headers, env, signal, sessionId, cacheRetention, maxTurns } = options;
  const prompts: Message[] = [{
    role: "user",
    content: [{ type: "text", text: userText }],
    timestamp: Date.now(),
  }];
  const context = buildAgentContext(systemPrompt, [tool]);
  const turnCap = maxTurns && maxTurns > 0 ? createTurnCap(maxTurns) : undefined;
  const providerFetch = createProviderFetch(options.providerIdleTimeoutMs);
  const thinkingLevel = options.thinkingLevel ?? "low";
  const outputLimit = options.maxOutputTokens;
  // Floor before clamping so a fractional override can never send maxTokens: 0.
  const maxTokens = typeof outputLimit === "number" && Number.isFinite(outputLimit) && outputLimit > 0
    ? Math.max(1, Math.floor(outputLimit))
    : boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS);

  const config: AgentLoopConfig & ProviderFetchOption & LegacyTurnCapOption = {
    model,
    apiKey,
    headers,
    env,
    ...(sessionId ? { sessionId } : {}),
    ...(cacheRetention ? { cacheRetention } : {}),
    ...(providerFetch ? { fetch: providerFetch } : {}),
    maxTokens,
    convertToLlm: (messages) => messages as Message[],
    toolExecution: "sequential",
    ...(model.reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
  };
  const shouldStop = completion.shouldStop;
  if (shouldStop) {
    config.shouldStopAfterTurn = (turn) => shouldStop() || (turnCap?.shouldStopAfterTurn(turn) ?? false);
    config.finishTurn = (turn) => shouldStop() ? { action: "end" } : turnCap?.finishTurn(turn);
  } else if (turnCap) {
    config.shouldStopAfterTurn = turnCap.shouldStopAfterTurn;
    config.finishTurn = turnCap.finishTurn;
  }

  // Jiti-loaded workers need the host's provider registry. Convert bridge
  // failures to stream errors so the host's fire-and-forget loop can settle.
  const loop = options.agentLoop ?? agentLoop;
  const streamFn = neverThrow(options.streamFn ?? createBridgeStreamFn(streamSimple, options.modelRegistry));
  const stream = loop(prompts, context, config, signal, streamFn);
  let agentError: string | undefined;
  let failureKind: string | undefined;
  try {
    for await (const event of stream) {
      if (event.type !== "agent_end") continue;
      const messages = (event.messages ?? []) as Array<{ stopReason?: string; errorMessage?: string }>;
      agentError = agentCompletionError(messages, signal, completion.closedByCompleteBatch() || turnCap?.exhausted);
      failureKind = agentFailureStopReason(messages);
    }
    await stream.result();
  } catch (error) {
    throw withDiscardedCount(error, completion.recordedCount());
  }

  return { agentError, failureKind, turnCapExhausted: turnCap?.exhausted ?? false };
}
