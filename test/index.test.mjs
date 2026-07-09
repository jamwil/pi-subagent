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

    const result = await harness.tools.get("subagent").execute(
      "call-1",
      { calls: [{ agent: "project-only", prompt: "hello" }] },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.details.projectAgentsDir, null);
    assert.equal(result.details.results.length, 1);
    assert.equal(result.details.results[0].agentSource, "unknown");
    assert.match(result.content[0].text, /Unknown agent: "project-only"/);
  } finally {
    if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
