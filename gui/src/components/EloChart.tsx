import type { BenchmarkReport } from "../types";

interface Props {
  report: BenchmarkReport;
}

const BAR_AREA_HEIGHT = 170; // px reserved for bars (rest is labels)

function EloChart({ report }: Props) {
  const rankings = report.rankings;

  if (rankings.length === 0) {
    return <p className="empty-state">No Elo data to display.</p>;
  }

  const elos = rankings.map((r) => r.eloRating);
  const maxElo = Math.max(...elos);
  const minElo = Math.min(...elos);
  const range = maxElo - minElo || 1;

  // Scale bars: minimum 10% of bar area, max 100%
  const getBarHeight = (elo: number) => {
    const normalized = (elo - minElo) / range;
    return Math.round(Math.max(BAR_AREA_HEIGHT * 0.1, normalized * BAR_AREA_HEIGHT));
  };

  return (
    <div className="elo-chart">
      {rankings.map((r) => (
        <div key={r.model} className="elo-bar-wrapper">
          <span className="elo-bar-value">{r.eloRating}</span>
          <div className="elo-bar-area">
            <div
              className="elo-bar"
              style={{ height: `${getBarHeight(r.eloRating)}px` }}
            />
          </div>
          <span className="elo-bar-label" title={r.model}>
            {r.model}
          </span>
        </div>
      ))}
    </div>
  );
}

export default EloChart;
