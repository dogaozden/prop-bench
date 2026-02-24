import type { BenchmarkReport, DifficultyTier } from "../types";

interface Props {
  report: BenchmarkReport;
}

const TIERS: DifficultyTier[] = [
  "baby",
  "easy",
  "medium",
  "hard",
  "expert",
  "nightmare",
  "marathon",
  "absurd",
  "cosmic",
  "mind",
];

function PerDifficultyStats({ report }: Props) {
  if (report.models.length === 0) {
    return <p className="empty-state">No model data available.</p>;
  }

  // Only show tiers that have data across any model
  const activeTiers = TIERS.filter((tier) =>
    report.models.some((stats) => {
      const d = stats.linesByDifficulty[tier];
      return d && (d.attempted > 0 || d.count > 0);
    })
  );

  if (activeTiers.length === 0) {
    return <p className="empty-state">No difficulty data available.</p>;
  }

  return (
    <div className="per-difficulty-stats">
      {report.models.map((stats) => (
        <div key={stats.model} className="model-difficulty-card">
          <h4 className="model-difficulty-title">{stats.model}</h4>
          <table className="difficulty-stats-table">
            <thead>
              <tr>
                <th>Difficulty</th>
                <th>Valid Rate</th>
                <th>Avg Lines</th>
              </tr>
            </thead>
            <tbody>
              {activeTiers.map((tier) => {
                const d = stats.linesByDifficulty[tier];
                const attempted = d?.attempted ?? 0;
                const valid = d?.valid ?? d?.count ?? 0;
                const avgLines = d?.avg ?? null;

                if (!d || (attempted === 0 && d.count === 0)) {
                  return (
                    <tr key={tier}>
                      <td style={{ textTransform: "capitalize" }}>{tier}</td>
                      <td className="number-cell" style={{ color: "var(--text-muted)" }}>
                        --
                      </td>
                      <td className="number-cell" style={{ color: "var(--text-muted)" }}>
                        --
                      </td>
                    </tr>
                  );
                }

                // Old format fallback
                if (attempted === 0) {
                  return (
                    <tr key={tier}>
                      <td style={{ textTransform: "capitalize" }}>{tier}</td>
                      <td className="number-cell" style={{ color: "var(--text-muted)" }}>
                        --
                      </td>
                      <td className="number-cell">
                        {avgLines !== null ? avgLines.toFixed(1) : "--"}
                      </td>
                    </tr>
                  );
                }

                const validRate = Math.round((valid / attempted) * 100);

                return (
                  <tr key={tier}>
                    <td style={{ textTransform: "capitalize" }}>{tier}</td>
                    <td className="number-cell">
                      <span
                        style={{
                          color:
                            validRate >= 80
                              ? "var(--success, #4ade80)"
                              : validRate >= 40
                                ? "var(--warning, #fbbf24)"
                                : "var(--error, #f87171)",
                          fontWeight: 600,
                        }}
                      >
                        {validRate}%
                      </span>
                      <span style={{ color: "var(--text-muted)", fontSize: "11px", marginLeft: 6 }}>
                        ({valid}/{attempted})
                      </span>
                    </td>
                    <td className="number-cell">
                      {avgLines !== null ? avgLines.toFixed(1) : "--"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

export default PerDifficultyStats;
