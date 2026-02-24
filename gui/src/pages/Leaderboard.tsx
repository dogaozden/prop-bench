import { useState, useEffect } from "react";
import { api, type SetOverview, type TheoremSetInfo } from "../api/client";
import "../styles/leaderboard.css";

type SortCol = "score" | "valid_rate" | "invalid_rate" | "parse_error_rate" | "runs";

function getInvalidRate(m: SetOverview["modelSummaries"][0]) {
  return m.total_attempted > 0 ? m.total_invalid / m.total_attempted : 0;
}

function getParseErrorRate(m: SetOverview["modelSummaries"][0]) {
  return m.total_attempted > 0 ? m.total_parse_errors / m.total_attempted : 0;
}

function getSortValue(m: SetOverview["modelSummaries"][0], col: SortCol): number {
  switch (col) {
    case "score": return m.total_valid;
    case "valid_rate": return m.valid_rate;
    case "invalid_rate": return getInvalidRate(m);
    case "parse_error_rate": return getParseErrorRate(m);
    case "runs": return m.run_count;
  }
}

export default function Leaderboard() {
  const [sets, setSets] = useState<TheoremSetInfo[]>([]);
  const [selectedSet, setSelectedSet] = useState("");
  const [overview, setOverview] = useState<SetOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [sortCol, setSortCol] = useState<SortCol>("score");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const handleSort = (col: SortCol) => {
    if (sortCol === col) {
      setSortDir(sortDir === "desc" ? "asc" : "desc");
    } else {
      setSortCol(col);
      setSortDir("desc");
    }
  };

  const sortArrow = (col: SortCol) =>
    sortCol === col ? (sortDir === "desc" ? " \u25BC" : " \u25B2") : "";

  // Fetch theorem sets on mount, default-select first available
  useEffect(() => {
    api
      .getTheoremSets()
      .catch(() => [] as TheoremSetInfo[])
      .then((allSets) => {
        setSets(allSets);
        if (allSets.length === 0) {
          setLoading(false);
          return;
        }
        setSelectedSet(allSets[0].name);
        setLoading(false);
      });
  }, []);

  // When set changes, fetch overview
  useEffect(() => {
    if (!selectedSet) return;
    setLoading(true);
    api
      .getSetOverview(selectedSet)
      .catch(() => null)
      .then((ov) => {
        setOverview(ov);
        setLoading(false);
      });
  }, [selectedSet]);

  // Filter models with at least 1 valid proof, then sort
  const ranked = overview
    ? [...overview.modelSummaries]
        .filter((m) => m.total_valid >= 1)
        .sort((a, b) => {
          const va = getSortValue(a, sortCol);
          const vb = getSortValue(b, sortCol);
          if (va !== vb) return sortDir === "desc" ? vb - va : va - vb;
          // tiebreak by valid_rate desc
          return b.valid_rate - a.valid_rate;
        })
    : [];

  const totalRuns = ranked.reduce((s, m) => s + m.run_count, 0);

  return (
    <div className="leaderboard-page">
      {/* Header with title + set picker */}
      <div className="leaderboard-header">
        <h2>Leaderboard</h2>
        <select
          value={selectedSet}
          onChange={(e) => setSelectedSet(e.target.value)}
        >
          {sets.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name} ({s.count} theorems)
            </option>
          ))}
        </select>
      </div>

      {loading && <div className="loading">Loading...</div>}

      {!loading && overview && ranked.length === 0 && (
        <div className="empty-state">
          <h3>No Qualified Models</h3>
          <p>No models have at least 1 valid proof for this theorem set.</p>
        </div>
      )}

      {!loading && !overview && selectedSet && (
        <div className="empty-state">
          <h3>No Results</h3>
          <p>No benchmark results found for this theorem set.</p>
        </div>
      )}

      {!loading && overview && ranked.length > 0 && (
        <>
          {/* Summary Stats */}
          <div className="leaderboard-summary">
            <div className="leaderboard-summary-card">
              <div className="summary-value">{ranked.length}</div>
              <div className="summary-label">Qualified Models</div>
            </div>
            <div className="leaderboard-summary-card">
              <div className="summary-value">{overview.totalTheorems}</div>
              <div className="summary-label">Total Theorems</div>
            </div>
            <div className="leaderboard-summary-card">
              <div className="summary-value">{totalRuns}</div>
              <div className="summary-label">Completed Runs</div>
            </div>
          </div>

          {/* Leaderboard Table */}
          <div className="dashboard-section">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Model</th>
                  <th style={{ cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("score")}>Score{sortArrow("score")}</th>
                  <th style={{ cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("valid_rate")}>Valid Rate{sortArrow("valid_rate")}</th>
                  <th style={{ cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("invalid_rate")}>Invalid Rate{sortArrow("invalid_rate")}</th>
                  <th style={{ cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("parse_error_rate")}>Parse Error Rate{sortArrow("parse_error_rate")}</th>
                  <th style={{ cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("runs")}>Completed Runs{sortArrow("runs")}</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((m, i) => {
                  const rank = i + 1;
                  const rankClass =
                    rank === 1
                      ? "leaderboard-rank--gold"
                      : rank === 2
                        ? "leaderboard-rank--silver"
                        : rank === 3
                          ? "leaderboard-rank--bronze"
                          : "";
                  return (
                    <tr key={m.model_slug}>
                      <td className={`leaderboard-rank-cell ${rankClass}`}>
                        {rank === 1 ? "🥇 " : rank === 2 ? "🥈 " : rank === 3 ? "🥉 " : ""}{rank}
                      </td>
                      <td className="leaderboard-model-cell">{m.model_display}</td>
                      <td className="leaderboard-valid-count">{m.total_valid}/{m.total_attempted}</td>
                      <td>
                        <div className="leaderboard-rate-cell">
                          <span>{m.valid_rate.toFixed(1)}%</span>
                          <div className="leaderboard-valid-bar">
                            <div
                              className="leaderboard-valid-bar-fill"
                              style={{ width: `${Math.min(m.valid_rate, 100)}%` }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="number-cell" style={{ color: m.total_invalid > 0 ? "var(--error)" : "var(--text-muted)" }}>
                        {m.total_attempted > 0 ? ((m.total_invalid / m.total_attempted) * 100).toFixed(1) : "0.0"}%
                      </td>
                      <td className="number-cell" style={{ color: m.total_parse_errors > 0 ? "var(--warning)" : "var(--text-muted)" }}>
                        {m.total_attempted > 0 ? ((m.total_parse_errors / m.total_attempted) * 100).toFixed(1) : "0.0"}%
                      </td>
                      <td className="number-cell">{m.run_count}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
