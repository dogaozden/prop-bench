import { useState, useEffect, useCallback } from "react";
import { api } from "../api/client";
import type { RunInfo } from "../api/client";

interface RunHistoryProps {
  refreshTrigger: number;
  onViewResults: (runId: string) => void;
}

function RunHistory({ refreshTrigger, onViewResults }: RunHistoryProps) {
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadRuns = useCallback(() => {
    setLoading(true);
    setError("");
    api
      .getRuns()
      .then((data) => {
        setRuns(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load runs");
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    loadRuns();
  }, [loadRuns, refreshTrigger]);

  const handleDelete = useCallback((runId: string) => {
    if (!window.confirm("Delete this run? This cannot be undone.")) return;
    api
      .deleteRun(runId)
      .then(() => {
        setRuns((prev) => prev.filter((r) => r.runId !== runId));
      })
      .catch((err) => {
        setError(
          err instanceof Error ? err.message : "Failed to delete run",
        );
      });
  }, []);

  if (loading) {
    return (
      <div className="run-history">
        <h3 className="run-history-title">Run History</h3>
        <p className="run-history-empty">Loading runs...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="run-history">
        <h3 className="run-history-title">Run History</h3>
        <p className="run-history-error">{error}</p>
        <button className="btn-sm" onClick={loadRuns}>
          Retry
        </button>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="run-history">
        <h3 className="run-history-title">Run History</h3>
        <p className="run-history-empty">
          No past runs. Start a benchmark to build history.
        </p>
      </div>
    );
  }

  return (
    <div className="run-history">
      <h3 className="run-history-title">Run History</h3>
      <div className="run-history-list">
        {runs.map((run) => (
          <div key={run.runId} className="run-history-item">
            <div className="run-history-item-info">
              {run.timestamp && (
                <span className="run-history-ts">
                  {new Date(run.timestamp).toLocaleString()}
                </span>
              )}
              <span className="run-history-models">
                {run.models.join(", ")}
              </span>
              <span className="run-history-counts">
                {run.stats.total_run} theorems &mdash;{" "}
                <span className="text-success">{run.stats.total_valid}v</span>
                {" / "}
                <span className="text-error">{run.stats.total_invalid}i</span>
                {run.stats.total_parse_errors > 0 && (
                  <>
                    {" / "}
                    <span className="text-warning">{run.stats.total_parse_errors}ep</span>
                  </>
                )}
                {run.stats.total_api_errors > 0 && (
                  <>
                    {" / "}
                    <span className="text-warning">{run.stats.total_api_errors}ea</span>
                  </>
                )}
              </span>
            </div>
            <div className="run-history-actions">
              <button
                className="btn-sm"
                onClick={() => onViewResults(run.runId)}
              >
                View
              </button>
              <button
                className="btn-sm btn-sm--danger"
                onClick={() => handleDelete(run.runId)}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export type { RunInfo };
export default RunHistory;
