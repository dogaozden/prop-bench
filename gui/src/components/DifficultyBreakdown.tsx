import { useState } from "react";
import type { BenchmarkReport, DifficultyTier, ModelStats } from "../types";

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

function getSuccessRate(stats: ModelStats, tier: DifficultyTier): number {
  const d = stats.linesByDifficulty[tier];
  if (!d) return -1;
  const attempted = d.attempted ?? 0;
  const valid = d.valid ?? d.count ?? 0;
  if (attempted === 0 && d.count === 0) return -1;
  if (attempted === 0) return valid; // old format fallback
  return valid / attempted;
}

function DifficultyBreakdown({ report }: Props) {
  const [sortTier, setSortTier] = useState<DifficultyTier | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

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

  const handleSort = (tier: DifficultyTier) => {
    if (sortTier === tier) {
      setSortDir(sortDir === "desc" ? "asc" : "desc");
    } else {
      setSortTier(tier);
      setSortDir("desc");
    }
  };

  const sortedModels = [...report.models];
  if (sortTier) {
    sortedModels.sort((a, b) => {
      const rateA = getSuccessRate(a, sortTier);
      const rateB = getSuccessRate(b, sortTier);
      return sortDir === "desc" ? rateB - rateA : rateA - rateB;
    });
  }

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Model</th>
          {activeTiers.map((t) => (
            <th
              key={t}
              style={{ textTransform: "capitalize", cursor: "pointer", userSelect: "none" }}
              onClick={() => handleSort(t)}
            >
              {t} {sortTier === t ? (sortDir === "desc" ? "\u25BC" : "\u25B2") : ""}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sortedModels.map((stats) => (
          <tr key={stats.model}>
            <td className="model-cell">{stats.model}</td>
            {activeTiers.map((tier) => {
              const d = stats.linesByDifficulty[tier];
              // Support old report format (no attempted/valid/invalid fields)
              const attempted = d?.attempted ?? 0;
              const valid = d?.valid ?? d?.count ?? 0;

              if (!d || (attempted === 0 && d.count === 0)) {
                return (
                  <td key={tier} className="number-cell" style={{ color: "var(--text-muted)" }}>
                    --
                  </td>
                );
              }

              // Old format only has count (valid proofs) — show what we have
              if (attempted === 0) {
                return (
                  <td key={tier} className="number-cell">
                    {d.avg !== null ? d.avg.toFixed(1) : "--"}{" "}
                    <span style={{ color: "var(--text-muted)", fontSize: "11px" }}>
                      ({d.count})
                    </span>
                  </td>
                );
              }

              const pct = Math.round((valid / attempted) * 100);

              return (
                <td key={tier} className="number-cell">
                  <span className="difficulty-valid">{valid}</span>
                  <span className="difficulty-sep">/</span>
                  <span className="difficulty-attempted">{attempted}</span>
                  <span className="difficulty-pct" style={{
                    color: pct >= 80
                      ? "var(--success)"
                      : pct >= 40
                        ? "var(--warning)"
                        : pct >= 20
                          ? "#f97316"
                          : pct >= 1
                            ? "#ef4444"
                            : "var(--error)",
                  }}>
                    {pct}%
                  </span>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default DifficultyBreakdown;
