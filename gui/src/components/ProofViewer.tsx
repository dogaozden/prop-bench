import { useState } from "react";
import type { ProofLine, ProofResult } from "../types";

interface ProofViewerProps {
  model: string;
  lines: ProofLine[];
  result: ProofResult;
  parseErrors?: string[];
  rawResponse?: string;
  latencyMs?: number;
}

/** Render logic symbols in Unicode. */
function renderFormula(raw: string): string {
  return raw
    .replace(/#/g, "⊥")
    .replace(/ <> /g, " ≡ ")
    .replace(/ > /g, " ⊃ ")
    .replace(/ \. /g, " · ")
    .replace(/ v /g, " ∨ ");
}

export default function ProofViewer({
  model,
  lines,
  result,
  parseErrors,
  rawResponse,
  latencyMs,
}: ProofViewerProps) {
  const [showRaw, setShowRaw] = useState(false);
  const hasErrors =
    result.errors.length > 0 || (parseErrors && parseErrors.length > 0);

  return (
    <div className="proof-viewer">
      <div className="proof-viewer-header">
        <span className="proof-viewer-model">{model}</span>
        <span className="proof-viewer-line-count">
          {result.line_count} lines
        </span>
        {result.valid ? (
          <span className="proof-viewer-valid">Valid</span>
        ) : (
          <span className="proof-viewer-invalid">Invalid</span>
        )}
      </div>

      <div className="proof-lines">
        {lines.map((line) => (
          <div
            key={line.line_number}
            className={`proof-line ${result.valid ? "proof-line--valid" : "proof-line--invalid"}`}
          >
            <span className="proof-line-number">{line.line_number}</span>
            <span className="proof-line-depth">
              {Array.from({ length: line.depth }, (_, i) => (
                <span key={i} className="proof-line-bar" />
              ))}
            </span>
            <span className="proof-line-formula">
              {renderFormula(line.formula)}
            </span>
            <span className="proof-line-justification">
              {line.justification}
            </span>
          </div>
        ))}
      </div>

      {hasErrors && (
        <div className="proof-errors">
          <h5>Errors</h5>
          <ul>
            {result.errors.map((err, i) => (
              <li key={`v-${i}`}>{err}</li>
            ))}
            {parseErrors?.map((err, i) => (
              <li key={`p-${i}`}>{err}</li>
            ))}
          </ul>
        </div>
      )}

      {latencyMs !== undefined && (
        <div className="proof-latency">
          <span className="meta-label">Latency:</span> {latencyMs}ms
        </div>
      )}

      {rawResponse !== undefined && (
        <div className="proof-raw">
          <button
            className="proof-raw-toggle"
            onClick={() => setShowRaw(!showRaw)}
          >
            {showRaw ? "Hide" : "Show"} Raw Model Response
          </button>
          {showRaw && (
            <pre className="proof-raw-content">{rawResponse}</pre>
          )}
        </div>
      )}
    </div>
  );
}
