import type { BenchmarkReport } from "../types";

interface Props {
  report: BenchmarkReport;
}

function RankingsTable({ report }: Props) {
  const rankings = report.rankings;

  if (rankings.length === 0) {
    return <p className="empty-state">No rankings data available.</p>;
  }

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Model</th>
          <th>Elo</th>
          <th>Valid Rate</th>
          <th>Total Lines</th>
          <th>Avg Lines</th>
        </tr>
      </thead>
      <tbody>
        {rankings.map((r) => {
          const stats = report.models.find((m) => m.model === r.model);
          const avgStr =
            stats?.avgLinesPerValidProof !== null &&
            stats?.avgLinesPerValidProof !== undefined
              ? stats.avgLinesPerValidProof.toFixed(1)
              : "N/A";

          return (
            <tr key={r.model}>
              <td className="rank-cell">{r.rank}</td>
              <td className="model-cell">{r.model}</td>
              <td className="elo-cell">{r.eloRating}</td>
              <td className="valid-rate-cell">{r.validRate}</td>
              <td className="number-cell">{r.totalLines}</td>
              <td className="number-cell">{avgStr}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default RankingsTable;
