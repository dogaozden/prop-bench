export interface HeadToHeadCell {
  modelA: string;
  modelB: string;
  winsA: number;
  winsB: number;
  ties: number;
  total: number;
}

interface Props {
  data: HeadToHeadCell[];
}

function HeadToHeadMatrix({ data }: Props) {
  if (data.length === 0) {
    return <p className="empty-state">No head-to-head data available.</p>;
  }

  // Extract unique model names
  const modelSet = new Set<string>();
  for (const cell of data) {
    modelSet.add(cell.modelA);
    modelSet.add(cell.modelB);
  }
  const models = Array.from(modelSet).sort();

  // Build lookup: key "A|B" → cell
  const lookup = new Map<string, HeadToHeadCell>();
  for (const cell of data) {
    lookup.set(`${cell.modelA}|${cell.modelB}`, cell);
  }

  const getCell = (rowModel: string, colModel: string) => {
    // row wins against col
    const direct = lookup.get(`${rowModel}|${colModel}`);
    if (direct) {
      return { wins: direct.winsA, losses: direct.winsB, total: direct.total };
    }
    const reverse = lookup.get(`${colModel}|${rowModel}`);
    if (reverse) {
      return { wins: reverse.winsB, losses: reverse.winsA, total: reverse.total };
    }
    return null;
  };

  return (
    <div style={{ overflowX: "auto" }}>
      <table className="h2h-matrix">
        <thead>
          <tr>
            <th className="h2h-cell" style={{ background: "var(--bg-secondary)" }} />
            {models.map((m) => (
              <th key={m} className="h2h-cell" style={{ background: "var(--bg-secondary)", fontWeight: 600, fontSize: "11px", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                {m}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {models.map((rowModel) => (
            <tr key={rowModel}>
              <td className="h2h-cell" style={{ fontWeight: 600, textAlign: "left" }}>
                {rowModel}
              </td>
              {models.map((colModel) => {
                if (rowModel === colModel) {
                  return (
                    <td key={colModel} className="h2h-cell h2h-cell--diagonal">
                      --
                    </td>
                  );
                }

                const result = getCell(rowModel, colModel);
                if (!result) {
                  return (
                    <td key={colModel} className="h2h-cell h2h-cell--tie">
                      --
                    </td>
                  );
                }

                const { wins, losses, total } = result;
                const pct = total > 0 ? Math.round((wins / total) * 100) : 0;
                let cellClass = "h2h-cell";
                if (wins > losses) cellClass += " h2h-cell--win";
                else if (wins < losses) cellClass += " h2h-cell--loss";
                else cellClass += " h2h-cell--tie";

                return (
                  <td key={colModel} className={cellClass}>
                    <span>{wins}/{total}</span>
                    <br />
                    <span style={{ fontSize: "10px", opacity: 0.7 }}>{pct}%</span>
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

export default HeadToHeadMatrix;
