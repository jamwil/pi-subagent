import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getFinalAssistantText,
  getProcessErrorText,
  hasAttributedToolError,
  getResultSummaryText,
  processPiEvent,
  processPiJsonLine,
} from "../runner-events.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));

function makeResult() {
  return {
    agent: "oracle",
    agentSource: "user",
    prompt: "repro",
    initialContext: "empty",
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
  };
}

test("repro: captures final assistant output from agent_end after non-zero tool exit", async () => {
  const fixturePath = path.join(testDir, "fixtures", "agent-end-error-only.jsonl");
  const lines = fs.readFileSync(fixturePath, "utf8").trim().split("\n");
  const result = makeResult();

  for (const line of lines) {
    processPiJsonLine(line, result);
  }

  result.exitCode = 1;

  assert.equal(result.messages.length, 2);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Command exited with code 1");
  assert.equal(result.pendingToolError, "Command exited with code 1");
  assert.equal(result.usage.turns, 2);
  assert.equal(
    getFinalAssistantText(result.messages),
    "No matches found. The grep/rg command failed with exit code 1, which is expected here.",
  );
  assert.equal(
    getResultSummaryText(result),
    "No matches found. The grep/rg command failed with exit code 1, which is expected here.",
  );
});

test("deduplicates assistant messages repeated across message_end, turn_end, and agent_end", () => {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "Still here" }],
    model: "test-model",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 1,
  };

  const result = makeResult();
  processPiEvent({ type: "message_end", message }, result);
  processPiEvent({ type: "turn_end", message, toolResults: [] }, result);
  processPiEvent({ type: "agent_end", messages: [message] }, result);

  assert.equal(result.messages.length, 1);
  assert.equal(result.usage.turns, 1);
  assert.equal(result.usage.input, 1);
  assert.equal(result.usage.output, 2);
  assert.equal(result.sawAgentEnd, true);
});

test("returns every text block from the latest assistant message containing text", () => {
  const result = makeResult();
  result.messages.push(
    {
      role: "assistant",
      content: [{ type: "text", text: "Earlier" }],
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "First section\n" },
        { type: "thinking", thinking: "hidden" },
        { type: "toolCall", id: "call-1", name: "read", arguments: {} },
        { type: "text", text: "" },
        { type: "text", text: "Final conclusion" },
      ],
      timestamp: 2,
    },
  );

  assert.equal(getFinalAssistantText(result.messages), "First section\nFinal conclusion");
  assert.equal(getResultSummaryText(result), "First section\nFinal conclusion");
});

test("falls back to the latest assistant message that contains text", () => {
  const result = makeResult();
  result.messages.push(
    {
      role: "assistant",
      content: [{ type: "text", text: "Complete answer" }],
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "unfinished" }],
      timestamp: 2,
    },
  );

  assert.equal(getFinalAssistantText(result.messages), "Complete answer");
});

test("records successful RPC prompt acceptance", () => {
  const result = makeResult();
  processPiEvent({ type: "response", command: "prompt", success: true }, result);
  assert.equal(result.rpcPromptAccepted, true);
});

test("records agent settlement separately from low-level agent_end", () => {
  const result = makeResult();
  processPiEvent({ type: "agent_end", messages: [] }, result);
  assert.equal(result.sawAgentEnd, true);
  assert.equal(result.sawAgentSettled, undefined);

  processPiEvent({ type: "agent_settled" }, result);
  assert.equal(result.sawAgentSettled, true);
});

test("deeply nested assistant content becomes a process error instead of throwing", () => {
  const result = makeResult();
  let nested = {};
  for (let index = 0; index < 20_000; index++) nested = { nested };
  const message = {
    role: "assistant",
    content: [{ type: "toolCall", id: "deep", name: "test", arguments: nested }],
    timestamp: 1,
  };

  assert.doesNotThrow(() => processPiEvent({ type: "message_end", message }, result));
  assert.equal(result.processError, true);
  assert.match(result.errorMessage, /safely capture/);
});

test("bounds retained assistant messages and reports capture truncation", () => {
  const result = makeResult();
  const oversized = {
    role: "assistant",
    content: [{ type: "toolCall", id: "large", name: "test", arguments: { value: "x".repeat(5 * 1024 * 1024) } }],
    timestamp: 1,
  };

  processPiEvent({ type: "message_end", message: oversized }, result);
  processPiEvent({
    type: "message_end",
    message: { ...oversized, timestamp: 2 },
  }, result);

  assert.equal(result.messages.length, 0);
  assert.equal(result.__seenMessageSignatures?.size ?? 0, 0);
  assert.equal(result.captureTruncated, true);
  assert.match(getResultSummaryText(result), /capture limit/);
});

