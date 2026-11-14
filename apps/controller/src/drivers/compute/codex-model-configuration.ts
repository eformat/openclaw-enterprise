import type { OpenClawConfigurationDocument } from "@openclaw-enterprise/contracts";
import { asRecord, splitModelRef } from "@openclaw-enterprise/utils";

import { rewriteModelSelections } from "./kubernetes/configuration-rules.ts";
import type { CodexModelEndpoint } from "./plugin-runtime.ts";

/** Compile the admitted selection into stock OpenClaw's explicit native-provider syntax. */
export function codexGatewayModelConfiguration(
  configuration: OpenClawConfigurationDocument,
  endpoint: CodexModelEndpoint,
): OpenClawConfigurationDocument {
  const document = structuredClone(configuration);
  const agents = asRecord(document.agents);
  const defaults = asRecord(agents?.defaults);
  const entries = Object.values(asRecord(agents?.entries) ?? {}).map(asRecord);
  const primary =
    typeof defaults?.model === "string" ? defaults.model : asRecord(defaults?.model)?.primary;
  const entryPrimary = entries
    .map((entry) =>
      typeof entry?.model === "string" ? entry.model : asRecord(entry?.model)?.primary,
    )
    .find((value) => typeof value === "string");
  const selected = typeof primary === "string" ? primary : entryPrimary;
  if (typeof selected !== "string") {
    throw new Error("Dedicated Codex model selection is missing.");
  }
  const sourceProvider = splitModelRef(selected).provider;
  const references = new Map<string, string>();
  const selections = new Set<string>();
  const qualify = (reference: string): string => {
    const { provider, id } = splitModelRef(reference);
    if (provider !== sourceProvider) {
      return reference;
    }
    if (id === undefined) {
      throw new Error("Dedicated Codex model reference must include its provider.");
    }
    references.set(reference, id);
    return `codex/${endpoint.modelProvider}/${id}`;
  };
  // Every setting the Harness model rule checks (requireSelectedModelProvider): the primary,
  // subagent, image, PDF, heartbeat, compaction and other model selections, hook and channel
  // models, and policy selectors (`models` keys and `modelPolicy.allow` entries). Rewriting all
  // of them before the source provider block is dropped leaves no selection on it. Media and
  // voice models are not chat models: admission refuses them on Dedicated Codex, and the
  // projection leaves them as written, never adding them to the chat catalog.
  rewriteModelSelections(document, (reference, policy) => {
    if (policy) {
      return qualify(reference);
    }
    // Bare selections remain native aliases, even when named like the source provider.
    if (!reference.includes("/")) {
      return reference;
    }
    selections.add(reference);
    return qualify(reference);
  });
  const models = asRecord(document.models) ?? {};
  const providers = asRecord(models.providers) ?? {};
  const source = asRecord(providers[sourceProvider]) ?? {};
  const catalog = Array.isArray(source.models) ? source.models.map(asRecord) : [];
  // Match each declared ref, not a prefix heuristic: a native ID may itself
  // start with "codex/", while a catalog may also contain full OCE refs.
  const projected = new Map<string, Record<string, unknown>>();
  for (const [reference, id] of references) {
    const row = catalog.find((entry) => entry?.id === reference || entry?.id === id);
    // Policy selectors can name wildcards or discovery hints, not catalog rows.
    if (row === undefined && !selections.has(reference)) {
      continue;
    }
    const { modelInfo, ...nativeRow } = row ?? { name: id };
    projected.set(id, {
      ...nativeRow,
      id: `${endpoint.modelProvider}/${id}`,
    });
  }
  if (sourceProvider !== "codex") {
    delete providers[sourceProvider];
  }
  providers.codex = { ...source, models: [...projected.values()] };
  models.providers = providers;
  return { ...document, models: models as OpenClawConfigurationDocument };
}

/** Model metadata a Configuration declares for Codex's native model catalog, keyed
 * exactly as the Codex runtime's bundled entries (`apply_patch_tool_type`,
 * `shell_type`, `context_window`, ...). Without it the runtime falls back to
 * metadata that assumes OpenAI-specific tool formats, which OpenAI-compatible
 * providers such as MaaS reject. */
const MODEL_INFO_LIMITS = { maxKeys: 32, maxBytes: 8_192, maxDepth: 4 } as const;

