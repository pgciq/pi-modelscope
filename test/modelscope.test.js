import assert from "node:assert/strict";
import test from "node:test";
import extension from "../extensions/modelscope.ts";

function getRuntime() {
  let name;
  let config;
  const commands = new Map();
  const entries = [];
  extension({
    registerProvider(providerName, providerConfig) {
      name = providerName;
      config = providerConfig;
    },
    registerCommand(commandName, command) {
      commands.set(commandName, command);
    },
    registerEntryRenderer() {},
    appendEntry(key, data) {
      entries.push({ key, data });
    },
    on() {},
  });
  return { name, config, commands, entries };
}

test("registers the ModelScope OpenAI-compatible provider", () => {
  const { name, config } = getRuntime();
  assert.equal(name, "modelscope");
  assert.equal(config.name, "ModelScope");
  assert.equal(config.baseUrl, "https://api-inference.modelscope.cn/v1");
  assert.equal(config.apiKey, "$MODELSCOPE_API_KEY");
  assert.equal(config.api, "openai-completions");
  assert.equal(typeof config.streamSimple, "function");
  assert.equal(typeof config.refreshModels, "function");
});

test("seeds the documented multimodal model", () => {
  const { config } = getRuntime();
  assert.deepEqual(config.models.map((model) => model.id), ["Qwen/Qwen3.8-Flash-Next"]);
  assert.deepEqual(config.models[0].input, ["text", "image"]);
  assert.deepEqual(config.models[0].capabilities, {
    tools: true,
    vision: true,
    image: false,
    video: false,
    audio: false,
    reasoning: false,
  });
});

test("registers model inspection and usage commands", () => {
  const { commands } = getRuntime();
  assert.deepEqual([...commands.keys()], [
    "modelscope-models",
    "modelscope-usage",
  ]);
});

test("models command includes capabilities and supports filtering", async () => {
  const { commands, entries } = getRuntime();
  await commands.get("modelscope-models").handler("vision", {
    mode: "tui",
    hasUI: false,
    modelRegistry: {
      getAll: () => [{
        provider: "modelscope",
        id: "Qwen/Qwen3.8-Flash-Next",
        input: ["text", "image"],
        reasoning: false,
        capabilities: { vision: true, tools: true },
      }, {
        provider: "modelscope",
        id: "Qwen/text-only",
        input: ["text"],
        reasoning: false,
        capabilities: { vision: false, tools: true },
      }],
    },
  });
  assert.equal(entries.at(-1).key, "modelscope-models");
  assert.match(entries.at(-1).data.markdown, /Qwen\/Qwen3\.8-Flash-Next/);
  assert.doesNotMatch(entries.at(-1).data.markdown, /Qwen\/text-only/);
  assert.match(entries.at(-1).data.markdown, /Context.*Max Output/);
});

test("uses a valid model array when discovery falls back to the cache", async () => {
  const { config } = getRuntime();
  const cachedModels = [{
    id: "cached-model",
    name: "Cached model",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  }];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("offline");
  };

  try {
    const result = await config.refreshModels({
      signal: new AbortController().signal,
      stored: { provider: "modelscope", models: cachedModels },
      publish: async () => true,
    });
    assert.deepEqual(result, cachedModels);
    assert.ok(Array.isArray(result));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discovers and persists models from the OpenAI models endpoint", async () => {
  const { config } = getRuntime();
  const originalFetch = globalThis.fetch;
  let request;
  let published;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ data: [{
      id: "Qwen/Qwen3-VL-32B-Instruct",
      pricing: { input: 0.2, output: 0.6 },
      context_window: 32768,
    }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await config.refreshModels({
      signal: new AbortController().signal,
      credential: { key: "test-token" },
      publish: async (value) => {
        published = value;
      },
    });
    assert.equal(request.url, "https://api-inference.modelscope.cn/v1/models");
    assert.equal(request.options.headers.Authorization, "Bearer test-token");
    assert.equal(result[0].id, "Qwen/Qwen3-VL-32B-Instruct");
    assert.equal(result[0].cost.input, 0.2);
    assert.equal(result[0].cost.output, 0.6);
    assert.deepEqual(published.persist.models, result);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