test("keeps usage exact when capture eviction allows terminal messages to be revisited", () => {
  const result = makeResult();
  const makeMessage = (text, timestamp) => ({
    role: "assistant",
    content: [{ type: "text", text: text.repeat(3 * 1024 * 1024) }],
    timestamp,
    usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 5, cost: { total: 0.5 } },
  });
  const first = makeMessage("a", 1);
  const second = makeMessage("b", 2);

  processPiEvent({ type: "agent_start" }, result);
  processPiEvent({ type: "message_end", message: first }, result);
  processPiEvent({ type: "message_end", message: second }, result);
  processPiEvent({ type: "agent_end", messages: [first, second] }, result);

  assert.deepEqual(result.usage, {
    input: 2,
    output: 4,
    cacheRead: 6,
    cacheWrite: 8,
    cost: 1,
    contextTokens: 5,
    turns: 2,
  });
});

test("bounds message deduplication independently of retained output", () => {
  const result = makeResult();
  for (let index = 0; index < 8_300; index++) {
    processPiEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `message-${index}` }],
        timestamp: index,
      },
    }, result);
  }

  assert.equal(result.__seenMessageSignatures.size, 8_192);
});

test("retains bounded text from an oversized final assistant response", () => {
  const result = makeResult();
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "x".repeat(6 * 1024 * 1024) }],
    stopReason: "stop",
    timestamp: 1,
  };

  processPiEvent({ type: "agent_end", messages: [message] }, result);

  assert.equal(result.sawAgentEnd, true);
  assert.equal(result.messages.length, 1);
  assert.equal(result.captureTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result.messages[0]), "utf8") <= 5 * 1024 * 1024);
  assert.match(getFinalAssistantText(result.messages), /\[Subagent response truncated during capture\]$/);
});

test("non-zero exit code does not hide the final assistant text", () => {
  const result = makeResult();
  result.exitCode = 1;
  result.errorMessage = "Command exited with code 1";
  result.stderr = "stderr noise that should be a fallback only";
  result.messages.push({
    role: "assistant",
    content: [{ type: "text", text: "No matches found" }],
    timestamp: 1,
  });

  assert.equal(getResultSummaryText(result), "No matches found");
});

test("stderr remains a fallback only for error results", () => {
  const okResult = makeResult();
  okResult.exitCode = 0;
  okResult.stderr = "warning on stderr";
  assert.equal(getResultSummaryText(okResult), "(no output)");

  const failedResult = makeResult();
  failedResult.exitCode = 1;
  failedResult.stderr = "warning on stderr";
  assert.equal(getResultSummaryText(failedResult), "warning on stderr");
});

test("later assistant events invalidate pending tool-error attribution", () => {
  const result = makeResult();
  processPiEvent(
    {
      type: "tool_execution_end",
      isError: true,
      result: { content: [{ type: "text", text: "Connection reset" }] },
    },
    result,
  );
  assert.equal(result.pendingToolError, "Connection reset");

  const message = {
    role: "assistant",
    content: [{ type: "text", text: "Partial answer" }],
    stopReason: "error",
    errorMessage: "Connection reset",
    timestamp: 1,
  };
  processPiEvent({ type: "message_end", message }, result);
  processPiEvent({ type: "agent_end", messages: [message] }, result);

  assert.equal(result.pendingToolError, undefined);
  assert.equal(hasAttributedToolError(result), false);
});

test("provider errors remain visible alongside partial assistant text", () => {
  const result = makeResult();
  result.exitCode = 0;
  result.sawAgentEnd = true;
  result.stopReason = "error";
  result.errorMessage = "Connection reset while streaming";
  result.messages.push({
    role: "assistant",
    content: [{ type: "text", text: "Partial answer" }],
    timestamp: 1,
  });

  assert.equal(
    getResultSummaryText(result),
    "Partial answer\n\nSubagent error: Connection reset while streaming",
  );
});

test("process errors remain visible alongside final assistant text", () => {
  const result = makeResult();
  result.exitCode = 1;
  result.processError = true;
  result.errorMessage = "Named session did not exit.";
  result.messages.push({
    role: "assistant",
    content: [{ type: "text", text: "Done" }],
    timestamp: 1,
  });

  assert.equal(
    getProcessErrorText(result),
    "Subagent process error after completion: Named session did not exit.",
  );
  assert.equal(
    getResultSummaryText(result),
    "Done\n\nSubagent process error after completion: Named session did not exit.",
  );
});