/** Fields the Codex model-catalog schema requires; entries parse only with
 * them present, discovered against the pinned runtime's deserializer. The
 * base instructions text is Codex's own default prompt opening. */
const MODEL_CATALOG_REQUIRED_DEFAULTS: Readonly<Record<string, unknown>> = {
  supported_reasoning_levels: [
    { effort: "low", description: "Fast responses with lighter reasoning" },
    { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
    { effort: "high", description: "Greater reasoning depth for complex problems" },
  ],
  visibility: "list",
  minimal_client_version: "0.153.0",
  supported_in_api: true,
  priority: 100,
  truncation_policy: { mode: "tokens", limit: 10_000 },
  experimental_supported_tools: [],
  base_instructions:
    "You are a coding agent running in the Codex CLI, a terminal-based coding assistant.",
};

function validateModelInfo(
  modelInfo: unknown,
  modelId: string,
): Record<string, unknown> {
  if (modelInfo === undefined) return {};
  const row = asRecord(modelInfo);
  if (row === undefined) {
    throw new Error(`models.providers.codex model ${modelId} modelInfo must be an object.`);
  }
  const keys = Object.keys(row);
  if (keys.length === 0) {
    throw new Error(`models.providers.codex model ${modelId} declares an empty modelInfo.`);
  }
  if (keys.length > MODEL_INFO_LIMITS.maxKeys) {
    throw new Error(
      `models.providers.codex model ${modelId} modelInfo exceeds ${MODEL_INFO_LIMITS.maxKeys} keys.`,
    );
  }
  const depth = (value: unknown, level: number): number =>
    Array.isArray(value)
      ? Math.max(0, ...value.map((item) => depth(item, level + 1)))
      : typeof value === "object" && value !== null
        ? Math.max(level, ...Object.values(value).map((item) => depth(item, level + 1)))
        : level;
  if (depth(row, 0) > MODEL_INFO_LIMITS.maxDepth) {
    throw new Error(
      `models.providers.codex model ${modelId} modelInfo exceeds ${MODEL_INFO_LIMITS.maxDepth} nesting levels.`,
    );
  }
  for (const value of Object.values(row)) {
    const leaf = typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null;
    const branch = Array.isArray(value) || (typeof value === "object" && value !== null);
    if (!leaf && !branch) {
      throw new Error(
        `models.providers.codex model ${modelId} modelInfo values must be JSON data.`,
      );
    }
  }
  if (
    row.apply_patch_tool_type !== undefined &&
    row.apply_patch_tool_type !== "freeform"
  ) {
    // The pinned runtime's catalog deserializer accepts only the freeform
    // variant; function-shaped apply_patch tooling does not exist there.
    throw new Error(
      `models.providers.codex model ${modelId} modelInfo apply_patch_tool_type must be "freeform" when set.`,
    );
  }
  return row;
}

/** The Codex model-catalog JSON for every Configuration-declared Codex model that
 * carries `modelInfo`, or undefined when none does. Delivered to the Harness
 * runtime and referenced from the generated `config.toml` through
 * `model_catalog_json`, so custom providers get native tool formats instead of
 * Codex's OpenAI-shaped fallback metadata. */
export function codexModelCatalog(
  configuration: OpenClawConfigurationDocument,
): string | undefined {
  const providers = asRecord(asRecord(configuration.models)?.providers);
  const source = asRecord(providers?.codex);
  const catalog = Array.isArray(source?.models) ? source.models.map(asRecord) : [];
  const entries: Record<string, unknown>[] = [];
  for (const entry of catalog) {
    const id = entry?.id;
    if (typeof id !== "string" || id.trim().length === 0) continue;
    const info = validateModelInfo(entry?.modelInfo, id);
    if (Object.keys(info).length === 0) continue;
    entries.push({
      slug: id.trim(),
      ...MODEL_CATALOG_REQUIRED_DEFAULTS,
      ...info,
    });
  }
  if (entries.length === 0) return undefined;
  const serialized = JSON.stringify({ models: entries });
  if (Buffer.byteLength(serialized, "utf8") > MODEL_INFO_LIMITS.maxBytes) {
    throw new Error(
      `The Codex model catalog exceeds ${MODEL_INFO_LIMITS.maxBytes} bytes.`,
    );
  }
  return serialized;
}
