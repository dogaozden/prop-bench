export interface AvgLinesByDifficulty {
  model_slug: string;
  model_display: string;
  difficulty: string;
  avg_lines: number;
  count: number;
}

interface Props {
  data: AvgLinesByDifficulty[];
}

const TIER_ORDER = [
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

function AvgLinesByDifficultyTable({ data }: Props) {
  if (data.length === 0) {
    return <p className="empty-state">No avg-lines-by-difficulty data available.</p>;
  }

  // Pivot: rows = models, columns = difficulty tiers
  const models = [...new Set(data.map((d) => d.model_display))];
  const tiers = TIER_ORDER.filter((t) =>
    data.some((d) => d.difficulty.toLowerCase() === t)
  );

  // Build lookup: model → difficulty → { avg_lines, count }
  const lookup = new Map<string, Map<string, { avg: number; count: number }>>();
  for (const row of data) {
    if (!lookup.has(row.model_display)) lookup.set(row.model_display, new Map());
    lookup.get(row.model_display)!.set(row.difficulty.toLowerCase(), {
      avg: row.avg_lines,
      count: row.count,
    });
  }

  // Find min avg per tier (to highlight the best/shortest)
  const minPerTier = new Map<string, number>();
  for (const tier of tiers) {
    let min = Infinity;
    for (const model of models) {
      const cell = lookup.get(model)?.get(tier);
      if (cell && cell.avg < min) min = cell.avg;
    }
    if (min < Infinity) minPerTier.set(tier, min);
  }

  return (
    <div className="data-table-scroll">
    <table className="data-table">
      <thead>
        <tr>
          <th>Model</th>
          {tiers.map((t) => (
            <th key={t} style={{ textTransform: "capitalize" }}>
              {t}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {models.map((model) => (
          <tr key={model}>
            <td className="model-cell">{model}</td>
            {tiers.map((tier) => {
              const cell = lookup.get(model)?.get(tier);
              if (!cell) {
                return (
                  <td key={tier} className="number-cell" style={{ color: "var(--text-muted)" }}>
                    --
                  </td>
                );
              }
              const isBest = minPerTier.get(tier) === cell.avg;
              return (
                <td
                  key={tier}
                  className="number-cell"
                  style={isBest ? { color: "var(--success)", fontWeight: 600 } : undefined}
                >
                  {cell.avg.toFixed(1)}
                  <span style={{ color: "var(--text-muted)", fontSize: "11px", marginLeft: 4 }}>
                    ({cell.count})
                  </span>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

export default AvgLinesByDifficultyTable;
