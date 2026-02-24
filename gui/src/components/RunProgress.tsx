import { useRef, useEffect } from "react";

export interface SSEProgressEvent {
  type: "progress" | "log" | "complete" | "error";
  completed?: number;
  total?: number;
  currentTheoremId?: string;
  currentDifficulty?: string;
  currentModel?: string;
  validCount?: number;
  invalidCount?: number;
  parseErrorCount?: number;
  apiErrorCount?: number;
  skippedCount?: number;
  message?: string;
  error?: string;
}

interface RunProgressProps {
  isRunning: boolean;
  progress: SSEProgressEvent | null;
  logs: string[];
  elapsedMs: number;
  onStop: () => void;
}

const MODEL_DISPLAY: Record<string, string> = {
  // Direct Gemini
  "gemini-2.5-flash-lite-preview-09-2025": "Gemini 2.5 Flash Lite",
  "gemini-3-flash-preview": "Gemini 3 Flash",
  "gemini-3-pro-preview": "Gemini 3 Pro",
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.0-flash": "Gemini 2.0 Flash",
  // OpenRouter
  "anthropic/claude-opus-4-6": "Claude Opus 4.6",
  "anthropic/claude-sonnet-4.5": "Claude Sonnet 4.5",
  "openai/gpt-4o": "GPT-4o",
  "meta-llama/llama-4-maverick": "Llama 4 Maverick",
  "deepseek/deepseek-r1": "DeepSeek R1",
  "mistralai/mistral-large-2": "Mistral Large 2",
};

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function RunProgress({
  isRunning,
  progress,
  logs,
  elapsedMs,
  onStop,
}: RunProgressProps) {
  const logRef = useRef<HTMLDivElement>(null);

  // Auto-scroll log area to bottom
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  if (!isRunning && !progress) {
    return null;
  }

  const completed = progress?.completed ?? 0;
  const total = progress?.total ?? 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const validCount = progress?.validCount ?? 0;
  const invalidCount = progress?.invalidCount ?? 0;
  const parseErrorCount = progress?.parseErrorCount ?? 0;
  const apiErrorCount = progress?.apiErrorCount ?? 0;
  const skippedCount = progress?.skippedCount ?? 0;

  return (
    <div className="run-progress">
      <div className="run-progress-header">
        <h3 className="run-progress-title">
          {isRunning ? "Running Benchmark" : "Run Complete"}
        </h3>
        <span className="progress-elapsed">{formatElapsed(elapsedMs)}</span>
      </div>

      {/* Current status */}
      {isRunning && progress?.currentTheoremId && (
        <div className="progress-current">
          <span className="progress-current-model">
            {(progress.currentModel && MODEL_DISPLAY[progress.currentModel]) || progress.currentModel}
          </span>
          <span className="progress-current-theorem">
            {progress.currentTheoremId}
          </span>
          {progress.currentDifficulty && (
            <span className="progress-current-difficulty">
              {progress.currentDifficulty}
            </span>
          )}
        </div>
      )}

      {/* Progress bar */}
      <div className="progress-bar-wrapper">
        <div className="progress-bar">
          <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="progress-label">
          {completed} / {total} ({pct}%)
        </span>
      </div>

      {/* Stats row */}
      <div className="progress-stats">
        <span className="progress-stat progress-stat--valid">
          Valid: {validCount}
        </span>
        <span className="progress-stat progress-stat--invalid">
          Invalid: {invalidCount}
        </span>
        {parseErrorCount > 0 && (
          <span className="progress-stat progress-stat--error">
            Parse Errors: {parseErrorCount}
          </span>
        )}
        {apiErrorCount > 0 && (
          <span className="progress-stat progress-stat--error">
            API Errors: {apiErrorCount}
          </span>
        )}
        {skippedCount > 0 && (
          <span className="progress-stat progress-stat--skipped">
            Skipped: {skippedCount}
          </span>
        )}
      </div>

      {/* Live log area */}
      {logs.length > 0 && (
        <div className="progress-log" ref={logRef}>
          {logs.map((line, i) => (
            <div key={i} className="progress-log-line">
              {line}
            </div>
          ))}
        </div>
      )}

      {/* Stop button */}
      {isRunning && (
        <button className="btn-stop" onClick={onStop}>
          Stop Benchmark
        </button>
      )}

      {/* Completion message */}
      {!isRunning && progress && (
        <p className="progress-hint">
          Benchmark complete. View results in the Dashboard.
        </p>
      )}
    </div>
  );
}

export default RunProgress;
