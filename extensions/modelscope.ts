// ModelScope provider (OpenAI-compatible) — https://modelscope.cn/docs
// Base URL: https://api-inference.modelscope.cn/v1
// Auth: MODELSCOPE_API_KEY env var (a ModelScope Token)
//
// ModelScope exposes an OpenAI-compatible chat completions endpoint.  The
// provider registers a known model immediately, then refreshes the catalog
// from /v1/models in the background so startup does not depend on the
// network.  The catalog is persisted by pi and used as an offline fallback.

// The TUI package is provided by pi. Keep it optional so print/RPC usage and
// lightweight provider tests do not fail if that package is not installed.
let Markdown;
try {
  Markdown = (await import("@earendil-works/pi-tui")).Markdown;
} catch {
  Markdown = undefined;
}

// The theme passed to custom entry renderers is a general UI theme and does
// not implement Markdown methods such as `heading()`. Use pi's Markdown theme
// factory instead of passing that renderer theme directly to Markdown.
let getMarkdownTheme;
try {
  getMarkdownTheme = (await import("@earendil-works/pi-coding-agent")).getMarkdownTheme;
} catch {
  getMarkdownTheme = undefined;
}

// `openAICompletionsApi` moved to a lazy subpath in newer pi-ai builds;
// resolve both layouts so the extension works with older pi installations too.
const openAICompletionsApi = await (async () => {
  try {
    return (await import("@earendil-works/pi-ai/api/openai-completions.lazy")).openAICompletionsApi;
  } catch {
    return (await import("@earendil-works/pi-ai")).openAICompletionsApi;
  }
})();

const BASE_URL = "https://api-inference.modelscope.cn/v1";
const API_KEY_ENV = "MODELSCOPE_API_KEY";

// This is the model from ModelScope's OpenAI-compatible multimodal example.
// Keeping it in the seed list makes the provider usable before discovery has
// completed (or when /v1/models is unavailable).
const MODELSCOPE_SEED = ["Qwen/Qwen3.8-Flash-Next"];

const REASONING_EFFORTS = {
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
  max: null,
};

function isVisionModel(id, model) {
  const modalities = model?.input_modalities ?? model?.inputModalities ?? model?.input;
  if (Array.isArray(modalities) && modalities.some((item) => String(item).toLowerCase() === "image")) return true;
  if (model?.supports_vision === true || model?.supportsVision === true || model?.multimodal === true) return true;

  const capabilities = model?.capabilities;
  if (capabilities && !Array.isArray(capabilities) && capabilities.vision === true) return true;
  if (Array.isArray(capabilities) && capabilities.some((item) => /vision|image|multimodal/i.test(String(item)))) return true;

  // ModelScope's model catalog does not consistently expose capabilities, so
  // retain useful defaults for common vision model naming conventions and the
  // documented multimodal seed model.
  return id === "Qwen/Qwen3.8-Flash-Next" || /(?:-VL|vision|visual|vlm)/i.test(id);
}

function hasImageOutput(model) {
  const modalities = model?.output_modalities ?? model?.outputModalities;
  if (Array.isArray(modalities) && modalities.some((item) => String(item).toLowerCase() === "image")) return true;
  return model?.supports_image_generation === true || model?.supportsImageGeneration === true;
}

function readNumber(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

function modelCost(model) {
  const source = model?.pricing ?? model?.prices ?? model?.cost ?? {};
  const input = readNumber(
    source.input, source.prompt, source.input_price, source.prompt_price,
    model?.input_price, model?.prompt_price,
  );
  const output = readNumber(
    source.output, source.completion, source.completion_price, source.output_price,
    model?.output_price, model?.completion_price,
  );
  const cacheRead = readNumber(source.cacheRead, source.cache_read, source.cache_read_price) ?? 0;
  const cacheWrite = readNumber(source.cacheWrite, source.cache_write, source.cache_write_price) ?? 0;
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead,
    cacheWrite,
  };
}

function isReasoningModel(id, model) {
  if (model?.reasoning === true || model?.supports_reasoning === true || model?.supportsReasoning === true) return true;
  const capabilities = model?.capabilities;
  if (capabilities && !Array.isArray(capabilities) && capabilities.reasoning === true) return true;
  return /(?:thinking|reasoning|r1|qwq)/i.test(id);
}

function numberOr(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
}

