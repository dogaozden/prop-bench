import { useState, useEffect } from "react";
import { api } from "../api/client";
import type { DifficultySpec, BaseComplexity } from "../types";

interface GenerateTheoremsProps {
  onClose: () => void;
  onGenerated: (setName: string) => void;
}

type GenerateMode = "distribution" | "tier" | "custom";

const DEFAULT_TOTAL = 100;
const DEFAULT_DIST: Record<string, number | null> = {
  baby: null,
  easy: null,
  medium: null,
  hard: null,
  expert: null,
  nightmare: null,
  marathon: null,
  absurd: null,
  cosmic: null,
  mind: null,
};

const TIER_OPTIONS = [
  "baby", "easy", "medium", "hard", "expert", "nightmare",
  "marathon", "absurd", "cosmic", "mind",
] as const;

export default function GenerateTheorems({
  onClose,
  onGenerated,
}: GenerateTheoremsProps) {
  const [name, setName] = useState("");
  const [total, setTotal] = useState<number | null>(DEFAULT_TOTAL);
  const [mode, setMode] = useState<GenerateMode>("distribution");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  // Tier presets state
  const [tierPresets, setTierPresets] = useState<Record<string, DifficultySpec> | null>(null);
  const [presetsLoading, setPresetsLoading] = useState(true);
  const [presetsDirty, setPresetsDirty] = useState(false);
  const [presetsSaving, setPresetsSaving] = useState(false);
  const [presetsError, setPresetsError] = useState("");

  // Distribution mode state
  const [dist, setDist] = useState({ ...DEFAULT_DIST });

  // Tier mode state
  const [tier, setTier] = useState("easy");

  // Custom spec mode state
  const [spec, setSpec] = useState<DifficultySpec>({
    variables: 3,
    passes: 1,
    transforms_per_pass: 5,
    base_complexity: "simple",
    substitution_depth: 0,
    bridge_atoms: 0,
  });

  // Max nodes (optional AST node limit)
  const [maxNodes, setMaxNodes] = useState<number | null>(null);
  // Max depth (optional nesting depth limit)
  const [maxDepth, setMaxDepth] = useState<number | null>(null);

  // Load tier presets from API on mount
  useEffect(() => {
    api.getTierPresets()
      .then(p => { setTierPresets(p); setPresetsLoading(false); })
      .catch(err => { setPresetsError(String(err)); setPresetsLoading(false); });
  }, []);

  const sum = Object.values(dist).reduce<number>((a, b) => a + (b ?? 0), 0);

  const isValid = (() => {
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name) || !total || total < 1) return false;
    if (mode === "distribution") return sum === total;
    return true;
  })();

  const handleGenerate = async () => {
    if (!isValid) return;
    setGenerating(true);
    setError("");

    const count = total ?? DEFAULT_TOTAL;
    const opts = { count, name, ...(maxNodes != null && { maxNodes }), ...(maxDepth != null && { maxDepth }) };
    try {
      if (mode === "distribution") {
        const distribution = Object.entries(dist)
          .filter(([, c]) => (c ?? 0) > 0)
          .map(([tier, c]) => `${c}:${tier}`)
          .join(",");
        await api.generate({ ...opts, distribution });
      } else if (mode === "tier") {
        await api.generate({ ...opts, tier });
      } else {
        await api.generate({ ...opts, spec });
      }
      onGenerated(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  const handleDistChange = (t: string, value: number | null) => {
    setDist((prev) => ({ ...prev, [t]: value }));
  };

  const tierPreview = tierPresets?.[tier];

  return (
    <div className="generate-modal-backdrop">
      <div className="generate-modal">
        <div className="generate-modal-header">
          <h3>Generate New Theorem Set</h3>
          <button className="generate-modal-close" onClick={onClose}>
            X
          </button>
        </div>

        <div className="generate-form">
          <label className="generate-field">
            <span className="generate-label">Set Name</span>
            <input
              type="text"
              className="theorem-search"
              placeholder="e.g. v2, test-set"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={generating}
            />
            {name && !/^[a-zA-Z0-9_-]+$/.test(name) && (
              <span className="generate-error">
                Alphanumeric, dashes, and underscores only
              </span>
            )}
          </label>

          <label className="generate-field">
            <span className="generate-label">Total Count</span>
            <input
              type="number"
              className="theorem-search"
              min={1}
              value={total ?? ""}
              onChange={(e) => setTotal(e.target.value === "" ? null : parseInt(e.target.value, 10))}
              disabled={generating}
              placeholder="100"
            />
          </label>

          <label className="generate-field">
            <span className="generate-label">Max Formula Nodes (optional)</span>
            <input
              type="number"
              className="theorem-search"
              min={1000}
              value={maxNodes ?? ""}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                setMaxNodes(Number.isNaN(v) ? null : Math.max(1000, v));
              }}
              disabled={generating}
              placeholder="20000 (default)"
            />
            <span style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
              AST node limit for obfuscation pipeline
            </span>
          </label>

          <label className="generate-field">
            <span className="generate-label">Max Formula Depth (optional)</span>
            <input
              type="number"
              className="theorem-search"
              min={1}
              value={maxDepth ?? ""}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                setMaxDepth(Number.isNaN(v) ? null : Math.max(1, v));
              }}
              disabled={generating}
              placeholder="100 (default)"
            />
            <span style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
              Nesting depth limit for obfuscation pipeline
            </span>
          </label>

          {/* Mode selector tabs */}
          <div className="generate-field">
            <span className="generate-label">Generation Mode</span>
            <div className="generate-mode-tabs">
              {(["distribution", "tier", "custom"] as const).map((m) => (
                <button
                  key={m}
                  className={`generate-mode-tab${mode === m ? " generate-mode-tab--active" : ""}`}
                  onClick={() => setMode(m)}
                  disabled={generating}
                >
                  {m === "distribution" ? "Distribution" : m === "tier" ? "Tier Preset" : "Custom Spec"}
                </button>
              ))}
            </div>
          </div>

          {/* Distribution mode */}
          {mode === "distribution" && (
            <div className="generate-field">
              <span className="generate-label">Difficulty Distribution</span>
              <div className="generate-dist-grid">
                {(
                  ["baby", "easy", "medium", "hard", "expert", "nightmare", "marathon", "absurd", "cosmic", "mind"] as const
                ).map((t) => (
                  <label key={t} className="generate-dist-item">
                    <span className={`difficulty-badge difficulty-badge--${t}`}>
                      {t}
                    </span>
                    <input
                      type="number"
                      className="theorem-search generate-dist-input"
                      min={0}
                      value={dist[t] ?? ""}
                      onChange={(e) =>
                        handleDistChange(t, e.target.value === "" ? null : parseInt(e.target.value, 10))
                      }
                      disabled={generating}
                      placeholder="0"
                    />
                  </label>
                ))}
              </div>
              <div
                className="generate-dist-sum"
                style={{ color: total != null && sum === total ? "var(--success)" : "var(--error)" }}
              >
                Sum: {sum} / {total ?? "?"}
                {(total == null || sum !== total) && " (must equal total)"}
              </div>
            </div>
          )}

          {/* Tier mode */}
          {mode === "tier" && (
            <div className="generate-field">
              <span className="generate-label">Difficulty Tier</span>
              <select
                className="difficulty-filter"
                value={tier}
                onChange={(e) => setTier(e.target.value)}
                disabled={generating || presetsLoading}
                style={{ width: "100%", marginBottom: 12 }}
              >
                {TIER_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </option>
                ))}
              </select>

              {presetsLoading && (
                <div style={{ color: "var(--text-muted)", fontSize: 14, marginTop: 8 }}>
                  Loading presets...
                </div>
              )}

              {presetsError && (
                <div className="generate-error" style={{ marginTop: 8 }}>
                  Failed to load presets: {presetsError}
                </div>
              )}

              {tierPresets && tierPreview && (
                <>
                  <div className="generate-spec-grid" style={{ marginTop: 12 }}>
                    <label className="generate-spec-input-item">
                      <span className="generate-spec-label">Variables (2+)</span>
                      <input
                        type="number"
                        className="theorem-search"
                        min={2}
                        value={tierPreview.variables}
                        onChange={(e) => {
                          const val = Math.max(2, parseInt(e.target.value) || 2);
                          setTierPresets(prev => prev ? {
                            ...prev,
                            [tier]: { ...prev[tier], variables: val }
                          } : prev);
                          setPresetsDirty(true);
                        }}
                        disabled={generating}
                      />
                    </label>
                    <label className="generate-spec-input-item">
                      <span className="generate-spec-label">Passes (1+)</span>
                      <input
                        type="number"
                        className="theorem-search"
                        min={1}
                        value={tierPreview.passes}
                        onChange={(e) => {
                          const val = Math.max(1, parseInt(e.target.value) || 1);
                          setTierPresets(prev => prev ? {
                            ...prev,
                            [tier]: { ...prev[tier], passes: val }
                          } : prev);
                          setPresetsDirty(true);
                        }}
                        disabled={generating}
                      />
                    </label>
                    <label className="generate-spec-input-item">
                      <span className="generate-spec-label">Transforms/pass (1+)</span>
                      <input
                        type="number"
                        className="theorem-search"
                        min={1}
                        value={tierPreview.transforms_per_pass}
                        onChange={(e) => {
                          const val = Math.max(1, parseInt(e.target.value) || 1);
                          setTierPresets(prev => prev ? {
                            ...prev,
                            [tier]: { ...prev[tier], transforms_per_pass: val }
                          } : prev);
                          setPresetsDirty(true);
                        }}
                        disabled={generating}
                      />
                    </label>
                    <label className="generate-spec-input-item">
                      <span className="generate-spec-label">Base complexity</span>
                      <div className="generate-radio-group">
                        {(["simple", "complex"] as const).map((bc) => (
                          <label key={bc} className="generate-radio-item">
                            <input
                              type="radio"
                              name="base_complexity"
                              checked={tierPreview.base_complexity === bc}
                              onChange={() => {
                                setTierPresets(prev => prev ? {
                                  ...prev,
                                  [tier]: { ...prev[tier], base_complexity: bc as BaseComplexity }
                                } : prev);
                                setPresetsDirty(true);
                              }}
                              disabled={generating}
                            />
                            <span>{bc}</span>
                          </label>
                        ))}
                      </div>
                    </label>
                    <label className="generate-spec-input-item">
                      <span className="generate-spec-label">Substitution depth (0+)</span>
                      <input
                        type="number"
                        className="theorem-search"
                        min={0}
                        value={tierPreview.substitution_depth}
                        onChange={(e) => {
                          const val = Math.max(0, parseInt(e.target.value) || 0);
                          setTierPresets(prev => prev ? {
                            ...prev,
                            [tier]: { ...prev[tier], substitution_depth: val }
                          } : prev);
                          setPresetsDirty(true);
                        }}
                        disabled={generating}
                      />
                    </label>
                    <label className="generate-spec-input-item">
                      <span className="generate-spec-label">Bridge atoms (0+)</span>
                      <input
                        type="number"
                        className="theorem-search"
                        min={0}
                        max={5}
                        value={tierPreview.bridge_atoms ?? 0}
                        onChange={(e) => {
                          const val = Math.max(0, parseInt(e.target.value) || 0);
                          setTierPresets(prev => prev ? {
                            ...prev,
                            [tier]: { ...prev[tier], bridge_atoms: val }
                          } : prev);
                          setPresetsDirty(true);
                        }}
                        disabled={generating}
                      />
                    </label>
                  </div>

                  {presetsDirty && (
                    <button
                      className="generate-btn generate-btn--secondary"
                      style={{ marginTop: 12, width: "100%" }}
                      onClick={async () => {
                        if (!tierPresets) return;
                        setPresetsSaving(true);
                        setPresetsError("");
                        try {
                          await api.saveTierPresets(tierPresets);
                          setPresetsDirty(false);
                        } catch (err) {
                          setPresetsError(err instanceof Error ? err.message : String(err));
                        } finally {
                          setPresetsSaving(false);
                        }
                      }}
                      disabled={presetsSaving}
                    >
                      {presetsSaving ? "Saving..." : "Save Preset Changes"}
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {/* Custom spec mode */}
          {mode === "custom" && (
            <div className="generate-field">
              <span className="generate-label">Custom Spec</span>
              <div className="generate-spec-grid">
                <label className="generate-spec-input-item">
                  <span className="generate-spec-label">Variables (2+)</span>
                  <input
                    type="number"
                    className="theorem-search"
                    min={2}
                    value={spec.variables}
                    onChange={(e) =>
                      setSpec((s) => ({ ...s, variables: Math.max(2, parseInt(e.target.value) || 2) }))
                    }
                    disabled={generating}
                  />
                </label>
                <label className="generate-spec-input-item">
                  <span className="generate-spec-label">Passes (1+)</span>
                  <input
                    type="number"
                    className="theorem-search"
                    min={1}
                    value={spec.passes}
                    onChange={(e) =>
                      setSpec((s) => ({ ...s, passes: Math.max(1, parseInt(e.target.value) || 1) }))
                    }
                    disabled={generating}
                  />
                </label>
                <label className="generate-spec-input-item">
                  <span className="generate-spec-label">Transforms/pass (1+)</span>
                  <input
                    type="number"
                    className="theorem-search"
                    min={1}
                    value={spec.transforms_per_pass}
                    onChange={(e) =>
                      setSpec((s) => ({ ...s, transforms_per_pass: Math.max(1, parseInt(e.target.value) || 1) }))
                    }
                    disabled={generating}
                  />
                </label>
                <label className="generate-spec-input-item">
                  <span className="generate-spec-label">Base complexity</span>
                  <div className="generate-radio-group">
                    {(["simple", "complex"] as const).map((bc) => (
                      <label key={bc} className="generate-radio-item">
                        <input
                          type="radio"
                          name="base_complexity"
                          checked={spec.base_complexity === bc}
                          onChange={() =>
                            setSpec((s) => ({ ...s, base_complexity: bc as BaseComplexity }))
                          }
                          disabled={generating}
                        />
                        <span>{bc}</span>
                      </label>
                    ))}
                  </div>
                </label>
                <label className="generate-spec-input-item">
                  <span className="generate-spec-label">Substitution depth (0+)</span>
                  <input
                    type="number"
                    className="theorem-search"
                    min={0}
                    value={spec.substitution_depth}
                    onChange={(e) =>
                      setSpec((s) => ({ ...s, substitution_depth: Math.max(0, parseInt(e.target.value) || 0) }))
                    }
                    disabled={generating}
                  />
                </label>
                <label className="generate-spec-input-item">
                  <span className="generate-spec-label">Bridge atoms (0+)</span>
                  <input
                    type="number"
                    className="theorem-search"
                    min={0}
                    max={5}
                    value={spec.bridge_atoms ?? 0}
                    onChange={(e) =>
                      setSpec((s) => ({ ...s, bridge_atoms: Math.max(0, parseInt(e.target.value) || 0) }))
                    }
                    disabled={generating}
                  />
                </label>
              </div>
            </div>
          )}

          {error && (
            <div className="generate-error" style={{ marginTop: 8 }}>
              {error}
            </div>
          )}

          <div className="generate-actions">
            <button
              className="generate-btn generate-btn--secondary"
              onClick={onClose}
              disabled={generating}
            >
              Cancel
            </button>
            <button
              className="generate-btn generate-btn--primary"
              onClick={handleGenerate}
              disabled={!isValid || generating}
            >
              {generating ? "Generating..." : "Generate"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
