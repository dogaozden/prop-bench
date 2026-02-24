import { useState, useEffect } from "react";
import { api, type TheoremSetInfo } from "../api/client";

interface TheoremSetPickerProps {
  selectedSet: string;
  onSelect: (name: string) => void;
  refreshKey?: number;
}

export default function TheoremSetPicker({
  selectedSet,
  onSelect,
  refreshKey,
}: TheoremSetPickerProps) {
  const [sets, setSets] = useState<TheoremSetInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    Promise.all([
      api.getTheoremSets(),
      api.getRuns().catch(() => []),
    ])
      .then(([data, runs]) => {
        setSets(data);
        // Auto-select if none selected or current selection no longer exists
        const currentExists = data.some((s) => s.name === selectedSet);
        if ((!selectedSet || !currentExists) && data.length > 0) {
          const setNames = new Set(data.map((s) => s.name));
          let latestSet = "";
          let latestTime = "";
          for (const run of runs) {
            const setName = run.runId.split("/")[0];
            if (setNames.has(setName) && run.timestamp && run.timestamp > latestTime) {
              latestTime = run.timestamp;
              latestSet = setName;
            }
          }
          onSelect(latestSet || data.find((s) => s.count > 0)?.name || data[0].name);
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [refreshKey]);

  if (loading) {
    return (
      <select className="difficulty-filter" disabled>
        <option>Loading sets...</option>
      </select>
    );
  }

  if (error) {
    return (
      <span style={{ color: "var(--error)", fontSize: 13 }}>
        Failed to load theorem sets: {error}
      </span>
    );
  }

  if (sets.length === 0) {
    return (
      <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
        No theorem sets found. Generate one to get started.
      </span>
    );
  }

  return (
    <select
      className="difficulty-filter"
      value={selectedSet}
      onChange={(e) => onSelect(e.target.value)}
    >
      {sets.map((s) => (
        <option key={s.name} value={s.name}>
          {s.name} ({s.count} theorems)
        </option>
      ))}
    </select>
  );
}
