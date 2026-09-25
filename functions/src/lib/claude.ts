// Shared Claude API wrapper — forces structured JSON output via tool-calling
// (the model MUST call the one tool we give it, so its "input" is already
// parsed, schema-shaped JSON, not free text to hope-and-parse). Used by
// parseBodyScan, generateProgram, and generateMealPlan.
import Anthropic from "@anthropic-ai/sdk";
import type { ZodSchema } from "zod";
import * as logger from "firebase-functions/logger";
import { estimateCostUsd } from "./pricing";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured.");
    client = new Anthropic({ apiKey });
  }
  return client;
}

// Exported so callers that persist the model id alongside generated content
// (e.g. generateProgram.ts's `model:` field) reference this single source of
// truth instead of redeclaring the literal — a future model bump only needs
// to change it here.
export const MODEL = "claude-sonnet-4-5-20250929";

interface ExtractJsonParams<T> {
  system: string;
  userText?: string;
  pdfBase64?: string; // if provided, sent as a document content block alongside userText
  toolName: string;
  toolDescription: string;
  /** JSON-Schema (not zod) describing the tool's expected input shape — this is what constrains the model's output. */
  inputSchema: Record<string, unknown>;
  /** Zod schema used to validate the model's output server-side before trusting it. */
  validator: ZodSchema<T>;
  maxTokens?: number;
  /** Overrides the default model (e.g. to try a faster/cheaper tier for a lower-stakes call). */
  model?: string;
}

/**
 * Calls Claude with a single forced tool call and validates the result.
 * Retries once (with the validation error fed back to the model) if the
 * first attempt doesn't pass the zod validator — output is still
 * schema-constrained by the tool definition, but zod catches semantic
 * issues (e.g. an out-of-range number) the JSON Schema alone might miss.
 */
export async function extractStructuredJson<T>(params: ExtractJsonParams<T>): Promise<T> {
  const anthropic = getClient();
  const content: Array<Anthropic.Messages.TextBlockParam | Anthropic.Messages.DocumentBlockParam> = [];
  if (params.pdfBase64) {
    content.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: params.pdfBase64 },
    });
  }
  if (params.userText) {
    content.push({ type: "text", text: params.userText });
  }

  const tool: Anthropic.Messages.Tool = {
    name: params.toolName,
    description: params.toolDescription,
    input_schema: params.inputSchema as Anthropic.Messages.Tool.InputSchema,
  };

  const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content }];
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const startedAt = Date.now();
    const response = await anthropic.messages.create(
      {
        model: params.model ?? MODEL,
        max_tokens: params.maxTokens ?? 4096,
        system: params.system,
        tools: [tool],
        tool_choice: { type: "tool", name: params.toolName },
        messages,
      },
      // SDK default is 2 retries — too thin once many users onboard at once
      // and start tripping Anthropic's rate limits together. We run inside a
      // 300s-budget background job (see onProgramGenerationRequested.ts /
      // onMealPlanGenerationRequested.ts), so there's room to let the SDK's
      // built-in exponential backoff absorb a burst instead of failing fast.
      { maxRetries: 6 }
    );
    // Structured so Cloud Logging queries can answer "is our 300s function
    // timeout / 6-minute stale threshold actually fair?" — and now cost
    // questions too — from real traffic, without a one-off synthetic
    // benchmark or manual token pull.
    const model = params.model ?? MODEL;
    const inputTokens = response.usage?.input_tokens ?? null;
    const outputTokens = response.usage?.output_tokens ?? null;
    logger.info("extractStructuredJson call completed", {
      toolName: params.toolName,
      attempt,
      durationMs: Date.now() - startedAt,
      maxTokens: params.maxTokens ?? 4096,
      model,
      inputTokens,
      outputTokens,
      costUsd: estimateCostUsd(model, inputTokens, outputTokens),
      stopReason: response.stop_reason,
    });

    const toolUse = response.content.find((b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use");
    if (toolUse) {
      const parsed = params.validator.safeParse(toolUse.input);
      if (parsed.success) return parsed.data;
      lastError = parsed.error.message;
    } else {
      lastError = "Model did not return a tool call.";
    }

    // Feed the failure back as a proper assistant turn before the retry's
    // correction message -- the Anthropic API requires strictly alternating
    // user/assistant roles, so two consecutive `user` messages (the previous
    // version of this loop) get rejected with a 400 instead of retrying.
    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content: `Your previous response failed validation: ${lastError}. Please call the tool again with corrected values.`,
    });
  }

  throw new Error(`Claude output failed validation after retry: ${lastError}`);
}
