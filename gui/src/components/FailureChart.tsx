export interface FailureAnalysis {
  model_slug: string;
  model_display: string;
  total: number;
  valid: number;
  parse_failures: number;
  validation_failures: number;
  api_errors: number;
}

interface Props {
  data: FailureAnalysis[];
}

function FailureChart({ data }: Props) {
  if (data.length === 0) {
    return <p className="empty-state">No failure data available.</p>;
  }

  return (
    <div className="failure-chart">
      <div className="failure-legend">
        <span>
          <span className="failure-legend-dot" style={{ background: "var(--success)" }} />
          Valid
        </span>
        <span>
          <span className="failure-legend-dot" style={{ background: "var(--warning)" }} />
          Parse Failures
        </span>
        <span>
          <span className="failure-legend-dot" style={{ background: "var(--error)" }} />
          Validation Failures
        </span>
        <span>
          <span className="failure-legend-dot" style={{ background: "#991b1b" }} />
          API Errors
        </span>
      </div>

      {data.map((row) => {
        const total = row.total || 1;
        const validPct = (row.valid / total) * 100;
        const parsePct = (row.parse_failures / total) * 100;
        const validationPct = (row.validation_failures / total) * 100;
        const apiPct = (row.api_errors / total) * 100;

        return (
          <div key={row.model_slug} className="failure-row">
            <div className="failure-model" title={row.model_display}>
              {row.model_display}
            </div>
            <div className="failure-bar">
              {validPct > 0 && (
                <div
                  className="failure-segment failure-segment--valid"
                  style={{ width: `${validPct}%` }}
                  title={`Valid: ${row.valid}`}
                />
              )}
              {parsePct > 0 && (
                <div
                  className="failure-segment failure-segment--parse"
                  style={{ width: `${parsePct}%` }}
                  title={`Parse failures: ${row.parse_failures}`}
                />
              )}
              {validationPct > 0 && (
                <div
                  className="failure-segment failure-segment--validation"
                  style={{ width: `${validationPct}%` }}
                  title={`Validation failures: ${row.validation_failures}`}
                />
              )}
              {apiPct > 0 && (
                <div
                  className="failure-segment failure-segment--api"
                  style={{ width: `${apiPct}%` }}
                  title={`API errors: ${row.api_errors}`}
                />
              )}
            </div>
            <div style={{ fontSize: "11px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
              {row.total}
            </div>
          </div>
        );
      })}

      <div className="failure-labels">
        {data.map((row) => {
          const total = row.total || 1;
          const validPct = Math.round((row.valid / total) * 100);
          return (
            <span key={row.model_slug}>
              {row.model_display}: {validPct}% valid
            </span>
          );
        })}
      </div>

      <div className="data-table-scroll">
      <table className="data-table failure-numbers">
        <thead>
          <tr>
            <th>Model</th>
            <th>Total</th>
            <th>Valid</th>
            <th>Parse Err</th>
            <th>Validation Err</th>
            <th>API Err</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.model_slug}>
              <td className="model-cell">{row.model_display}</td>
              <td className="number-cell">{row.total}</td>
              <td className="number-cell">{row.valid}</td>
              <td className="number-cell">{row.parse_failures}</td>
              <td className="number-cell">{row.validation_failures}</td>
              <td className="number-cell">{row.api_errors}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

export default FailureChart;
