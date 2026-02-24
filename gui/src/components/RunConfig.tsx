import { useState, useEffect } from "react";
import { api } from "../api/client";
import type { TheoremSetInfo, IndividualRun } from "../api/client";

export type TierBudgets = Record<string, number>;

export const DEFAULT_TIER_BUDGETS: TierBudgets = {
  baby: 1024,
  easy: 1024,
  medium: 2048,
  hard: 2048,
  expert: 4096,
  nightmare: 6144,
  marathon: 6144,
  absurd: 8192,
  cosmic: 8192,
  mind: 8192,
};

export interface RunConfigValues {
  models: string[];
  theoremSet: string;
  temperature: number;
  maxTokens: number | null;
  maxThinkingTokens: number | null;
  workers: number | null;
  startIndex: number | null;
  count: string;
  force: boolean;
  noRetryParse: boolean;
  runs: number;
  continueRunId: number | null;
  maxCost: number | null;
  tierBudgetsEnabled: boolean;
  tierBudgets: TierBudgets;
}

const MODEL_OPTIONS = [
  { key: "gemini-2.0-flash", label: "Gemini 2.0 Flash", envVar: "GEMINI_API_KEY" },
  { key: "gemini-2.5-pro", label: "Gemini 2.5 Pro", envVar: "GEMINI_API_KEY" },
  { key: "gemini-2.5-flash", label: "Gemini 2.5 Flash", envVar: "GEMINI_API_KEY" },
  { key: "gemini-2.5-flash-lite-preview-09-2025", label: "Gemini 2.5 Flash Lite", envVar: "GEMINI_API_KEY" },
  { key: "gemini-3-flash-preview", label: "Gemini 3 Flash", envVar: "GEMINI_API_KEY" },
  { key: "gemini-3-pro-preview", label: "Gemini 3 Pro", envVar: "GEMINI_API_KEY" },
  { key: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", envVar: "GEMINI_API_KEY" },
] as const;

const BUILTIN_PRESETS: { key: string; label: string }[] = [
  { key: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6" },
  { key: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
  { key: "openai/gpt-4o", label: "GPT-4o" },
  { key: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick" },
  { key: "deepseek/deepseek-r1", label: "DeepSeek R1" },
  { key: "mistralai/mistral-large-2", label: "Mistral Large 2" },
];

const BUILTIN_KEYS = new Set(BUILTIN_PRESETS.map((p) => p.key));
const GEMINI_KEYS: Set<string> = new Set(MODEL_OPTIONS.map((m) => m.key));

const STORAGE_KEY = "propbench-openrouter-presets";
const TIER_BUDGETS_STORAGE_KEY = "propbench-tier-budgets";

function loadSavedPresets(): { key: string; label: string }[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function savePresets(presets: { key: string; label: string }[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

function saveTierBudgets(budgets: TierBudgets) {
  localStorage.setItem(TIER_BUDGETS_STORAGE_KEY, JSON.stringify(budgets));
}

const TIER_LABELS: { key: string; label: string }[] = [
  { key: "baby", label: "Baby" },
  { key: "easy", label: "Easy" },
  { key: "medium", label: "Medium" },
  { key: "hard", label: "Hard" },
  { key: "expert", label: "Expert" },
  { key: "nightmare", label: "Nightmare" },
  { key: "marathon", label: "Marathon" },
  { key: "absurd", label: "Absurd" },
  { key: "cosmic", label: "Cosmic" },
  { key: "mind", label: "Mind" },
];

interface RunConfigProps {
  config: RunConfigValues;
  onChange: (config: RunConfigValues) => void;
  running: boolean;
  onStart: () => void;
}

function buildCommand(cfg: RunConfigValues): string {
  const parts: string[] = ["npx ts-node harness.ts"];
  parts.push(`--theorems ${cfg.theoremSet}`);
  parts.push(`--models ${cfg.models.join(",")}`);
  parts.push(`--temperature ${cfg.temperature}`);
  if (cfg.maxTokens != null) {
    parts.push(`--max-tokens ${cfg.maxTokens}`);
  }
  if (cfg.maxThinkingTokens != null) {
    parts.push(`--max-thinking-tokens ${cfg.maxThinkingTokens}`);
  }
  if (cfg.workers != null && cfg.workers > 1) {
    parts.push(`--workers ${cfg.workers}`);
  }
  if (cfg.startIndex != null && cfg.startIndex > 0) {
    parts.push(`--start ${cfg.startIndex}`);
  }
  if (cfg.count.trim() !== "") {
    parts.push(`--count ${cfg.count.trim()}`);
  }
  if (cfg.force) {
    parts.push("--force");
  }
  if (cfg.noRetryParse) {
    parts.push("--no-retry-parse");
  }
  if (cfg.runs > 1) {
    parts.push(`--runs ${cfg.runs}`);
  }
  if (cfg.maxCost != null) {
    parts.push(`--max-cost ${cfg.maxCost}`);
  }
  if (!cfg.tierBudgetsEnabled) {
    parts.push("--no-tier-budgets");
  } else {
    // Only include --tier-budgets if any value differs from defaults
    const hasCustom = TIER_LABELS.some(
      ({ key }) => cfg.tierBudgets[key] !== DEFAULT_TIER_BUDGETS[key]
    );
    if (hasCustom) {
      parts.push(`--tier-budgets '${JSON.stringify(cfg.tierBudgets)}'`);
    }
  }
  return parts.join(" \\\n  ");
}

function RunConfig({ config, onChange, running, onStart }: RunConfigProps) {
  const [theoremSets, setTheoremSets] = useState<TheoremSetInfo[]>([]);
  const [showCommand, setShowCommand] = useState(false);
  const [incompleteRuns, setIncompleteRuns] = useState<IndividualRun[]>([]);
  const [continueMode, setContinueMode] = useState(false);
  const [customModelInput, setCustomModelInput] = useState("");
  const [presetValue, setPresetValue] = useState("");
  const [savedPresets, setSavedPresets] = useState<{ key: string; label: string }[]>(loadSavedPresets);

  const allPresets = [...BUILTIN_PRESETS, ...savedPresets];

  useEffect(() => {
    Promise.all([
      api.getTheoremSets().catch(() => [] as TheoremSetInfo[]),
      api.getRuns().catch(() => []),
    ]).then(([sets, runs]) => {
      setTheoremSets(sets);
      if (sets.length > 0) {
        // Pick the set with the most recent run
        const setNames = new Set(sets.map((s) => s.name));
        let latestSet = "";
        let latestTime = "";
        for (const run of runs) {
          const setName = run.runId.split("/")[0];
          if (setNames.has(setName) && run.timestamp && run.timestamp > latestTime) {
            latestTime = run.timestamp;
            latestSet = setName;
          }
        }
        const best = latestSet || sets.find((s) => s.count > 0)?.name || sets[0].name;
        onChange({ ...config, theoremSet: best });
      }
    });
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch incomplete runs when continue mode is enabled
  useEffect(() => {
    if (continueMode) {
      api.getIndividualRuns().then((runs) => {
        setIncompleteRuns(runs.filter((r) => r.status === "Incomplete" || r.status === "Finished with API Errors"));
      }).catch(() => setIncompleteRuns([]));
    }
  }, [continueMode]);

  const handleContinueModeToggle = (enabled: boolean) => {
    setContinueMode(enabled);
    if (!enabled) {
      onChange({ ...config, continueRunId: null });
    }
  };

  const handleContinueRunSelect = (runId: number) => {
    onChange({ ...config, continueRunId: runId });
  };

  const selectedContinueRun = incompleteRuns.find((r) => r.runId === config.continueRunId);
  const continueLocked = continueMode && config.continueRunId != null;

  const toggleModel = (key: string) => {
    const next = config.models.includes(key)
      ? config.models.filter((m) => m !== key)
      : [...config.models, key];
    onChange({ ...config, models: next });
  };

  const addOpenRouterModel = (modelId: string) => {
    const trimmed = modelId.trim();
    if (trimmed && !config.models.includes(trimmed)) {
      onChange({ ...config, models: [...config.models, trimmed] });
    }
  };

  const removeModel = (key: string) => {
    onChange({ ...config, models: config.models.filter((m) => m !== key) });
  };

  const openRouterModels = config.models.filter((m) => !GEMINI_KEYS.has(m));

  const handleStart = () => {
    // Save any new OpenRouter models as presets for next time
    const knownKeys = new Set([...BUILTIN_KEYS, ...savedPresets.map((p) => p.key)]);
    const newPresets = openRouterModels
      .filter((m) => !knownKeys.has(m))
      .map((m) => ({ key: m, label: m }));
    if (newPresets.length > 0) {
      const updated = [...savedPresets, ...newPresets];
      setSavedPresets(updated);
      savePresets(updated);
    }
    onStart();
  };

  return (
    <div className="run-config">
      <h3 className="run-config-title">Run Configuration</h3>

      {/* Continue incomplete run */}
      <div className="config-section">
        <label className="model-checkbox">
          <input
            type="checkbox"
            checked={continueMode}
            onChange={(e) => handleContinueModeToggle(e.target.checked)}
            disabled={running}
          />
          <span className="model-checkbox-name">Continue incomplete run</span>
          <span className="model-checkbox-detail">Resume a previously interrupted run</span>
        </label>

        {continueMode && (
          <div style={{ marginTop: "0.5rem" }}>
            {incompleteRuns.length === 0 ? (
              <div className="config-detail">No incomplete runs found</div>
            ) : (
              <>
                <select
                  className="config-input"
                  value={config.continueRunId ?? ""}
                  onChange={(e) => handleContinueRunSelect(parseInt(e.target.value, 10))}
                  disabled={running}
                >
                  <option value="" disabled>Select an incomplete run...</option>
                  {incompleteRuns.map((r) => (
                    <option key={r.runId} value={r.runId}>
                      #{r.runId} — {r.modelDisplay} on {r.setName} ({r.stats.total} done, {r.startedAt.slice(0, 16).replace("T", " ")})
                    </option>
                  ))}
                </select>

                {selectedContinueRun && (
                  <div className="continue-run-info" style={{ marginTop: "0.5rem", padding: "0.5rem", background: "var(--bg-tertiary)", borderRadius: "6px", fontSize: "0.85rem" }}>
                    <div><strong>Model:</strong> {selectedContinueRun.modelDisplay}</div>
                    <div><strong>Theorem set:</strong> {selectedContinueRun.setName}</div>
                    <div><strong>Temperature:</strong> {selectedContinueRun.temperature}</div>
                    <div><strong>Max tokens:</strong> {selectedContinueRun.maxTokens}</div>
                    <div><strong>Progress:</strong> {selectedContinueRun.stats.total} theorems completed ({selectedContinueRun.stats.valid} valid, {selectedContinueRun.stats.invalid} invalid, {selectedContinueRun.stats.parseErrors} parse errors, {selectedContinueRun.stats.apiErrors} API errors)</div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Model selection */}
      <div className="config-section">
        <label className="config-label">Gemini Models</label>
        <div className="model-checkboxes">
          {MODEL_OPTIONS.map((m) => (
            <label key={m.key} className="model-checkbox">
              <input
                type="checkbox"
                checked={config.models.includes(m.key)}
                onChange={() => toggleModel(m.key)}
                disabled={running || continueLocked}
              />
              <span className="model-checkbox-name">{m.label}</span>
              <span className="model-checkbox-detail">{m.key}</span>
              <span
                className="api-dot api-dot--missing"
                title={`${m.envVar}: check server env`}
              />
            </label>
          ))}
        </div>
      </div>

      {/* OpenRouter models */}
      <div className="config-section">
        <label className="config-label">OpenRouter Models</label>

        {/* Preset dropdown */}
        <select
          className="config-input"
          value={presetValue}
          onChange={(e) => {
            if (e.target.value) {
              addOpenRouterModel(e.target.value);
              setPresetValue("");
            }
          }}
          disabled={running || continueLocked}
          style={{ marginBottom: "0.5rem" }}
        >
          <option value="">Add a preset model...</option>
          {allPresets.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label} ({p.key})
            </option>
          ))}
        </select>

        {/* Custom model input */}
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input
            className="config-input"
            type="text"
            placeholder="e.g. anthropic/claude-sonnet-4.5"
            value={customModelInput}
            onChange={(e) => setCustomModelInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && customModelInput.trim()) {
                addOpenRouterModel(customModelInput);
                setCustomModelInput("");
              }
            }}
            disabled={running || continueLocked}
            style={{ flex: 1 }}
          />
          <button
            style={{
              padding: "0.4rem 0.8rem",
              background: "var(--bg-hover)",
              color: "var(--text-primary)",
              border: "1px solid var(--border)",
              borderRadius: "4px",
              cursor: running || continueLocked ? "not-allowed" : "pointer",
              fontSize: "0.85rem",
            }}
            disabled={running || continueLocked || !customModelInput.trim()}
            onClick={() => {
              addOpenRouterModel(customModelInput);
              setCustomModelInput("");
            }}
          >
            Add
          </button>
        </div>

        {/* Added OpenRouter model chips */}
        {openRouterModels.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.5rem" }}>
            {openRouterModels.map((m) => {
              const preset = allPresets.find((p) => p.key === m);
              return (
                <span
                  key={m}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.3rem",
                    padding: "0.25rem 0.6rem",
                    background: "var(--bg-tertiary)",
                    border: "1px solid var(--border)",
                    borderRadius: "12px",
                    fontSize: "0.8rem",
                    color: "var(--text-primary)",
                  }}
                >
                  {preset ? preset.label : m}
                  <button
                    onClick={() => removeModel(m)}
                    disabled={running || continueLocked}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--text-muted)",
                      cursor: running || continueLocked ? "not-allowed" : "pointer",
                      padding: "0 2px",
                      fontSize: "0.9rem",
                      lineHeight: 1,
                    }}
                    title={`Remove ${m}`}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        )}

        <a
          href="https://openrouter.ai/models"
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "0.4rem", display: "inline-block" }}
        >
          Browse all models at openrouter.ai/models
        </a>
      </div>

      {/* Theorem set picker */}
      <div className="config-section">
        <label className="config-label" htmlFor="cfg-theorem-set">
          Theorem set
        </label>
        {theoremSets.length > 0 ? (
          <select
            id="cfg-theorem-set"
            className="config-input"
            value={config.theoremSet}
            onChange={(e) => onChange({ ...config, theoremSet: e.target.value })}
            disabled={running || continueLocked}
          >
            {theoremSets.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name} ({s.count} theorems)
              </option>
            ))}
          </select>
        ) : (
          <input
            id="cfg-theorem-set"
            className="config-input"
            type="text"
            value={config.theoremSet}
            onChange={(e) => onChange({ ...config, theoremSet: e.target.value })}
            disabled={running || continueLocked}
            placeholder="v1"
          />
        )}
      </div>

      {/* Temperature */}
      <div className="config-section">
        <label className="config-label" htmlFor="cfg-temp">
          Temperature: {config.temperature.toFixed(2)}
        </label>
        <input
          id="cfg-temp"
          className="config-slider"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={config.temperature}
          onChange={(e) =>
            onChange({ ...config, temperature: parseFloat(e.target.value) })
          }
          disabled={running || continueLocked}
        />
      </div>

      {/* Max output tokens */}
      <div className="config-section">
        <label className="config-label" htmlFor="cfg-tokens">
          Max output tokens
        </label>
        <input
          id="cfg-tokens"
          className="config-input config-input--sm"
          type="number"
          min={512}
          max={32768}
          step={512}
          value={config.maxTokens ?? ""}
          onChange={(e) =>
            onChange({
              ...config,
              maxTokens: e.target.value === "" ? null : parseInt(e.target.value, 10),
            })
          }
          disabled={running || continueLocked}
          placeholder="default"
        />
      </div>

      {/* Max thinking tokens */}
      <div className="config-section">
        <label className="config-label" htmlFor="cfg-thinking-tokens">
          Max thinking tokens
        </label>
        <input
          id="cfg-thinking-tokens"
          className="config-input config-input--sm"
          type="number"
          min={1000}
          max={128000}
          step={1000}
          value={config.maxThinkingTokens ?? ""}
          onChange={(e) =>
            onChange({
              ...config,
              maxThinkingTokens: e.target.value === "" ? null : parseInt(e.target.value, 10),
            })
          }
          disabled={running || continueLocked}
          placeholder="32768"
        />
      </div>

      {/* Tier-based output token budgets */}
      <div className="config-section">
        <label className="model-checkbox">
          <input
            type="checkbox"
            checked={config.tierBudgetsEnabled}
            onChange={(e) => onChange({ ...config, tierBudgetsEnabled: e.target.checked })}
            disabled={running || continueLocked}
          />
          <span className="model-checkbox-name">Tier-based output token budgets</span>
          <span className="model-checkbox-detail">Cap output tokens per difficulty tier to prevent spiraling</span>
        </label>

        {config.tierBudgetsEnabled && (
          <div style={{ marginTop: "0.5rem" }}>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(5, 1fr)",
              gap: "0.3rem",
              fontSize: "0.8rem",
            }}>
              {TIER_LABELS.map(({ key, label }) => (
                <div key={key} style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
                  <span style={{ color: "var(--text-secondary)", fontSize: "0.7rem", textAlign: "center" }}>{label}</span>
                  <input
                    className="config-input config-input--sm"
                    type="number"
                    min={512}
                    max={65536}
                    step={512}
                    value={config.tierBudgets[key]}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val)) {
                        const updated = { ...config.tierBudgets, [key]: val };
                        saveTierBudgets(updated);
                        onChange({ ...config, tierBudgets: updated });
                      }
                    }}
                    disabled={running || continueLocked}
                    style={{ textAlign: "center", fontSize: "0.75rem", padding: "0.2rem" }}
                  />
                </div>
              ))}
            </div>
            <button
              style={{
                marginTop: "0.4rem",
                padding: "0.2rem 0.6rem",
                background: "transparent",
                color: "var(--text-secondary)",
                border: "1px solid var(--border)",
                borderRadius: "4px",
                cursor: running || continueLocked ? "not-allowed" : "pointer",
                fontSize: "0.7rem",
              }}
              disabled={running || continueLocked}
              onClick={() => {
                saveTierBudgets(DEFAULT_TIER_BUDGETS);
                onChange({ ...config, tierBudgets: { ...DEFAULT_TIER_BUDGETS } });
              }}
            >
              Reset to defaults
            </button>
          </div>
        )}
      </div>

      {/* Parallel workers */}
      <div className="config-section">
        <label className="config-label" htmlFor="cfg-workers">
          Parallel workers
        </label>
        <input
          id="cfg-workers"
          className="config-input config-input--sm"
          type="number"
          min={1}
          max={10}
          value={config.workers ?? ""}
          onChange={(e) =>
            onChange({
              ...config,
              workers: e.target.value === "" ? null : parseInt(e.target.value, 10),
            })
          }
          disabled={running}
          placeholder="1"
        />
      </div>

      {/* Theorem range */}
      <div className="config-section config-section--row">
        <div>
          <label className="config-label" htmlFor="cfg-start">
            Start index
          </label>
          <input
            id="cfg-start"
            className="config-input config-input--sm"
            type="number"
            min={0}
            value={config.startIndex ?? ""}
            onChange={(e) =>
              onChange({
                ...config,
                startIndex: e.target.value === "" ? null : parseInt(e.target.value, 10),
              })
            }
            disabled={running || continueLocked}
            placeholder="0"
          />
        </div>
        <div>
          <label className="config-label" htmlFor="cfg-count">
            Count (blank = all)
          </label>
          <input
            id="cfg-count"
            className="config-input config-input--sm"
            type="text"
            placeholder="all"
            value={config.count}
            onChange={(e) => onChange({ ...config, count: e.target.value })}
            disabled={running || continueLocked}
          />
        </div>
      </div>

      {/* Force new run */}
      <div className="config-section">
        <label className="model-checkbox">
          <input
            type="checkbox"
            checked={config.force}
            onChange={(e) => onChange({ ...config, force: e.target.checked })}
            disabled={running || continueLocked}
          />
          <span className="model-checkbox-name">Force new run</span>
          <span className="model-checkbox-detail">Don't skip completed theorems</span>
        </label>
        <label className="model-checkbox">
          <input
            type="checkbox"
            checked={config.noRetryParse}
            onChange={(e) => onChange({ ...config, noRetryParse: e.target.checked })}
            disabled={running || continueLocked}
          />
          <span className="model-checkbox-name">Don't retry parse errors</span>
          <span className="model-checkbox-detail">Treat unparseable output as final</span>
        </label>
      </div>

      {/* Sequential runs */}
      <div className="config-section">
        <label className="config-label" htmlFor="cfg-runs">
          Sequential Runs
        </label>
        <input
          id="cfg-runs"
          className="config-input config-input--sm"
          type="number"
          min={1}
          max={100}
          value={config.runs}
          onChange={(e) =>
            onChange({
              ...config,
              runs: Math.max(1, parseInt(e.target.value, 10) || 1),
            })
          }
          disabled={running || continueLocked}
          placeholder="1"
        />
        <span className="config-detail">Run the benchmark N times back-to-back</span>
      </div>

      {/* Max cost */}
      <div className="config-section">
        <label className="config-label" htmlFor="cfg-max-cost">
          Max cost ($)
        </label>
        <input
          id="cfg-max-cost"
          className="config-input config-input--sm"
          type="number"
          min={0.01}
          step={0.5}
          value={config.maxCost ?? ""}
          onChange={(e) =>
            onChange({
              ...config,
              maxCost: e.target.value === "" ? null : parseFloat(e.target.value),
            })
          }
          disabled={running}
          placeholder="no limit"
        />
        <span className="config-detail">Abort run when estimated cost exceeds this amount</span>
      </div>

      {/* Start button */}
      <button
        className="btn-start"
        disabled={running || (continueLocked ? false : config.models.length === 0) || (continueMode && config.continueRunId == null)}
        onClick={handleStart}
      >
        {running ? "Running..." : continueLocked ? "Continue Run" : "Start Benchmark"}
      </button>

      {/* CLI command reference (collapsible) */}
      <button
        className="btn-toggle-command"
        onClick={() => setShowCommand((v) => !v)}
      >
        {showCommand ? "Hide" : "Show"} CLI command
      </button>
      {showCommand && (
        <div className="command-block">
          <div className="command-block-header">
            <span>CLI Command</span>
            <button
              className="btn-copy"
              onClick={() =>
                navigator.clipboard.writeText(buildCommand(config))
              }
            >
              Copy
            </button>
          </div>
          <pre className="command-text">{buildCommand(config)}</pre>
        </div>
      )}
    </div>
  );
}

export default RunConfig;
