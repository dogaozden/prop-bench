import { useState } from "react";
import type { Theorem, BenchmarkResult } from "../types";
import ProofViewer from "./ProofViewer";
import ProofComparison from "./ProofComparison";

interface TheoremDetailProps {
  theorem: Theorem;
  /** Benchmark results for this theorem, keyed by model name. Undefined if no results loaded. */
  resultsByModel?: Record<string, BenchmarkResult>;
}

/** Render a formula string with Unicode logic symbols. */
function renderFormula(raw: string): string {
  return raw
    .replace(/#/g, "⊥")
    .replace(/ <> /g, " ≡ ")
    .replace(/ > /g, " ⊃ ")
    .replace(/ \. /g, " · ")
    .replace(/ v /g, " ∨ ");
}

type ViewMode = "proofs" | "compare";

export default function TheoremDetail({
  theorem,
  resultsByModel,
}: TheoremDetailProps) {
  const models = resultsByModel ? Object.keys(resultsByModel) : [];
  const [selectedModel, setSelectedModel] = useState<string>(models[0] ?? "");
  const [viewMode, setViewMode] = useState<ViewMode>("proofs");

  // Reset selected model when theorem or results change
  const currentModels = resultsByModel ? Object.keys(resultsByModel) : [];
  if (selectedModel && !currentModels.includes(selectedModel) && currentModels.length > 0) {
    setSelectedModel(currentModels[0]);
  }

  const difficultyClass = `difficulty-badge difficulty-badge--${theorem.difficulty.toLowerCase()}`;

  return (
    <div className="theorem-detail">
      <div className="theorem-detail-header">
        <h3>{theorem.id}</h3>
        <span className={difficultyClass}>{theorem.difficulty}</span>
      </div>

      <div className="theorem-detail-meta">
        <div className="theorem-detail-meta-item">
          <span className="meta-label">Difficulty Value</span>
          <span className="meta-value">{theorem.difficulty_value}</span>
        </div>
        <div className="theorem-detail-meta-item">
          <span className="meta-label">Premises</span>
          <span className="meta-value">{theorem.premises.length}</span>
        </div>
        {models.length > 0 && (
          <div className="theorem-detail-meta-item">
            <span className="meta-label">Models Tested</span>
            <span className="meta-value">{models.length}</span>
          </div>
        )}
      </div>

      <div className="theorem-detail-formula">
        {theorem.premises.map((p, i) => (
          <div key={i} className="premise-line">
            {i + 1}. {renderFormula(p)}
          </div>
        ))}
        <div className="conclusion-line">
          <span className="turnstile">{"\u2234"}</span>
          {renderFormula(theorem.conclusion)}
        </div>
      </div>

      {models.length > 0 && resultsByModel && (
        <div className="theorem-detail-proofs">
          <h4>Proofs</h4>

          <div className="proof-tabs">
            {models.map((m) => (
              <button
                key={m}
                className={`proof-tab ${viewMode === "proofs" && selectedModel === m ? "proof-tab--active" : ""}`}
                onClick={() => {
                  setSelectedModel(m);
                  setViewMode("proofs");
                }}
              >
                {m}
                {resultsByModel[m] && (
                  <> ({resultsByModel[m].result.valid ? "valid" : "invalid"})</>
                )}
              </button>
            ))}
            {models.length >= 2 && (
              <button
                className={`proof-tab proof-tab--compare ${viewMode === "compare" ? "proof-tab--active" : ""}`}
                onClick={() => setViewMode("compare")}
              >
                Compare
              </button>
            )}
          </div>

          {viewMode === "proofs" && selectedModel && resultsByModel[selectedModel] && (
            <ProofViewer
              model={selectedModel}
              lines={resultsByModel[selectedModel].proof_lines}
              result={resultsByModel[selectedModel].result}
              parseErrors={resultsByModel[selectedModel].parse_errors}
              rawResponse={resultsByModel[selectedModel].raw_response}
              latencyMs={resultsByModel[selectedModel].latency_ms}
            />
          )}

          {viewMode === "compare" && (
            <ProofComparison resultsByModel={resultsByModel} />
          )}
        </div>
      )}

      {models.length === 0 && (
        <div style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 16 }}>
          No benchmark results loaded. Load a results file on the Dashboard to see proofs.
        </div>
      )}
    </div>
  );
}