function convertModel(model) {
  const id = typeof model?.id === "string" ? model.id : String(model?.id ?? "");
  const vision = isVisionModel(id, model);
  const reasoning = isReasoningModel(id, model);
  const input = vision ? ["text", "image"] : ["text"];
  const pricing = modelCost(model);
  const contextWindow = numberOr(
    model?.context_window ?? model?.contextWindow ?? model?.context_length ?? model?.max_model_len,
    131072,
  );
  const maxTokens = numberOr(model?.max_tokens ?? model?.maxTokens, Math.min(contextWindow, 32768));

  const converted = {
    id,
    name: typeof model?.name === "string" ? model.name : id,
    reasoning,
    input,
    cost: pricing,
    contextWindow,
    maxTokens,
    capabilities: {
      tools: model?.supports_tools !== false && model?.supportsTools !== false,
      vision,
      image: hasImageOutput(model),
      video: model?.supports_video === true || model?.supportsVideo === true,
      audio: model?.supports_audio === true || model?.supportsAudio === true,
      reasoning,
    },
  };

  if (reasoning) {
    converted.thinkingLevelMap = REASONING_EFFORTS;
    converted.compat = { supportsReasoningEffort: true, supportsDeveloperRole: false };
  }

  return converted;
}

function seedModels() {
  return MODELSCOPE_SEED.map((id) => convertModel({ id }));
}

async function fetchModels(baseUrl, signal, apiKey) {
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${baseUrl}/models`, {
    headers,
    redirect: "follow",
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

  const payload = await response.json();
  const data = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload)
      ? payload
      : [];
  return data.filter((model) => model && model.id).map(convertModel);
}

export default function (pi) {
  const discovery = { models: seedModels() };

  pi.registerProvider("modelscope", {
    name: "ModelScope",
    baseUrl: BASE_URL,
    // An env reference prevents pi from treating a missing key as a literal
    // credential while still allowing pi to report the provider as configured
    // when MODELSCOPE_API_KEY is set.
    apiKey: `$${API_KEY_ENV}`,
    api: "openai-completions",
    streamSimple: (model, context, options) =>
      openAICompletionsApi().streamSimple(model, context, options),
    models: discovery.models,

    async refreshModels({ signal, stored, publish, allowNetwork, credential }) {
      const cachedModels = Array.isArray(stored?.models) ? stored.models : undefined;
      const fallback = cachedModels?.length ? cachedModels : seedModels();

      // Pi first restores its persisted catalog without network access.
      if (allowNetwork === false || signal?.aborted) return fallback;

      const apiKey = credential?.key ?? process.env[API_KEY_ENV];
      try {
        const models = await fetchModels(BASE_URL, signal, apiKey);
        if (models.length > 0) {
          discovery.models = models;
          await publish({ persist: { provider: "modelscope", models } });
          return models;
        }
      } catch {
        // Discovery is optional. Keep pi usable offline, during an API outage,
        // or before the user has configured a token.
      }

      discovery.models = fallback;
      return fallback;
    },
  });

  registerModelCommands(pi, discovery);
  installUsageTracker(pi);
  registerUsageCommand(pi);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const CAPABILITY_FLAGS = {
  reasoning: "reasoning",
  vision: "vision",
  image: "image",
  video: "video",
  audio: "audio",
  tools: "tools",
};

function showMarkdown(pi, ctx, key, markdown) {
  if (ctx?.mode === "tui") pi.appendEntry(key, { markdown });
  else if (ctx?.hasUI) ctx.ui.notify(markdown, "info");
  else console.log(markdown);
}

function registerMarkdownRenderer(pi, key) {
  if (typeof Markdown !== "function" || typeof getMarkdownTheme !== "function") return;
  pi.registerEntryRenderer?.(key, (entry) =>
    new Markdown(entry.data?.markdown ?? "", 1, 0, getMarkdownTheme()),
  );
}

function getModelCatalog(ctx, discovery) {
  const registered = ctx?.modelRegistry?.getAll?.() ?? [];
  const models = registered.filter((model) => model.provider === "modelscope");
  return models.length > 0 ? models : discovery.models;
}

function formatSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function registerModelCommands(pi, discovery) {
  if (typeof pi.registerCommand !== "function") return;

  pi.registerCommand("modelscope-models", {
    description: "List ModelScope models with capabilities and limits; optional filter: image, vision, tools, reasoning, audio, video.",
    handler: async (args, ctx) => {
      const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
      const filter = tokens.find((token) => token in CAPABILITY_FLAGS);
      const mark = (value) => value ? "✓" : "—";
      const rows = getModelCatalog(ctx, discovery)
        .map((model) => {
          const caps = model.capabilities ?? {};
          return {
            model,
            reasoning: caps.reasoning || model.reasoning,
            vision: caps.vision || model.input?.includes("image"),
            image: !!caps.image,
            video: !!caps.video,
            audio: !!caps.audio,
            tools: caps.tools !== false,
          };
        })
        .filter((row) => !filter || row[CAPABILITY_FLAGS[filter]])
        .sort((a, b) => a.model.id.localeCompare(b.model.id));
      const markdown = [
        `# ModelScope models${filter ? ` (filter: ${filter})` : ""}`,
        "",
        "| Model | Display Name | Reasoning | Vision | Image | Video | Audio | Tools | Context | Max Output |",
        "|---|---|:---:|:---:|:---:|:---:|:---:|:---:|---:|---:|",
        ...rows.map((row) => `| \`${row.model.id}\` | ${row.model.name || row.model.id} | ${mark(row.reasoning)} | ${mark(row.vision)} | ${mark(row.image)} | ${mark(row.video)} | ${mark(row.audio)} | ${mark(row.tools)} | ${formatSize(row.model.contextWindow)} | ${formatSize(row.model.maxTokens)} |`),
        "",
        "_Capabilities come from ModelScope metadata when available; `—` means the capability was not advertised._",
        rows.length ? "" : "_No models match the filter._",
      ].join("\n");
      showMarkdown(pi, ctx, "modelscope-models", markdown);
    },
  });
  registerMarkdownRenderer(pi, "modelscope-models");

}

