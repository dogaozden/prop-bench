import { useState, useEffect, useCallback } from "react";
import type { BenchmarkReport } from "../types";
import {
  api,
  type SetOverview,
  type HardestTheorem,
  type HeadToHeadCell,
  type LatencyStats,
  type FailureAnalysis,
  type AvgLinesByDifficulty,
  type TheoremSetInfo,
  type IndividualRun,
} from "../api/client";
import RankingsTable from "../components/RankingsTable";
import DifficultyBreakdown from "../components/DifficultyBreakdown";
import PerDifficultyStats from "../components/PerDifficultyStats";
import EloChart from "../components/EloChart";
import HeadToHeadMatrix from "../components/HeadToHeadMatrix";
import LatencyTable from "../components/LatencyTable";
import FailureChart from "../components/FailureChart";
import AvgLinesByDifficultyTable from "../components/AvgLinesByDifficultyTable";
import HardestTheorems from "../components/HardestTheorems";

function Dashboard() {
  const [sets, setSets] = useState<TheoremSetInfo[]>([]);
  const [selectedSet, setSelectedSet] = useState("");
  const [overview, setOverview] = useState<SetOverview | null>(null);
  const [h2h, setH2h] = useState<HeadToHeadCell[]>([]);
  const [latency, setLatency] = useState<LatencyStats[]>([]);
  const [failures, setFailures] = useState<FailureAnalysis[]>([]);
  const [avgLines, setAvgLines] = useState<AvgLinesByDifficulty[]>([]);
  const [hardest, setHardest] = useState<HardestTheorem[]>([]);
  const [report, setReport] = useState<BenchmarkReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"combined" | "individual">("combined");
  const [individualRuns, setIndividualRuns] = useState<IndividualRun[]>([]);
  const [sortCol, setSortCol] = useState<string>("runId");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Fetch theorem sets on mount, auto-select the one with the latest run
  useEffect(() => {
    Promise.all([
      api.getTheoremSets().catch(() => [] as TheoremSetInfo[]),
      api.getRuns().catch(() => []),
    ]).then(([allSets, runs]) => {
      setSets(allSets);
      if (allSets.length === 0) {
        setLoading(false);
        return;
      }
      // Find the set with the most recent run
      const setNames = new Set(allSets.map((s) => s.name));
      let latestSet = "";
      let latestTime = "";
      for (const run of runs) {
        const setName = run.runId.split("/")[0];
        if (setNames.has(setName) && run.timestamp && run.timestamp > latestTime) {
          latestTime = run.timestamp;
          latestSet = setName;
        }
      }
      setSelectedSet(latestSet || allSets.find((s) => s.count > 0)?.name || allSets[0].name);
      setLoading(false);
    });
  }, []);

  // When set changes, fetch ALL per-set data in parallel
  useEffect(() => {
    if (!selectedSet) return;
    setLoading(true);

    Promise.all([
      api.getSetOverview(selectedSet).catch(() => null),
      api.getHeadToHead(selectedSet).catch(() => [] as HeadToHeadCell[]),
      api.getLatencyStats(selectedSet).catch(() => [] as LatencyStats[]),
      api.getFailureAnalysis(selectedSet).catch(() => [] as FailureAnalysis[]),
      api.getAvgLinesByDifficulty(selectedSet).catch(() => [] as AvgLinesByDifficulty[]),
      api.getHardestTheorems(selectedSet).catch(() => [] as HardestTheorem[]),
      api
        .getRun(selectedSet)
        .then((d) => d.summary as unknown as BenchmarkReport)
        .catch(() => null),
      api.getIndividualRuns(selectedSet).catch(() => [] as IndividualRun[]),
    ]).then(([ov, h2hData, lat, fail, lines, hard, rep, runs]) => {
      setOverview(ov);
      setH2h(h2hData);
      setLatency(lat);
      setFailures(fail);
      setAvgLines(lines);
      setHardest(hard);
      setReport(rep);
      setIndividualRuns(runs);
      setLoading(false);
    });
  }, [selectedSet]);

  // Compute key metrics from overview
  const totalValid = overview
    ? overview.modelSummaries.reduce((s, m) => s + m.total_valid, 0)
    : 0;
  const totalAttempted = overview
    ? overview.modelSummaries.reduce((s, m) => s + m.total_attempted, 0)
    : 0;
  const overallValidRate =
    totalAttempted > 0 ? ((totalValid / totalAttempted) * 100).toFixed(1) : "0";
  const totalParseErrors = overview
    ? overview.modelSummaries.reduce((s, m) => s + m.total_parse_errors, 0)
    : 0;
  const totalApiErrors = overview
    ? overview.modelSummaries.reduce((s, m) => s + m.total_api_errors, 0)
    : 0;

  // Handle column sorting
  const handleSort = (col: string) => {
    if (sortCol === col) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  };

  // Sort individual runs
  const sortedRuns = [...individualRuns].sort((a, b) => {
    let aVal: any;
    let bVal: any;

    switch (sortCol) {
      case "runId":
        aVal = a.runId;
        bVal = b.runId;
        break;
      case "model":
        aVal = a.modelDisplay.toLowerCase();
        bVal = b.modelDisplay.toLowerCase();
        break;
      case "temperature":
        aVal = a.temperature;
        bVal = b.temperature;
        break;
      case "maxTokens":
        aVal = a.maxTokens;
        bVal = b.maxTokens;
        break;
      case "started":
        aVal = new Date(a.startedAt).getTime();
        bVal = new Date(b.startedAt).getTime();
        break;
      case "finished":
        aVal = a.finishedAt ? new Date(a.finishedAt).getTime() : 0;
        bVal = b.finishedAt ? new Date(b.finishedAt).getTime() : 0;
        break;
      case "valid":
        aVal = a.stats.valid;
        bVal = b.stats.valid;
        break;
      case "invalid":
        aVal = a.stats.invalid;
        bVal = b.stats.invalid;
        break;
      case "parseErrors":
        aVal = a.stats.parseErrors ?? 0;
        bVal = b.stats.parseErrors ?? 0;
        break;
      case "apiErrors":
        aVal = a.stats.apiErrors ?? 0;
        bVal = b.stats.apiErrors ?? 0;
        break;
      case "total":
        aVal = a.stats.total;
        bVal = b.stats.total;
        break;
      default:
        return 0;
    }

    if (aVal < bVal) return sortDir === "asc" ? -1 : 1;
    if (aVal > bVal) return sortDir === "asc" ? 1 : -1;
    return 0;
  });

  const handleFinishRun = useCallback(async (runId: number) => {
    await api.finishRun(runId);
    // Refresh individual runs
    if (selectedSet) {
      const runs = await api.getIndividualRuns(selectedSet).catch(() => [] as IndividualRun[]);
      setIndividualRuns(runs);
    }
  }, [selectedSet]);

  return (
    <div>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="dashboard-header">
        <h2>PropBench Dashboard</h2>
        <p>Real-time benchmark analytics</p>
      </div>

      {/* ── Set Picker ──────────────────────────────────────────────────── */}
      <div className="dashboard-set-picker">
        <label>Theorem Set</label>
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

      {/* ── View Mode Toggle ────────────────────────────────────────────── */}
      <div className="view-toggle">
        <button
          className={`view-toggle-btn ${viewMode === "combined" ? "active" : ""}`}
          onClick={() => setViewMode("combined")}
        >
          Combined View
        </button>
        <button
          className={`view-toggle-btn ${viewMode === "individual" ? "active" : ""}`}
          onClick={() => setViewMode("individual")}
        >
          Individual Runs
        </button>
      </div>

      {loading && (
        <p style={{ color: "var(--text-muted)", marginBottom: 24 }}>
          Loading...
        </p>
      )}

      {!loading && !overview && selectedSet && (
        <div className="empty-state">
          <h3>No Results</h3>
          <p>No benchmark results found for this theorem set.</p>
        </div>
      )}

      {!loading && viewMode === "individual" && individualRuns.length > 0 && (
        <div className="dashboard-section">
          <h3>Individual Runs for {selectedSet}</h3>
          <div className="individual-runs-table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="sortable-header" onClick={() => handleSort("runId")} style={{ cursor: "pointer" }}>
                    Run ID {sortCol === "runId" && (sortDir === "asc" ? "▲" : "▼")}
                  </th>
                  <th className="sortable-header" onClick={() => handleSort("model")} style={{ cursor: "pointer" }}>
                    Model {sortCol === "model" && (sortDir === "asc" ? "▲" : "▼")}
                  </th>
                  <th className="sortable-header" onClick={() => handleSort("temperature")} style={{ cursor: "pointer" }}>
                    Temperature {sortCol === "temperature" && (sortDir === "asc" ? "▲" : "▼")}
                  </th>
                  <th className="sortable-header" onClick={() => handleSort("maxTokens")} style={{ cursor: "pointer" }}>
                    Max Tokens {sortCol === "maxTokens" && (sortDir === "asc" ? "▲" : "▼")}
                  </th>
                  <th className="sortable-header" onClick={() => handleSort("started")} style={{ cursor: "pointer" }}>
                    Started At {sortCol === "started" && (sortDir === "asc" ? "▲" : "▼")}
                  </th>
                  <th>Status</th>
                  <th className="sortable-header" onClick={() => handleSort("valid")} style={{ cursor: "pointer" }}>
                    Valid {sortCol === "valid" && (sortDir === "asc" ? "▲" : "▼")}
                  </th>
                  <th className="sortable-header" onClick={() => handleSort("invalid")} style={{ cursor: "pointer" }}>
                    Invalid {sortCol === "invalid" && (sortDir === "asc" ? "▲" : "▼")}
                  </th>
                  <th className="sortable-header" onClick={() => handleSort("parseErrors")} style={{ cursor: "pointer" }}>
                    Parse Errors {sortCol === "parseErrors" && (sortDir === "asc" ? "▲" : "▼")}
                  </th>
                  <th className="sortable-header" onClick={() => handleSort("apiErrors")} style={{ cursor: "pointer" }}>
                    API Errors {sortCol === "apiErrors" && (sortDir === "asc" ? "▲" : "▼")}
                  </th>
                  <th className="sortable-header" onClick={() => handleSort("total")} style={{ cursor: "pointer" }}>
                    Total {sortCol === "total" && (sortDir === "asc" ? "▲" : "▼")}
                  </th>
                  <th>Success Rate</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sortedRuns.map((run) => {
                  const successRate = run.stats.total > 0
                    ? ((run.stats.valid / run.stats.total) * 100).toFixed(1)
                    : "0.0";
                  // Use backend-computed status if available, otherwise fallback to finishedAt check
                  const status = run.status ?? (run.finishedAt !== null ? "Finished" : "Running");
                  const statusClass = status.toLowerCase().replace(/\s+/g, "-");
                  return (
                    <tr key={run.runId}>
                      <td className="number-cell">{run.runId}</td>
                      <td className="model-cell">{run.modelDisplay}</td>
                      <td className="number-cell">{run.temperature}</td>
                      <td className="number-cell">{run.maxTokens}</td>
                      <td>{new Date(run.startedAt).toLocaleString()}</td>
                      <td>
                        <span className={`run-status ${statusClass}`}>
                          {status}
                        </span>
                      </td>
                      <td className="number-cell" style={{ color: "var(--success)" }}>
                        {run.stats.valid}
                      </td>
                      <td className="number-cell" style={{ color: "var(--error)" }}>
                        {run.stats.invalid}
                      </td>
                      <td className="number-cell" style={{ color: "var(--warning)" }}>
                        {run.stats.parseErrors ?? 0}
                      </td>
                      <td className="number-cell" style={{ color: "var(--error)" }}>
                        {run.stats.apiErrors ?? 0}
                      </td>
                      <td className="number-cell">{run.stats.total}</td>
                      <td className="valid-rate-cell">{successRate}%</td>
                      <td>
                        {status === "Running" && (
                          <button
                            className="btn-sm"
                            style={{ fontSize: "11px", padding: "2px 8px" }}
                            onClick={() => handleFinishRun(run.runId)}
                          >
                            Mark Finished
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && viewMode === "individual" && individualRuns.length === 0 && selectedSet && (
        <div className="empty-state">
          <h3>No Individual Runs</h3>
          <p>No individual runs found for this theorem set.</p>
        </div>
      )}

      {!loading && viewMode === "combined" && overview && (
        <>
          {/* ── Key Metrics Row ────────────────────────────────────────── */}
          <div className="dashboard-stats">
            <div className="stat-card">
              <div className="stat-value">{overview.totalTheorems}</div>
              <div className="stat-label">Total Theorems</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{overview.totalResults}</div>
              <div className="stat-label">Total Attempts</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{overview.totalModels}</div>
              <div className="stat-label">Models Tested</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ color: "var(--success)" }}>
                {overallValidRate}%
              </div>
              <div className="stat-label">Overall Valid Rate</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ color: "var(--warning)" }}>
                {totalParseErrors}
              </div>
              <div className="stat-label">Parse Errors</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ color: "var(--error)" }}>
                {totalApiErrors}
              </div>
              <div className="stat-label">API Errors</div>
            </div>
          </div>

          {/* ── Model Scorecards ───────────────────────────────────────── */}
          {overview.modelSummaries.length > 0 && (
            <div className="dashboard-section">
              <h3>Model Scorecards</h3>
              <div className="model-scorecard-grid">
                {overview.modelSummaries.map((m) => {
                  const rate = Math.round(m.valid_rate);
                  const rateClass =
                    rate >= 70 ? "--high" : rate >= 40 ? "--mid" : "--low";
                  return (
                    <div key={m.model_slug} className="model-scorecard">
                      <div className="model-scorecard-name" title={m.model_display}>
                        {m.model_display}
                      </div>
                      <div className={`model-scorecard-rate ${rateClass}`}>
                        {rate}%
                      </div>
                      <div className="valid-rate-bar">
                        <div
                          className="valid-rate-bar-fill"
                          style={{ width: `${rate}%` }}
                        />
                      </div>
                      <div className="model-scorecard-counts">
                        <div className="model-scorecard-count --valid">
                          <span className="count-value">{m.total_valid}</span>
                          Valid
                        </div>
                        <div className="model-scorecard-count --invalid">
                          <span className="count-value">{m.total_invalid}</span>
                          Invalid
                        </div>
                        <div className="model-scorecard-count --parse">
                          <span className="count-value">{m.total_parse_errors}</span>
                          Parse Errors
                        </div>
                        <div className="model-scorecard-count --api">
                          <span className="count-value">{m.total_api_errors}</span>
                          API Errors
                        </div>
                      </div>
                      <div className="model-scorecard-meta">
                        <span>
                          Total Runs: <strong>{m.run_count}</strong>
                        </span>
                        <span>
                          Valid Runs: <strong>{m.valid_run_count}</strong>
                        </span>
                        <span>
                          Avg Lines: <strong>{m.avg_lines != null ? m.avg_lines.toFixed(1) : "--"}</strong>
                        </span>
                        <span>
                          Avg Latency: <strong>{Math.round(m.avg_latency_ms).toLocaleString()} ms</strong>
                        </span>
                        <span>
                          Tokens: <strong>{m.total_tokens.toLocaleString()}</strong>
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Success Rate by Difficulty ──────────────────────────────── */}
          {report && (
            <div className="dashboard-section">
              <h3>Success Rate by Difficulty</h3>
              <DifficultyBreakdown report={report} />
            </div>
          )}

          {/* ── Head-to-Head Wins Matrix ────────────────────────────────── */}
          {h2h.length > 0 && (
            <div className="dashboard-section">
              <h3>Head-to-Head Wins</h3>
              <HeadToHeadMatrix data={h2h} />
            </div>
          )}

          {/* ── Failure Analysis ────────────────────────────────────────── */}
          {failures.length > 0 && (
            <div className="dashboard-section">
              <h3>Failure Analysis</h3>
              <FailureChart data={failures} />
            </div>
          )}

          {/* ── Avg Proof Lines by Difficulty ───────────────────────────── */}
          {avgLines.length > 0 && (
            <div className="dashboard-section">
              <h3>Avg Proof Length by Difficulty</h3>
              <AvgLinesByDifficultyTable data={avgLines} />
            </div>
          )}

          {/* ── Latency Comparison ──────────────────────────────────────── */}
          {latency.length > 0 && (
            <div className="dashboard-section">
              <h3>Latency Comparison</h3>
              <LatencyTable data={latency} />
            </div>
          )}

          {/* ── Elo Rankings ────────────────────────────────────────────── */}
          {report && (
            <>
              <div className="dashboard-section">
                <h3>Elo Ratings</h3>
                <EloChart report={report} />
              </div>
              <div className="dashboard-section">
                <h3>Model Rankings</h3>
                <RankingsTable report={report} />
              </div>
              <div className="dashboard-section">
                <h3>Per-Difficulty Performance Breakdown</h3>
                <PerDifficultyStats report={report} />
              </div>
            </>
          )}

          {/* ── Hardest Theorems ────────────────────────────────────────── */}
          {hardest.length > 0 && (
            <div className="dashboard-section">
              <h3>Hardest Theorems</h3>
              <HardestTheorems data={hardest} />
            </div>
          )}
        </>
      )}

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <div
        className="dashboard-section"
        style={{ color: "var(--text-muted)", fontSize: "12px" }}
      >
        Last updated: {new Date().toLocaleString()}
      </div>
    </div>
  );
}

export default Dashboard;
