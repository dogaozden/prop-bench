export interface LatencyStats {
  model_slug: string;
  model_display: string;
  avg_ms: number;
  min_ms: number;
  max_ms: number;
  p50_ms: number;
  total_tokens: number;
  avg_tokens: number;
}

interface Props {
  data: LatencyStats[];
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function LatencyTable({ data }: Props) {
  if (data.length === 0) {
    return <p className="empty-state">No latency data available.</p>;
  }

  // Find the fastest model by avg_ms
  const fastestAvg = Math.min(...data.map((d) => d.avg_ms));

  return (
    <div className="data-table-scroll">
    <table className="data-table">
      <thead>
        <tr>
          <th>Model</th>
          <th>Avg (ms)</th>
          <th>Median (ms)</th>
          <th>Min (ms)</th>
          <th>Max (ms)</th>
          <th>Avg Tokens</th>
          <th>Total Tokens</th>
        </tr>
      </thead>
      <tbody>
        {data.map((row) => {
          const isFastest = row.avg_ms === fastestAvg;
          return (
            <tr key={row.model_slug}>
              <td className="model-cell">{row.model_display}</td>
              <td
                className="number-cell"
                style={isFastest ? { color: "var(--success)", fontWeight: 600 } : undefined}
              >
                {formatNumber(Math.round(row.avg_ms))}
              </td>
              <td className="number-cell">{formatNumber(Math.round(row.p50_ms))}</td>
              <td className="number-cell">{formatNumber(Math.round(row.min_ms))}</td>
              <td className="number-cell">{formatNumber(Math.round(row.max_ms))}</td>
              <td className="number-cell">{formatNumber(Math.round(row.avg_tokens))}</td>
              <td className="number-cell">{formatNumber(row.total_tokens)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}

export default LatencyTable;