// ModelScope does not provide a billing/usage endpoint in its OpenAI-compatible
// API. Track the usage reported by completed assistant messages instead. This
// is process-local Pi usage, not an account-level ModelScope invoice.
const MODELSCOPE_SESSION_USAGE = new Map();
let usageHookInstalled = false;

function installUsageTracker(pi) {
  if (usageHookInstalled || typeof pi.on !== "function") return;
  usageHookInstalled = true;
  pi.on("message_end", (event) => {
    const message = event?.message;
    if (message?.role !== "assistant" || message.provider !== "modelscope") return;

    const key = `${message.provider}/${message.model}`;
    const row = MODELSCOPE_SESSION_USAGE.get(key) ?? {
      provider: message.provider,
      model: message.model,
      turns: 0,
      input: 0,
      output: 0,
      total: 0,
      cost: 0,
    };
    const usage = message.usage ?? {};
    const cost = usage.cost ?? {};
    const input = Number(usage.input) || 0;
    const output = Number(usage.output) || 0;
    const total = Number(usage.totalTokens) || input + output;
    const turnCost = Number(cost.total);

    row.turns += 1;
    row.input += input;
    row.output += output;
    row.total += total;
    row.cost += Number.isFinite(turnCost) ? turnCost : 0;
    MODELSCOPE_SESSION_USAGE.set(key, row);
  });
}

function registerUsageCommand(pi) {
  if (typeof pi.registerCommand !== "function") return;

  pi.registerCommand("modelscope-usage", {
    description: "Show ModelScope token/cost usage accumulated in the current Pi process.",
    handler: async (_args, ctx) => {
      const rows = [...MODELSCOPE_SESSION_USAGE.values()]
        .sort((a, b) => a.model.localeCompare(b.model));
      const totalCost = rows.reduce((sum, row) => sum + row.cost, 0);
      const markdown = [
        "# ModelScope session usage",
        "",
        "_This is usage reported by completed assistant messages in the current Pi process, not a ModelScope account billing dashboard._",
        "",
        "| Model | Turns | Input Tokens | Output Tokens | Total Tokens | Cost |",
        "|---|---:|---:|---:|---:|---:|",
        ...rows.map((row) => `| ${row.model} | ${row.turns} | ${row.input.toLocaleString()} | ${row.output.toLocaleString()} | ${row.total.toLocaleString()} | $${row.cost.toFixed(6)} |`),
        "",
        rows.length
          ? `**Session total:** $${totalCost.toFixed(6)}`
          : "_No ModelScope assistant usage recorded in this Pi process yet._",
      ].join("\n");
      showMarkdown(pi, ctx, "modelscope-usage", markdown);
    },
  });
  registerMarkdownRenderer(pi, "modelscope-usage");
}
