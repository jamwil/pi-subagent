import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getFinalAssistantText,
  getProcessErrorText,
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
  assert.deepEqual(result.toolErrors, ["Command exited with code 1"]);
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
