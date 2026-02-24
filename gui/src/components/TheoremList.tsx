import type { Theorem, Difficulty } from "../types";

interface TheoremListProps {
  theorems: Theorem[];
  selectedId: string | null;
  onSelect: (theorem: Theorem) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  difficultyFilter: Difficulty | "All";
  onDifficultyChange: (d: Difficulty | "All") => void;
}

const DIFFICULTIES: (Difficulty | "All")[] = [
  "All",
  "Baby",
  "Easy",
  "Medium",
  "Hard",
  "Expert",
  "Nightmare",
  "Marathon",
  "Absurd",
  "Cosmic",
  "Mind",
];

/** Render a formula string with Unicode logic symbols for list display. */
function renderFormula(raw: string): string {
  return raw
    .replace(/#/g, "⊥")
    .replace(/ <> /g, " ≡ ")
    .replace(/ > /g, " ⊃ ")
    .replace(/ \. /g, " · ")
    .replace(/ v /g, " ∨ ");
}

export default function TheoremList({
  theorems,
  selectedId,
  onSelect,
  searchQuery,
  onSearchChange,
  difficultyFilter,
  onDifficultyChange,
}: TheoremListProps) {
  // Filter theorems
  const filtered = theorems.filter((t) => {
    if (difficultyFilter !== "All" && t.difficulty !== difficultyFilter) {
      return false;
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchesId = t.id.toLowerCase().includes(q);
      const matchesPremises = t.premises.some((p) =>
        p.toLowerCase().includes(q)
      );
      const matchesConclusion = t.conclusion.toLowerCase().includes(q);
      if (!matchesId && !matchesPremises && !matchesConclusion) {
        return false;
      }
    }
    return true;
  });

  return (
    <>
      <div className="theorem-list-controls">
        <input
          type="text"
          className="theorem-search"
          placeholder="Search formulas..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        <select
          className="difficulty-filter"
          value={difficultyFilter}
          onChange={(e) =>
            onDifficultyChange(e.target.value as Difficulty | "All")
          }
        >
          {DIFFICULTIES.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>

      <div className="theorem-list-count">
        {filtered.length} of {theorems.length} theorems
      </div>

      <div className="theorem-list-items">
        {filtered.map((t) => {
          const diffClass = `difficulty-badge difficulty-badge--${t.difficulty.toLowerCase()}`;
          const selected = selectedId === t.id;
          return (
            <div
              key={t.id}
              className={`theorem-list-item ${selected ? "theorem-list-item--selected" : ""}`}
              onClick={() => onSelect(t)}
            >
              <div className="theorem-list-item-header">
                <span className="theorem-list-item-id">{t.id}</span>
                <span className={diffClass}>{t.difficulty}</span>
                <span className="theorem-list-item-dv">
                  d={t.difficulty_value}
                </span>
              </div>
              <div className="theorem-list-item-formula">
                {t.premises.length > 0 && (
                  <span className="premise">
                    {t.premises.map((p) => renderFormula(p)).join(", ")}
                  </span>
                )}
                <span className="turnstile"> {"\u22A2"} </span>
                {renderFormula(t.conclusion)}
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div style={{ color: "var(--text-muted)", padding: 16, fontSize: 13 }}>
            No theorems match your filters.
          </div>
        )}
      </div>
    </>
  );
}
