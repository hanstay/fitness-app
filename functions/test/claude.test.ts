// Unit tests for extractStructuredJson's retry-after-validation-failure path.
// The Anthropic SDK is mocked at the module boundary — this tests message
// construction, not real API behavior. Regression coverage for a bug where
// a failed tool_use was followed by a plain-text user message instead of a
// tool_result block, which the real API rejects with a 400.
import { vi, describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";

const mockCreate = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

import { extractStructuredJson } from "../src/lib/claude";

const schema = z.object({ value: z.number().min(0) });

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe("extractStructuredJson", () => {
  it("follows a failed tool_use with a tool_result block, not plain text, on retry", async () => {
    const badToolUse = {
      type: "tool_use" as const,
      id: "toolu_test123",
      name: "record_thing",
      input: { value: -1 }, // fails the zod validator (min(0))
    };
    const goodToolUse = {
      type: "tool_use" as const,
      id: "toolu_test456",
      name: "record_thing",
      input: { value: 5 },
    };
    mockCreate
      .mockResolvedValueOnce({ content: [badToolUse], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 } })
      .mockResolvedValueOnce({ content: [goodToolUse], stop_reason: "tool_use", usage: { input_tokens: 12, output_tokens: 5 } });

    const result = await extractStructuredJson({
      system: "sys",
      userText: "hi",
      toolName: "record_thing",
      toolDescription: "desc",
      inputSchema: { type: "object", properties: { value: { type: "number" } } },
      validator: schema,
    });

    expect(result).toEqual({ value: 5 });
    expect(mockCreate).toHaveBeenCalledTimes(2);

    const secondCallMessages = mockCreate.mock.calls[1][0].messages;
    // [0] original user turn, [1] assistant tool_use turn, [2] the retry message.
    const retryMessage = secondCallMessages[2];
    expect(retryMessage.role).toBe("user");
    expect(Array.isArray(retryMessage.content)).toBe(true);
    const toolResult = retryMessage.content.find((b: { type: string }) => b.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult.tool_use_id).toBe("toolu_test123");
    expect(toolResult.is_error).toBe(true);
  });

  it("retries with plain text (no tool_result needed) when the model didn't call the tool at all", async () => {
    mockCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "I refuse." }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } })
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "toolu_test789", name: "record_thing", input: { value: 1 } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 12, output_tokens: 5 },
      });

    const result = await extractStructuredJson({
      system: "sys",
      userText: "hi",
      toolName: "record_thing",
      toolDescription: "desc",
      inputSchema: { type: "object", properties: { value: { type: "number" } } },
      validator: schema,
    });

    expect(result).toEqual({ value: 1 });
    const secondCallMessages = mockCreate.mock.calls[1][0].messages;
    expect(secondCallMessages[2].role).toBe("user");
    expect(typeof secondCallMessages[2].content).toBe("string");
  });

  it("requests the tool via auto tool_choice and no extended thinking (current models reject forced tool_choice)", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", id: "toolu_a", name: "record_thing", input: { value: 1 } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await extractStructuredJson({
      system: "sys",
      userText: "hi",
      toolName: "record_thing",
      toolDescription: "desc",
      inputSchema: { type: "object", properties: { value: { type: "number" } } },
      validator: schema,
    });

    const req = mockCreate.mock.calls[0][0];
    expect(req.model).toBe("claude-sonnet-5-5");
    expect(req.tool_choice).toEqual({ type: "auto" });
    expect(req.thinking).toEqual({ type: "between_tools" });
    expect(req.system).toContain("record_thing");
  });

  it("retries a response cut off at max_tokens from scratch with double the limit", async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "toolu_cut", name: "record_thing", input: {} }],
        stop_reason: "max_tokens",
        usage: { input_tokens: 10, output_tokens: 3000 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "toolu_ok", name: "record_thing", input: { value: 2 } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 3500 },
      });

    const result = await extractStructuredJson({
      system: "sys",
      userText: "hi",
      toolName: "record_thing",
      toolDescription: "desc",
      inputSchema: { type: "object", properties: { value: { type: "number" } } },
      validator: schema,
      maxTokens: 3000,
    });

    expect(result).toEqual({ value: 2 });
    expect(mockCreate.mock.calls[0][0].max_tokens).toBe(3000);
    expect(mockCreate.mock.calls[1][0].max_tokens).toBe(6000);
    // No truncated assistant turn or correction message carried into the retry.
    expect(mockCreate.mock.calls[1][0].messages).toHaveLength(1);
  });

  it("caps the retried max_tokens at 16000", async () => {
    mockCreate.mockResolvedValue({ content: [], stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 1 } });

    await expect(
      extractStructuredJson({
        system: "sys",
        userText: "hi",
        toolName: "record_thing",
        toolDescription: "desc",
        inputSchema: { type: "object", properties: { value: { type: "number" } } },
        validator: schema,
        maxTokens: 12000,
      })
    ).rejects.toThrow(/max_tokens/);
    expect(mockCreate.mock.calls[1][0].max_tokens).toBe(16000);
  });

  it("fails fast on a refusal instead of retrying", async () => {
    mockCreate.mockResolvedValueOnce({ content: [], stop_reason: "refusal", usage: { input_tokens: 1, output_tokens: 0 } });

    await expect(
      extractStructuredJson({
        system: "sys",
        userText: "hi",
        toolName: "record_thing",
        toolDescription: "desc",
        inputSchema: { type: "object", properties: { value: { type: "number" } } },
        validator: schema,
      })
    ).rejects.toThrow(/refusal/);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
