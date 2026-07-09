import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isResultError, isResultSuccess, normalizeCompletedResult } from "../types.ts";

function createTestableRunnerModule() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-runner-"));
  const modulePath = path.join(tmpDir, "runner.testable.ts");
  const source = fs
    .readFileSync(path.join(process.cwd(), "runner.ts"), "utf-8")
    .replace(
      'from "@earendil-works/pi-coding-agent"',
      `from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href)}`,
    )
    .replace('from "./runner-cli.js"', `from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "runner-cli.js")).href)}`)
    .replace('from "./runner-events.js"', `from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "runner-events.js")).href)}`)
    .replace('from "./types.js"', `from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "types.ts")).href)}`);
  fs.writeFileSync(modulePath, source);
  return {
    moduleUrl: pathToFileURL(modulePath).href,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function makeResult(overrides = {}) {
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
    ...overrides,
  };
}

test("normalizeCompletedResult keeps intermediate assistant output as a failure without agent_end", () => {
  const result = makeResult({
    exitCode: 1,
    stopReason: "error",
    errorMessage: "Command exited with code 1",
    stderr: "Command exited with code 1",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Let me check that for you." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Command exited with code 1");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("normalizeCompletedResult treats agent_end with final assistant output as semantic success", () => {
  const result = makeResult({
    exitCode: 1,
    stopReason: "error",
    errorMessage: "Command exited with code 1",
    stderr: "Command exited with code 1",
    sawAgentEnd: true,
    pendingToolError: "Command exited with code 1",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "No matches found; exit code 1 was expected." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stopReason, undefined);
  assert.equal(result.errorMessage, undefined);
  assert.equal(isResultSuccess(result), true);
  assert.equal(isResultError(result), false);
});

test("normalizeCompletedResult preserves provider failures after partial output", () => {
  for (const exitCode of [0, 1]) {
    const result = makeResult({
      exitCode,
      stopReason: "error",
      errorMessage: "Connection reset while streaming",
      stderr: "Connection reset while streaming",
      sawAgentEnd: true,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Partial answer" }],
          timestamp: 1,
        },
      ],
    });

    normalizeCompletedResult(result, false);

    assert.equal(isResultSuccess(result), false);
    assert.equal(isResultError(result), true);
    assert.equal(result.stopReason, "error");
    assert.equal(result.errorMessage, "Connection reset while streaming");
  }
});

test("normalizeCompletedResult keeps aborted provider output as a failure", () => {
  const result = makeResult({
    exitCode: 0,
    stopReason: "aborted",
    errorMessage: "Request aborted",
    sawAgentEnd: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Partial answer" }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, false);

  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("normalizeCompletedResult preserves process-level errors despite semantic completion", () => {
  const result = makeResult({
    exitCode: 1,
    processError: true,
    stopReason: "error",
    errorMessage: "Named subagent session did not exit.",
    stderr: "Named subagent session did not exit.",
    sawAgentEnd: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Named subagent session did not exit.");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("normalizeCompletedResult does not mask process-level errors on abort", () => {
  const result = makeResult({
    exitCode: 1,
    processError: true,
    stopReason: "error",
    errorMessage: "Named subagent session did not exit.",
    stderr: "Named subagent session did not exit.",
    sawAgentEnd: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, true);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Named subagent session did not exit.");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("normalizeCompletedResult preserves settled completion when teardown is aborted", () => {
  const result = makeResult({
    exitCode: 130,
    stopReason: "aborted",
    errorMessage: "Subagent was aborted.",
    stderr: "Subagent was aborted.",
    sawAgentEnd: true,
    sawAgentSettled: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, true);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stopReason, undefined);
  assert.equal(result.errorMessage, undefined);
  assert.equal(isResultSuccess(result), true);
  assert.equal(isResultError(result), false);
});

test("normalizeCompletedResult rejects aborted intermediate agent_end output", () => {
  const result = makeResult({
    exitCode: 130,
    stopReason: "stop",
    sawAgentEnd: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Intermediate answer" }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, true);

  assert.equal(result.exitCode, 130);
  assert.equal(result.stopReason, "aborted");
  assert.equal(isResultError(result), true);
});

test("normalizeCompletedResult keeps aborts as errors without semantic completion", () => {
  const result = makeResult({
    exitCode: 130,
    stderr: "",
  });

  normalizeCompletedResult(result, true);

  assert.equal(result.exitCode, 130);
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.errorMessage, "Subagent was aborted.");
  assert.equal(result.stderr, "Subagent was aborted.");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("clean process exit without agent completion is a failure", () => {
  const result = makeResult({ exitCode: 0 });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /without completing an agent run/);
  assert.equal(isResultError(result), true);
});

test("running results are neither success nor error", () => {
  const result = makeResult({ exitCode: -1 });

  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), false);
});

test("classifies only unexpected signal exits as process failures", async () => {
  const { moduleUrl, cleanup } = createTestableRunnerModule();
  try {
    const { getUnexpectedSignalFailure } = await import(moduleUrl);

    const failure = getUnexpectedSignalFailure(null, "SIGTERM", false, undefined);
    assert.ok(failure);
    assert.equal(failure.exitCode > 0, true);
    assert.match(failure.message, /SIGTERM/);

    assert.equal(getUnexpectedSignalFailure(1, null, false, undefined), null);
    assert.equal(getUnexpectedSignalFailure(null, "SIGTERM", true, undefined), null);
    assert.equal(getUnexpectedSignalFailure(null, "SIGTERM", false, 1), null);
  } finally {
    cleanup();
  }
});

test("rewriteSessionHeaderCwd updates only the session header cwd", async () => {
  const { moduleUrl, cleanup } = createTestableRunnerModule();
  try {
    const { rewriteSessionHeaderCwd } = await import(moduleUrl);
    const input = [
      JSON.stringify({ type: "session", id: "parent", cwd: "/old", version: 3 }),
      JSON.stringify({ type: "message", id: "a", parentId: null, message: { role: "user", content: "hi" } }),
      "",
    ].join("\n");

    const output = rewriteSessionHeaderCwd(input, "/new");
    assert.ok(output);
    const lines = output.trimEnd().split("\n");
    assert.deepEqual(JSON.parse(lines[0]), {
      type: "session",
      id: "parent",
      cwd: "/new",
      version: 3,
    });
    assert.equal(JSON.parse(lines[1]).message.content, "hi");
  } finally {
    cleanup();
  }
});

test("runAgent returns immediately when the signal is already aborted", async () => {
  const { moduleUrl, cleanup } = createTestableRunnerModule();
  try {
    const { runAgent } = await import(moduleUrl);
    const controller = new AbortController();
    controller.abort();

    const result = await runAgent({
      cwd: process.cwd(),
      agents: [
        {
          name: "review",
          description: "reviewer",
          source: "user",
          systemPrompt: "",
        },
      ],
      callIndex: 0,
      agentName: "review",
      prompt: "hello",
      initialContext: "empty",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: true,
      signal: controller.signal,
      makeDetails: (results) => ({ projectAgentsDir: null, results }),
    });

    assert.equal(result.exitCode, 130);
    assert.equal(result.stopReason, "aborted");
    assert.equal(result.errorMessage, "Subagent was aborted.");
  } finally {
    cleanup();
  }
});

test("runAgent converts synchronous spawn failures into structured results", async () => {
  const { moduleUrl, cleanup } = createTestableRunnerModule();
  try {
    const { runAgent } = await import(moduleUrl);
    const result = await runAgent({
      cwd: process.cwd(),
      agents: [
        {
          name: "invalid-model",
          description: "invalid model",
          source: "user",
          systemPrompt: "",
          model: "bad\0model",
        },
      ],
      callIndex: 0,
      agentName: "invalid-model",
      prompt: "hello",
      initialContext: "empty",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: true,
      makeDetails: (items) => ({ kind: "pi-subagent", projectAgentsDir: null, results: items }),
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.processError, true);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage, /null bytes|invalid/i);
  } finally {
    cleanup();
  }
});

test("runAgent waits for agent_settled across multiple low-level runs", () => {
  const { moduleUrl, cleanup } = createTestableRunnerModule();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-settled-"));
  const harnessPath = path.join(tmpDir, "settled-harness.mjs");

  fs.writeFileSync(
    harnessPath,
    `if (process.argv.includes("--mode")) {
      const intermediate = { role: "assistant", content: [{ type: "text", text: "intermediate" }], stopReason: "stop", timestamp: 1 };
      process.stdout.write(JSON.stringify({ type: "agent_end", messages: [intermediate] }) + "\\n");
      await new Promise((resolve) => setTimeout(resolve, 400));
      const final = { role: "assistant", content: [{ type: "text", text: "final" }], stopReason: "stop", timestamp: 2 };
      process.stdout.write(JSON.stringify({ type: "message_end", message: final }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_end", messages: [final] }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      setInterval(() => {}, 1000);
    } else {
      const { runAgent } = await import(${JSON.stringify(moduleUrl)});
      const result = await runAgent({
        cwd: process.cwd(),
        agents: [{ name: "retry", description: "retry", source: "user", systemPrompt: "" }],
        callIndex: 0,
        agentName: "retry",
        prompt: "hello",
        initialContext: "empty",
        parentDepth: 0,
        parentAgentStack: [],
        maxDepth: 3,
        preventCycles: true,
        makeDetails: (items) => ({ kind: "pi-subagent", projectAgentsDir: null, results: items }),
      });
      process.stdout.write(JSON.stringify(result));
    }`,
  );

  try {
    const result = JSON.parse(
      execFileSync(process.execPath, ["--experimental-strip-types", harnessPath], {
        encoding: "utf8",
        timeout: 10_000,
      }),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.sawAgentSettled, true);
    assert.deepEqual(
      result.messages.map((message) => message.content[0].text),
      ["intermediate", "final"],
    );
  } finally {
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("runAgent delivers CLI-like prompts verbatim through stdin", () => {
  const { moduleUrl, cleanup } = createTestableRunnerModule();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-stdin-"));
  const harnessPath = path.join(tmpDir, "stdin-harness.mjs");

  fs.writeFileSync(
    harnessPath,
    `if (process.argv.includes("--mode")) {
      const prompt = await new Promise((resolve) => {
        process.stdin.once("data", (chunk) => resolve(JSON.parse(chunk.toString().trim()).message));
      });
      const message = {
        role: "assistant",
        content: [{ type: "text", text: prompt }],
        stopReason: "stop",
        timestamp: 1,
      };
      process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_end", messages: [message] }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    } else {
      const { runAgent } = await import(${JSON.stringify(moduleUrl)});
      const results = [];
      for (const prompt of ["--approve", "--help", "@/tmp/secret", "-leading", "  padded prompt  \\n"]) {
        results.push(await runAgent({
          cwd: process.cwd(),
          agents: [{ name: "echo", description: "echo", source: "user", systemPrompt: "" }],
          callIndex: 0,
          agentName: "echo",
          prompt,
          initialContext: "empty",
          parentDepth: 0,
          parentAgentStack: [],
          maxDepth: 3,
          preventCycles: true,
          makeDetails: (items) => ({ kind: "pi-subagent", projectAgentsDir: null, results: items }),
        }));
      }
      process.stdout.write(JSON.stringify(results));
    }`,
  );

  try {
    const results = JSON.parse(
      execFileSync(process.execPath, ["--experimental-strip-types", harnessPath], {
        encoding: "utf8",
        timeout: 10_000,
      }),
    );

    assert.deepEqual(
      results.map((result) => result.messages.at(-1).content[0].text),
      ["--approve", "--help", "@/tmp/secret", "-leading", "  padded prompt  \n"],
    );
    assert.equal(results.every((result) => result.exitCode === 0), true);
  } finally {
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("runAgent enforces an explicitly configured wall-clock timeout", () => {
  const { moduleUrl, cleanup } = createTestableRunnerModule();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-timeout-"));
  const harnessPath = path.join(tmpDir, "timeout-harness.mjs");

  fs.writeFileSync(
    harnessPath,
    `if (process.argv.includes("--mode")) {
      setInterval(() => {}, 1000);
    } else {
      const { runAgent } = await import(${JSON.stringify(moduleUrl)});
      const result = await runAgent({
        cwd: process.cwd(),
        agents: [{ name: "hang", description: "hang", source: "user", systemPrompt: "" }],
        callIndex: 0,
        agentName: "hang",
        prompt: "hello",
        initialContext: "empty",
        parentDepth: 0,
        parentAgentStack: [],
        maxDepth: 3,
        preventCycles: true,
        timeoutMs: 100,
        makeDetails: (results) => ({ kind: "pi-subagent", projectAgentsDir: null, results }),
      });
      process.stdout.write(JSON.stringify(result));
    }`,
  );

  try {
    const result = JSON.parse(
      execFileSync(process.execPath, ["--experimental-strip-types", harnessPath], {
        encoding: "utf8",
        timeout: 10_000,
      }),
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.processError, true);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage, /configured 0\.1s run timeout/);
  } finally {
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test(
  "runAgent timeout terminates Unix descendant processes",
  { skip: process.platform === "win32" },
  () => {
    const { moduleUrl, cleanup } = createTestableRunnerModule();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-tree-"));
    const harnessPath = path.join(tmpDir, "tree-harness.mjs");
    const markerPath = path.join(tmpDir, "descendant-marker");

    fs.writeFileSync(
      harnessPath,
      `import fs from "node:fs";
      import { spawn } from "node:child_process";
      if (process.argv.includes("--mode")) {
        spawn(process.execPath, ["-e", ${JSON.stringify(`process.on("SIGTERM", () => {}); setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "alive"), 1000)`) }], { stdio: "ignore" });
        setInterval(() => {}, 1000);
      } else {
        const { runAgent } = await import(${JSON.stringify(moduleUrl)});
        const result = await runAgent({
          cwd: process.cwd(),
          agents: [{ name: "tree", description: "tree", source: "user", systemPrompt: "" }],
          callIndex: 0,
          agentName: "tree",
          prompt: "hello",
          initialContext: "empty",
          parentDepth: 0,
          parentAgentStack: [],
          maxDepth: 3,
          preventCycles: true,
          timeoutMs: 100,
          makeDetails: (items) => ({ kind: "pi-subagent", projectAgentsDir: null, results: items }),
        });
        await new Promise((resolve) => setTimeout(resolve, 1300));
        process.stdout.write(JSON.stringify({ result, markerExists: fs.existsSync(${JSON.stringify(markerPath)}) }));
      }`,
    );

    try {
      const output = JSON.parse(
        execFileSync(process.execPath, ["--experimental-strip-types", harnessPath], {
          encoding: "utf8",
          timeout: 10_000,
        }),
      );
      assert.equal(output.result.processError, true);
      assert.equal(output.markerExists, false);
    } finally {
      cleanup();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);

test("buildPiArgs plans ephemeral and persistent session flags", async () => {
  const { moduleUrl, cleanup } = createTestableRunnerModule();
  try {
    const { buildPiArgs } = await import(moduleUrl);
    const agent = {
      name: "review",
      description: "reviewer",
      source: "user",
      systemPrompt: "",
    };
    const session = {
      handle: "api-review",
      id: "subagent.abc123",
      name: "subagent: review · api-review",
      cwd: "/repo",
      created: true,
      initialContextApplied: "parent",
    };

    assert.deepEqual(
      buildPiArgs(agent, null, "hello", "empty", null, undefined, undefined),
      ["--mode", "rpc", "--no-session"],
    );

    assert.deepEqual(
      buildPiArgs(agent, null, "hello", "parent", "/tmp/parent.jsonl", undefined, undefined),
      ["--mode", "rpc", "--session", "/tmp/parent.jsonl"],
    );

    assert.deepEqual(
      buildPiArgs(agent, null, "hello", "parent", "/tmp/parent.jsonl", session, undefined),
      [
        "--mode",
        "rpc",
        "--fork",
        "/tmp/parent.jsonl",
        "--session-id",
        "subagent.abc123",
        "--name",
        "subagent: review · api-review",
      ],
    );

    assert.deepEqual(
      buildPiArgs(
        agent,
        null,
        "hello",
        "parent",
        "/tmp/parent.jsonl",
        { ...session, created: false, initialContextApplied: null },
        undefined,
      ),
      ["--mode", "rpc", "--session-id", "subagent.abc123"],
    );

    assert.deepEqual(
      buildPiArgs(
        { ...agent, tools: ["read"], noTools: true },
        null,
        "hello",
        "empty",
        null,
        undefined,
        undefined,
      ),
      ["--mode", "rpc", "--no-session", "--no-tools"],
    );

    assert.deepEqual(
      buildPiArgs({ ...agent, model: "agent-model" }, null, "hello", "empty", null, undefined, undefined),
      ["--mode", "rpc", "--no-session", "--model", "agent-model"],
    );

    assert.deepEqual(
      buildPiArgs({ ...agent, model: "agent-model" }, null, "hello", "empty", null, undefined, undefined, "call-model"),
      ["--mode", "rpc", "--no-session", "--model", "call-model"],
    );
  } finally {
    cleanup();
  }
});
