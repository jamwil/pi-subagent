import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { default: registerSubagentExtension } = await jiti.import("../index.ts");

function createPiHarness() {
  const handlers = new Map();
  const tools = new Map();
  const flags = new Map();

  const pi = {
    registerFlag(name, definition) {
      flags.set(name, definition);
    },
    getFlag() {
      return undefined;
    },
    on(event, handler) {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  };

  registerSubagentExtension(pi);
  return { handlers, tools, flags };
}

function writeAgent(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\nYou are ${name}.\n`,
  );
}

function createContext(cwd, trusted) {
  return {
    cwd,
    hasUI: false,
    isProjectTrusted: () => trusted,
    ui: { notify() {} },
    sessionManager: {
      getHeader: () => ({ type: "session", version: 3, id: "parent", cwd }),
      getBranch: () => [],
      getSessionId: () => "parent-session",
      getSessionDir: () => path.join(cwd, ".sessions"),
      getSessionFile: () => undefined,
    },
  };
}

test("subagent schema uses a Google-compatible initialContext enum", () => {
  const harness = createPiHarness();
  const schema = harness.tools.get("subagent").parameters;
  const initialContext = schema.properties.calls.items.properties.initialContext;

  assert.equal(initialContext.type, "string");
  assert.deepEqual(initialContext.enum, ["empty", "parent"]);
  assert.equal(initialContext.default, "empty");
  assert.equal(initialContext.anyOf, undefined);
  assert.equal(initialContext.oneOf, undefined);

  const timeout = schema.properties.calls.items.properties.timeout;
  assert.equal(timeout.type, "integer");
  assert.equal(timeout.minimum, 1);
  assert.equal(timeout.maximum > 1, true);
});

test("extension lifecycle excludes untrusted project agents consistently", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-index-"));
  const configDir = path.join(tmpDir, "config");
  const projectDir = path.join(tmpDir, "project");
  const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = configDir;
  writeAgent(path.join(projectDir, ".pi", "agents"), "project-only");

  try {
    const harness = createPiHarness();
    const ctx = createContext(projectDir, false);

    await harness.handlers.get("session_start")[0]({ reason: "startup" }, ctx);
    const promptPatch = await harness.handlers.get("before_agent_start")[0](
      { systemPrompt: "base" },
      ctx,
    );

    assert.match(promptPatch.systemPrompt, /\*\*explore\*\* \(user\)/);
    assert.doesNotMatch(promptPatch.systemPrompt, /project-only/);

    const invalidTimeout = await harness.tools.get("subagent").execute(
      "invalid-timeout",
      { calls: [{ agent: "project-only", prompt: "hello", timeout: 0 }] },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(invalidTimeout.details.failed, true);
    assert.match(invalidTimeout.content[0].text, /timeout must be an integer/);

    const result = await harness.tools.get("subagent").execute(
      "call-1",
      { calls: [{ agent: "project-only", prompt: "hello" }] },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.details.kind, "pi-subagent");
    assert.equal(result.details.failed, true);
    assert.equal(result.details.projectAgentsDir, null);
    assert.equal(result.details.results.length, 1);
    assert.equal(result.details.results[0].agentSource, "unknown");
    assert.match(result.content[0].text, /Unknown agent: "project-only"/);

    const errorPatch = await harness.handlers.get("tool_result")[0](
      {
        toolName: "subagent",
        content: result.content,
        details: result.details,
        isError: false,
      },
      ctx,
    );
    assert.deepEqual(errorPatch, { isError: true });

    const successPatch = await harness.handlers.get("tool_result")[0](
      {
        toolName: "subagent",
        content: [{ type: "text", text: "ok" }],
        details: { kind: "pi-subagent", projectAgentsDir: null, results: [] },
        isError: false,
      },
      ctx,
    );
    assert.equal(successPatch, undefined);
  } finally {
    if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
