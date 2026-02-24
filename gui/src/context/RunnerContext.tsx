import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { api } from "../api/client";
import type { StartBenchmarkOpts } from "../api/client";
import type { SSEProgressEvent } from "../components/RunProgress";

interface RunnerState {
  isRunning: boolean;
  runId: string | null;
  progress: SSEProgressEvent | null;
  logs: string[];
  elapsedMs: number;
  error: string;
  historyRefresh: number;
}

interface RunnerActions {
  start: (opts: StartBenchmarkOpts) => Promise<void>;
  stop: () => Promise<void>;
  clearError: () => void;
}

type RunnerContextValue = RunnerState & RunnerActions;

const RunnerContext = createContext<RunnerContextValue | null>(null);

export function useRunner(): RunnerContextValue {
  const ctx = useContext(RunnerContext);
  if (!ctx) throw new Error("useRunner must be used within RunnerProvider");
  return ctx;
}

export function RunnerProvider({ children }: { children: ReactNode }) {
  const [isRunning, setIsRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<SSEProgressEvent | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState("");
  const [historyRefresh, setHistoryRefresh] = useState(0);

  const eventSourceRef = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const runningRef = useRef(false);

  const startTimer = useCallback(() => {
    startTimeRef.current = Date.now();
    setElapsedMs(0);
    timerRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startTimeRef.current);
    }, 1000);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (startTimeRef.current > 0) {
      setElapsedMs(Date.now() - startTimeRef.current);
    }
  }, []);

  const connectSSE = useCallback(
    (id: string) => {
      const es = api.getBenchmarkStatus(id);
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as SSEProgressEvent;

          if (data.type === "progress") {
            setProgress(data);
          } else if (data.type === "log") {
            if (data.message) {
              setLogs((prev) => [...prev, data.message!]);
            }
          } else if (data.type === "complete") {
            runningRef.current = false;
            setIsRunning(false);
            setProgress(data);
            stopTimer();
            es.close();
            eventSourceRef.current = null;
            setHistoryRefresh((v) => v + 1);
          } else if (data.type === "error") {
            runningRef.current = false;
            setError(data.error ?? "Unknown error during benchmark");
            setIsRunning(false);
            stopTimer();
            es.close();
            eventSourceRef.current = null;
          }
        } catch {
          setLogs((prev) => [...prev, event.data]);
        }
      };

      es.onerror = () => {
        es.close();
        eventSourceRef.current = null;
        if (runningRef.current) {
          // Reconnect after a short delay (tab switch, network blip, etc.)
          setTimeout(() => {
            if (runningRef.current) {
              connectSSE(id);
            }
          }, 2000);
        }
      };
    },
    [stopTimer],
  );

  // On mount, check for active runs and reconnect
  useEffect(() => {
    let cancelled = false;
    api.getActiveBenchmarks().then(({ runIds }) => {
      if (!cancelled && runIds.length > 0 && !runningRef.current) {
        const id = runIds[0];
        runningRef.current = true;
        setIsRunning(true);
        setRunId(id);
        startTimer();
        connectSSE(id);
      }
    }).catch(() => {
      // Server not reachable or endpoint not available yet — ignore
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useCallback(
    async (opts: StartBenchmarkOpts) => {
      setError("");
      setProgress(null);
      setLogs([]);
      setElapsedMs(0);

      try {
        runningRef.current = true;
        setIsRunning(true);
        const { runId: id } = await api.startBenchmark(opts);
        setRunId(id);
        startTimer();
        connectSSE(id);
      } catch (err) {
        runningRef.current = false;
        setIsRunning(false);
        setError(
          err instanceof Error ? err.message : "Failed to start benchmark",
        );
      }
    },
    [startTimer, connectSSE],
  );

  const stop = useCallback(async () => {
    if (!runId) return;
    runningRef.current = false;
    try {
      await api.stopBenchmark(runId);
    } catch {
      // Best-effort stop
    }
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setIsRunning(false);
    stopTimer();
    setHistoryRefresh((v) => v + 1);
  }, [runId, stopTimer]);

  const clearError = useCallback(() => setError(""), []);

  return (
    <RunnerContext.Provider
      value={{
        isRunning,
        runId,
        progress,
        logs,
        elapsedMs,
        error,
        historyRefresh,
        start,
        stop,
        clearError,
      }}
    >
      {children}
    </RunnerContext.Provider>
  );
}
