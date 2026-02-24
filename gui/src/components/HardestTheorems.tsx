interface HardestTheorem {
  theorem_id: string;
  difficulty: string;
  difficulty_value: number;
  attempts: number;
  valid_count: number;
  success_rate: number;
}

interface HardestTheoremsProps {
  data: HardestTheorem[];
}

function rateClass(rate: number): string {
  if (rate < 33) return "--low";
  if (rate <= 66) return "--mid";
  return "--high";
}

function HardestTheorems({ data }: HardestTheoremsProps) {
  if (data.length === 0) {
    return <p className="empty-state">No hardest-theorem data available.</p>;
  }

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Theorem</th>
          <th>Difficulty</th>
          <th>Attempts</th>
          <th>Valid</th>
          <th>Success Rate</th>
        </tr>
      </thead>
      <tbody>
        {data.map((t) => (
          <tr key={t.theorem_id}>
            <td className="model-cell">{t.theorem_id}</td>
            <td>
              <span
                className={`difficulty-badge difficulty-badge--${t.difficulty.toLowerCase()}`}
              >
                {t.difficulty}
              </span>
            </td>
            <td className="number-cell">{t.attempts}</td>
            <td className="number-cell">{t.valid_count}</td>
            <td>
              <span className={`success-rate ${rateClass(t.success_rate)}`}>
                {t.success_rate.toFixed(1)}%
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default HardestTheorems;
export type { HardestTheorem };
