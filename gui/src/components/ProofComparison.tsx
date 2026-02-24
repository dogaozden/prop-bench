import { useState } from "react";
import type { BenchmarkResult } from "../types";
import ProofViewer from "./ProofViewer";

interface ProofComparisonProps {
  /** All benchmark results for the current theorem, keyed by model name. */
  resultsByModel: Record<string, BenchmarkResult>;
}

export default function ProofComparison({
  resultsByModel,
}: ProofComparisonProps) {
  const models = Object.keys(resultsByModel);

  const [modelA, setModelA] = useState<string>(models[0] ?? "");
  const [modelB, setModelB] = useState<string>(models[1] ?? models[0] ?? "");

  if (models.length < 2) {
    return (
      <div className="proof-comparison" style={{ color: "var(--text-muted)", fontSize: 13 }}>
        Need at least 2 models to compare.
      </div>
    );
  }

  const resultA = resultsByModel[modelA];
  const resultB = resultsByModel[modelB];

  // Determine winner
  let winnerLabel: React.ReactNode = null;
  if (resultA && resultB) {
    const aValid = resultA.result.valid;
    const bValid = resultB.result.valid;
    const aLines = resultA.result.line_count;
    const bLines = resultB.result.line_count;

    if (aValid && !bValid) {
      winnerLabel = (
        <span>
          <span className="winner-label">{modelA} wins</span>
          <span className="line-diff">(valid vs invalid)</span>
        </span>
      );
    } else if (!aValid && bValid) {
      winnerLabel = (
        <span>
          <span className="winner-label">{modelB} wins</span>
          <span className="line-diff">(valid vs invalid)</span>
        </span>
      );
    } else if (aValid && bValid) {
      if (aLines < bLines) {
        winnerLabel = (
          <span>
            <span className="winner-label">{modelA} wins</span>
            <span className="line-diff">({aLines} vs {bLines} lines, {bLines - aLines} fewer)</span>
          </span>
        );
      } else if (bLines < aLines) {
        winnerLabel = (
          <span>
            <span className="winner-label">{modelB} wins</span>
            <span className="line-diff">({bLines} vs {aLines} lines, {aLines - bLines} fewer)</span>
          </span>
        );
      } else {
        winnerLabel = (
          <span>
            <span className="tie-label">Tie</span>
            <span className="line-diff">({aLines} lines each)</span>
          </span>
        );
      }
    } else {
      winnerLabel = <span className="tie-label">Tie (both invalid)</span>;
    }
  }

  return (
    <div className="proof-comparison">
      <div className="proof-comparison-selectors">
        <label>Model A:</label>
        <select value={modelA} onChange={(e) => setModelA(e.target.value)}>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <span className="proof-comparison-vs">vs</span>
        <label>Model B:</label>
        <select value={modelB} onChange={(e) => setModelB(e.target.value)}>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <div className="proof-comparison-grid">
        {resultA ? (
          <ProofViewer
            model={modelA}
            lines={resultA.proof_lines}
            result={resultA.result}
            parseErrors={resultA.parse_errors}
          />
        ) : (
          <div className="proof-viewer" style={{ color: "var(--text-muted)" }}>
            No result for {modelA}
          </div>
        )}
        {resultB ? (
          <ProofViewer
            model={modelB}
            lines={resultB.proof_lines}
            result={resultB.result}
            parseErrors={resultB.parse_errors}
          />
        ) : (
          <div className="proof-viewer" style={{ color: "var(--text-muted)" }}>
            No result for {modelB}
          </div>
        )}
      </div>

      {winnerLabel && (
        <div className="proof-comparison-winner">{winnerLabel}</div>
      )}
    </div>
  );
}
