import { useState, useEffect, useCallback } from "react";
import type { Theorem, Difficulty, BenchmarkResult } from "../types";
import { api } from "../api/client";
import TheoremList from "../components/TheoremList";
import TheoremDetail from "../components/TheoremDetail";
import TheoremSetPicker from "../components/TheoremSetPicker";
import GenerateTheorems from "../components/GenerateTheorems";
import "../styles/theorems.css";

export default function TheoremExplorer() {
  const [theorems, setTheorems] = useState<Theorem[]>([]);
  const [selectedSet, setSelectedSet] = useState<string>("");
  const [loadingTheorems, setLoadingTheorems] = useState(false);
  const [theoremsError, setTheoremsError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [showGenerate, setShowGenerate] = useState(false);

  // Benchmark results state (optional, loaded from file)
  const [benchmarkResults, setBenchmarkResults] = useState<
    BenchmarkResult[] | null
  >(null);
  const [resultsFileName, setResultsFileName] = useState("");

  // Selection / filter state
  const [selectedTheorem, setSelectedTheorem] = useState<Theorem | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [difficultyFilter, setDifficultyFilter] = useState<Difficulty | "All">(
    "All"
  );

  // Load theorems when the selected set changes
  useEffect(() => {
    if (!selectedSet) return;

    setLoadingTheorems(true);
    setTheoremsError("");
    setSelectedTheorem(null);
    setConfirmDelete(false);

    api
      .getTheorems(selectedSet)
      .then((data) => {
        setTheorems(data);
      })
      .catch((err) => {
        setTheoremsError(err.message);
        setTheorems([]);
      })
      .finally(() => setLoadingTheorems(false));
  }, [selectedSet]);

  // Handle loading benchmark results file
  const handleResultsFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setResultsFileName(file.name);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = JSON.parse(evt.target?.result as string);
        // Accept either an array of BenchmarkResult or a report with .results
        if (Array.isArray(data)) {
          setBenchmarkResults(data as BenchmarkResult[]);
        } else if (data.results && Array.isArray(data.results)) {
          setBenchmarkResults(data.results as BenchmarkResult[]);
        } else if (data.models && Array.isArray(data.models)) {
          // BenchmarkReport format -- collect results from all model summaries
          const allResults: BenchmarkResult[] = [];
          for (const modelSummary of data.models) {
            if (modelSummary.results && Array.isArray(modelSummary.results)) {
              allResults.push(...modelSummary.results);
            }
          }
          setBenchmarkResults(allResults.length > 0 ? allResults : null);
        } else {
          setBenchmarkResults(null);
        }
      } catch {
        setBenchmarkResults(null);
      }
    };
    reader.readAsText(file);
  };

  // Build per-theorem results map for the selected theorem
  const getResultsForTheorem = (
    theoremId: string
  ): Record<string, BenchmarkResult> | undefined => {
    if (!benchmarkResults) return undefined;
    const map: Record<string, BenchmarkResult> = {};
    for (const r of benchmarkResults) {
      if (r.theorem_id === theoremId) {
        map[r.model] = r;
      }
    }
    return Object.keys(map).length > 0 ? map : undefined;
  };

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = useCallback(async () => {
    if (!selectedSet) return;
    setDeleting(true);
    try {
      await api.deleteTheoremSet(selectedSet);
      setSelectedSet("");
      setTheorems([]);
      setConfirmDelete(false);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setTheoremsError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }, [selectedSet]);

  const handleGenerated = (setName: string) => {
    setShowGenerate(false);
    setRefreshKey((k) => k + 1);
    setSelectedSet(setName);
  };

  return (
    <div className="theorem-explorer">
      <div className="theorem-explorer-header">
        <h2>Theorem Explorer</h2>
        <p>
          Browse theorems from the PropBench suite.
        </p>
      </div>

      <div className="theorem-explorer-toolbar">
        <TheoremSetPicker
          selectedSet={selectedSet}
          onSelect={setSelectedSet}
          refreshKey={refreshKey}
        />
        <button
          className="generate-btn generate-btn--primary"
          onClick={() => setShowGenerate(true)}
        >
          Generate New Set
        </button>
        {selectedSet && !confirmDelete && (
          <button
            className="generate-btn generate-btn--danger"
            onClick={() => setConfirmDelete(true)}
          >
            Delete Set
          </button>
        )}
        {confirmDelete && (
          <span className="delete-confirm">
            <span className="delete-confirm-label">Delete "{selectedSet}"?</span>
            <button
              className="generate-btn generate-btn--danger"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? "Deleting..." : "Yes, Delete"}
            </button>
            <button
              className="generate-btn generate-btn--secondary"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
            >
              Cancel
            </button>
          </span>
        )}
      </div>

      <div className="file-picker">
        <label>
          Load benchmark results
          <input type="file" accept=".json" onChange={handleResultsFile} />
        </label>
        {resultsFileName && (
          <span className="file-name">{resultsFileName}</span>
        )}
        {benchmarkResults && (
          <span className="file-name" style={{ color: "var(--success)" }}>
            {benchmarkResults.length} results loaded
          </span>
        )}
      </div>

      {loadingTheorems && (
        <p style={{ color: "var(--text-muted)" }}>Loading theorems...</p>
      )}

      {theoremsError && (
        <p style={{ color: "var(--error)" }}>
          Failed to load theorems: {theoremsError}
        </p>
      )}

      {!loadingTheorems && !theoremsError && theorems.length > 0 && (
        <div className="theorem-explorer-body">
          <div className="theorem-explorer-list">
            <TheoremList
              theorems={theorems}
              selectedId={selectedTheorem?.id ?? null}
              onSelect={setSelectedTheorem}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              difficultyFilter={difficultyFilter}
              onDifficultyChange={setDifficultyFilter}
            />
          </div>

          <div className="theorem-explorer-detail">
            {selectedTheorem ? (
              <TheoremDetail
                theorem={selectedTheorem}
                resultsByModel={getResultsForTheorem(selectedTheorem.id)}
              />
            ) : (
              <div className="theorem-detail-empty">
                Select a theorem from the list to view details.
              </div>
            )}
          </div>
        </div>
      )}

      {!loadingTheorems && !theoremsError && theorems.length === 0 && (
        <div className="empty-state">
          <h3>No Theorems</h3>
          <p>
            Select a theorem set or generate a new one.
          </p>
        </div>
      )}

      {showGenerate && (
        <GenerateTheorems
          onClose={() => setShowGenerate(false)}
          onGenerated={handleGenerated}
        />
      )}
    </div>
  );
}
