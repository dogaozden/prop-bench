import { useCallback, useEffect, useMemo, useState } from "react";
import "../styles/tracks.css";

type TrackKind = "unaided" | "frontier";
type FrontierMode = "fresh" | "cumulative";
type Provider = "claude-subscription" | "codex-subscription" | "gemini" | "openrouter" | "fixture" | "external";
type RunProvider = "codex-subscription" | "fixture";
type SelectionMode = "all" | "explicit";

interface SubscriptionSettings {
  effort: string;
  max_tool_calls: number;
}

interface SetSummary {
  name: string;
  version: string;
  count: number;
  ids: string[];
  core_tag: string;
}

interface Budget {
  wall_seconds: number;
  max_generations: number;
  max_output_tokens: number;
  max_thinking_tokens: number;
}

interface TrackConfig {
  run_id: string;
  track: TrackKind;
  mode: "fresh" | "cumulative" | "unaided";
  model: string;
  provider: Provider;
  execution_protocol?: "unaided-v1" | "frontier-controller-v1" | "external-mcp-v1" | "unaided-subscription-v1" | "frontier-subscription-v1" | "frontier-subscription-v2";
  subscription?: SubscriptionSettings;
  temperature: number;
  budget: Budget;
  starting_snapshot: string | null;
  set_version: string;
  set_hash: string;
  selected_ids: string[];
  core_tag: string;
  created_at: string;
}

type Outcome = "valid" | "invalid" | "parse_error" | "transport_error" | "protocol_error" | "missing" | "interrupted";

interface ScoredItem {
  id: string;
  par: number;
  status: Outcome;
  line_count: number | null;
  errors: string[];
  loss: number;
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
}

interface TrackReport {
  schema_version: "propbench-report-v1";
  config: TrackConfig;
  cohort: string;
  graded_at: string;
  score: number;
  valid_count: number;
  total: number;
  valid_rate: number;
  total_lines: number;
  mean_valid_lines: number | null;
  items: ScoredItem[];
  usage: Usage;
  generations: number | null;
  usage_coverage?: { attempts_with_usage: number; attempts: number } | null;
  execution_commands?: number | null;
  elapsed_seconds?: number | null;
  evaluation_status?: "complete" | "unexecuted" | "external-unmetered" | "interrupted";
  execution_protocol?: string | null;
  returned_models?: string[];
  returned_model?: string | null;
  actual_model?: string | null;
  returned_backends?: string[];
  dispatches?: { not_started: number; dispatched: number; response_confirmed: number; uncertain: number };
  regraded_by?: string;
  runtime?: { backend: string; image_id: string; architecture: string } | null;
  evidence: "fixture" | "provider" | "external-submission" | "subscription";
  client_sessions?: number;
  tool_calls?: number;
}

interface Handoff {
  run_dir: string;
  bundle_dir: string;
  handoff_command: string;
  bridge_command: string;
  submit_command: string;
  mcp_server: { command: string; args: string[]; env?: { PROPBENCH_DOCKER_HOST: string } };
  requirement: string;
  note: string;
}

interface TrackStatus {
  runId: string;
  track: TrackKind;
  mode: string;
  state: "preparing" | "prepared" | "running" | "complete" | "error";
  startedAt: string;
  finishedAt: string | null;
  completed: number;
  generations: number | null;
  client_sessions?: number | null;
  tool_calls?: number | null;
  provider?: Provider;
  subscription?: SubscriptionSettings;
  budget?: Budget;
  total: number;
  error: string | null;
  finished_reason?: string | null;
  handoff: Handoff | null;
  report: TrackReport | null;
}

interface LeaderboardEntry {
  rank: number;
  run_id: string | null;
  model: string;
  provider: string;
  score: number;
  valid_count: number;
  total: number;
  valid_rate: number;
  total_lines: number;
  mean_valid_lines: number | null;
  generations: number | null;
  usage_coverage?: { attempts_with_usage: number; attempts: number } | null;
  evaluation_status?: TrackReport["evaluation_status"];
  evidence: TrackReport["evidence"];
  usage: Usage;
  subscription?: SubscriptionSettings | null;
}

interface LeaderboardGroup {
  cohort: string;
  track: TrackKind | null;
  mode: string | null;
  set_version: string | null;
  set_hash: string | null;
  budget: Budget | null;
  temperature: number | null;
  provider?: string | null;
  subscription?: SubscriptionSettings | null;
  entries: LeaderboardEntry[];
}

interface Bootstrap {
  sets: SetSummary[];
  reports: TrackReport[];
  leaderboards: LeaderboardGroup[];
  active: TrackStatus[];
  unaidedBudget: Budget;
  frontierBudget: Budget;
  frontierRuns: FrontierRunOption[];
  unaidedSubscription?: SubscriptionSettings;
  frontierSubscription?: SubscriptionSettings;
}

interface FrontierRunOption {
  run_id: string;
  model: string;
  mode: FrontierMode;
  set_version: string;
  set_hash: string;
  starting_snapshot: string | null;
  state: "prepared" | "complete";
  score: number | null;
}

interface Preferences {
  version?: number;
  track?: TrackKind;
  frontierMode?: FrontierMode;
  setName?: string;
  selectionMode?: SelectionMode;
  selectedIds?: string[];
  provider?: RunProvider;
  model?: string;
  temperature?: number;
  subscriptionEffort?: string;
  frontierMaxToolCalls?: number;
}

interface ApiError {
  error?: string;
}

const PREFERENCES_VERSION = 2;
const PREFERENCES_KEY = "propbench-track-preferences-v2";
const DEFAULT_BUDGET: Budget = {
  wall_seconds: 300,
  max_generations: 1,
  max_output_tokens: 4096,
  max_thinking_tokens: 8192,
};
const DEFAULT_FRONTIER_BUDGET: Budget = {
  wall_seconds: 3600,
  max_generations: 24,
  max_output_tokens: 8192,
  max_thinking_tokens: 16384,
};

const DEFAULT_SUBSCRIPTION_MAX_TOOL_CALLS = 96;
const DEFAULT_MODEL_BY_PROVIDER: Record<RunProvider, string> = {
  "codex-subscription": "gpt-6-astra",
  fixture: "fixture-v1",
};

function isSubscriptionProvider(provider: string | undefined): provider is "claude-subscription" | "codex-subscription" {
  return provider === "claude-subscription" || provider === "codex-subscription";
}

function defaultEffortForProvider(_provider: RunProvider): string {
  return "xhigh";
}

function defaultModelForProvider(provider: RunProvider): string {
  return DEFAULT_MODEL_BY_PROVIDER[provider];
}

function providerLabel(provider: Provider): string {
  switch (provider) {
    case "claude-subscription": return "Claude subscription";
    case "codex-subscription": return "Codex subscription";
    case "fixture": return "Fixture rehearsal";
    case "external": return "External owner handoff";
    case "gemini": return "Gemini";
    case "openrouter": return "OpenRouter";
    default: return provider;
  }
}

function configUsesSubscription(config: TrackConfig | undefined): boolean {
  return !!config && (isSubscriptionProvider(config.provider) || config.execution_protocol === "unaided-subscription-v1" || config.execution_protocol === "frontier-subscription-v1" || config.execution_protocol === "frontier-subscription-v2");
}

function reportUsesSubscription(report: TrackReport | null | undefined): boolean {
  return !!report && (report.evidence === "subscription" || configUsesSubscription(report.config));
}

function modelWasDefaultForProvider(modelValue: string, provider: RunProvider): boolean {
  const model = modelValue.trim();
  if (!model) return true;
  if (model === defaultModelForProvider(provider)) return true;
  return false;
}

function loadPreferences(): Preferences {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? "{}");
    if (!value || typeof value !== "object") return {};
    const preferences = value as Preferences;
    return preferences.version === PREFERENCES_VERSION ? preferences : {};
  } catch {
    return {};
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      ? String((body as ApiError).error ?? `HTTP ${response.status}`)
      : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

function formatNumber(value: number | null | undefined, fractionDigits = 2): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(fractionDigits) : "Unknown";
}

function formatRate(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "Unknown";
}

function formatUsage(usage: Usage | undefined): string {
  if (!usage || !Object.keys(usage).length) return "Usage unavailable";
  const fields: string[] = [];
  if (typeof usage.total_tokens === "number") fields.push(`${usage.total_tokens.toLocaleString()} total tokens`);
  if (typeof usage.input_tokens === "number") fields.push(`${usage.input_tokens.toLocaleString()} in`);
  if (typeof usage.output_tokens === "number") fields.push(`${usage.output_tokens.toLocaleString()} out`);
  if (typeof usage.thinking_tokens === "number") fields.push(`${usage.thinking_tokens.toLocaleString()} thinking`);
  return fields.length ? fields.join(" · ") : "Usage unavailable";
}

function formatGenerations(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "Unknown";
}

function formatCoverage(coverage: { attempts_with_usage: number; attempts: number } | null | undefined): string {
  if (!coverage || !Number.isFinite(coverage.attempts_with_usage) || !Number.isFinite(coverage.attempts)) return "Usage coverage unknown";
  return `${coverage.attempts_with_usage}/${coverage.attempts} attempts with usage`;
}

function formatEvaluationStatus(status: TrackReport["evaluation_status"]): string {
  switch (status) {
    case "complete": return "Complete / ranked";
    case "external-unmetered": return "External / unmetered";
    case "unexecuted": return "Prepared / unexecuted";
    case "interrupted": return "Interrupted";
    default: return "Evaluation status unknown";
  }
}

function formatDispatches(dispatches: TrackReport["dispatches"]): string {
  if (!dispatches) return "Request status unavailable";
  return `${dispatches.response_confirmed} completed · ${dispatches.dispatched} sent · ${dispatches.uncertain} uncertain`;
}

function formatReturned(values: string[] | undefined, empty = "Unknown"): string {
  if (!values?.length) return empty;
  return values.join(", ");
}

function evidenceLabel(evidence: TrackReport["evidence"] | undefined): string {
  switch (evidence) {
    case "fixture": return "Fixture rehearsal";
    case "provider": return "Provider evidence";
    case "external-submission": return "External submission";
    case "subscription": return "Subscription evidence";
    default: return "Unknown evidence";
  }
}

function formatClientSessions(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString()} client session${value === 1 ? "" : "s"}` : "Unknown client sessions";
}

function formatToolCalls(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "Unknown";
}

function formatActualModel(report: TrackReport): string {
  if (report.returned_models?.length) return report.returned_models.join(", ");
  if (typeof report.returned_model === "string" && report.returned_model.trim()) return report.returned_model;
  if (typeof report.actual_model === "string" && report.actual_model.trim()) return report.actual_model;
  return "Unknown";
}

function formatSubscriptionCohort(group: LeaderboardGroup): string {
  const settings = group.subscription ?? group.entries.find((entry) => entry.subscription)?.subscription ?? null;
  const effort = settings?.effort?.trim() || "Unknown effort";
  const wall = typeof group.budget?.wall_seconds === "number" ? `${group.budget.wall_seconds.toLocaleString()}s wall` : "Unknown wall";
  const toolCalls = typeof settings?.max_tool_calls === "number"
    ? `${settings.max_tool_calls.toLocaleString()} tool calls`
    : typeof (group.budget as (Budget & { max_tool_calls?: number }) | null)?.max_tool_calls === "number"
      ? `${(group.budget as Budget & { max_tool_calls: number }).max_tool_calls.toLocaleString()} tool calls`
      : "Unknown tool allowance";
  return `${effort} effort · ${wall} · ${toolCalls}`;
}

function leaderboardUsesSubscription(group: LeaderboardGroup): boolean {
  return isSubscriptionProvider(group.provider ?? undefined)
    || !!group.subscription
    || group.entries.some((entry) => entry.evidence === "subscription" || isSubscriptionProvider(entry.provider));
}

function formatReportActivity(report: TrackReport): string {
  const fields = [formatUsage(report.usage)];
  if (reportUsesSubscription(report)) {
    fields.push(formatClientSessions(report.client_sessions));
    if (report.config.track === "unaided") {
      fields.push("one fresh session per theorem", "no tools or verifier feedback");
    } else {
      const toolCalls = report.config.subscription?.max_tool_calls;
      fields.push(typeof report.tool_calls === "number" ? `${report.tool_calls.toLocaleString()} tool calls used` : "Tool calls used unknown");
      fields.push(typeof toolCalls === "number" ? `${toolCalls.toLocaleString()} tool calls allowed` : "Tool allowance unknown");
    }
  } else {
    fields.push(`${formatGenerations(report.generations)} request${report.generations === 1 ? "" : "s"}`);
  }
  fields.push(formatCoverage(report.usage_coverage), formatDispatches(report.dispatches));
  if (report.config.track === "unaided") fields.push("no execution tools");
  else if (report.execution_commands === null || report.execution_commands === undefined) fields.push("execution commands unknown");
  else fields.push(`${report.execution_commands} execution commands`);
  return fields.join(" · ");
}

function stateLabel(state: TrackStatus["state"]): string {
  switch (state) {
    case "prepared": return "Prepared";
    case "running": return "Running";
    case "complete": return "Complete";
    case "error": return "Failed";
    default: return "Preparing";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function Tracks() {
  const preferences = useMemo(loadPreferences, []);
  const initialTrack: TrackKind = preferences.track === "frontier" ? "frontier" : "unaided";
  const preferredProvider = preferences.provider;
  const hasSelectableProviderPreference = preferredProvider === "codex-subscription" || preferredProvider === "fixture";
  const initialProvider: RunProvider = hasSelectableProviderPreference ? preferredProvider : "codex-subscription";
  const initialModel = hasSelectableProviderPreference ? preferences.model?.trim() || defaultModelForProvider(initialProvider) : defaultModelForProvider(initialProvider);
  const [track, setTrack] = useState<TrackKind>(initialTrack);
  const [frontierMode, setFrontierMode] = useState<FrontierMode>(preferences.frontierMode === "cumulative" ? "cumulative" : "fresh");
  const [sets, setSets] = useState<SetSummary[]>([]);
  const [setName, setSetName] = useState(preferences.setName ?? "");
  const [selectionMode, setSelectionMode] = useState<SelectionMode>(preferences.selectionMode === "explicit" ? "explicit" : "all");
  const [selectedIds, setSelectedIds] = useState<string[]>(preferences.selectedIds ?? []);
  const [provider, setProvider] = useState<RunProvider>(initialProvider);
  const [model, setModel] = useState(initialModel);
  const [temperature, setTemperature] = useState(preferences.temperature ?? 0.2);
  const [subscriptionEffort, setSubscriptionEffort] = useState(preferences.subscriptionEffort ?? defaultEffortForProvider(initialProvider));
  const [frontierMaxToolCalls, setFrontierMaxToolCalls] = useState(
    typeof preferences.frontierMaxToolCalls === "number" && Number.isSafeInteger(preferences.frontierMaxToolCalls) && preferences.frontierMaxToolCalls >= 0
      ? preferences.frontierMaxToolCalls
      : DEFAULT_SUBSCRIPTION_MAX_TOOL_CALLS,
  );
  const [reports, setReports] = useState<TrackReport[]>([]);
  const [leaderboards, setLeaderboards] = useState<LeaderboardGroup[]>([]);
  const [unaidedBudget, setUnaidedBudget] = useState<Budget>(DEFAULT_BUDGET);
  const [frontierBudget, setFrontierBudget] = useState<Budget>(DEFAULT_FRONTIER_BUDGET);
  const [frontierRuns, setFrontierRuns] = useState<FrontierRunOption[]>([]);
  const [priorRunId, setPriorRunId] = useState("");
  const [fixtureResponsesText, setFixtureResponsesText] = useState("");
  const [runId, setRunId] = useState("");
  const [status, setStatus] = useState<TrackStatus | null>(null);
  const [selectedReport, setSelectedReport] = useState<TrackReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");

  const selectedSet = sets.find((set) => set.name === setName) ?? null;
  const selectedCount = selectionMode === "all" ? selectedSet?.count ?? 0 : selectedIds.length;
  const hasValidSelection = !!selectedSet && selectedCount > 0 && (selectionMode === "all" || selectedIds.every((id) => selectedSet.ids.includes(id)));
  const activeBudget = track === "frontier" ? frontierBudget : unaidedBudget;
  const legacyBudgetIsValid = Object.values(activeBudget).every((value) => Number.isSafeInteger(value) && value >= 0)
    && activeBudget.wall_seconds > 0
    && activeBudget.max_generations > 0
    && activeBudget.max_output_tokens > 0
    && activeBudget.max_thinking_tokens <= 1_000_000
    && activeBudget.wall_seconds <= 7 * 86400
    && activeBudget.max_generations <= 100_000
    && activeBudget.max_output_tokens <= 1_000_000;
  const subscriptionBudgetIsValid = activeBudget.wall_seconds > 0
    && activeBudget.wall_seconds <= 7 * 86400
    && (track === "unaided" || (Number.isSafeInteger(frontierMaxToolCalls) && frontierMaxToolCalls >= 0 && frontierMaxToolCalls <= 10000));
  const budgetIsValid = isSubscriptionProvider(provider) ? subscriptionBudgetIsValid : legacyBudgetIsValid;
  const fixtureIsReady = provider !== "fixture" || fixtureResponsesText.trim().length > 0;
  const canSubmit = !loading && !submitting && hasValidSelection && model.trim().length > 0 && subscriptionEffort.trim().length > 0 && budgetIsValid && fixtureIsReady
    && (track !== "frontier" || frontierMode !== "cumulative" || !!priorRunId);

  const refreshReports = useCallback(async () => {
    const response = await requestJson<{ reports: TrackReport[]; leaderboards: LeaderboardGroup[]; frontierRuns?: FrontierRunOption[] }>("/api/tracks/reports");
    setReports(response.reports);
    setLeaderboards(response.leaderboards);
    if (response.frontierRuns) setFrontierRuns(response.frontierRuns);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    requestJson<Bootstrap>("/api/tracks")
      .then((response) => {
        if (cancelled) return;
        setSets(response.sets);
        setReports(response.reports);
        setLeaderboards(response.leaderboards);
        setUnaidedBudget({ ...DEFAULT_BUDGET, ...(response.unaidedBudget ?? {}) });
        setFrontierBudget({ ...DEFAULT_FRONTIER_BUDGET, ...(response.frontierBudget ?? {}) });
        if (!preferences.subscriptionEffort) {
          const bootstrapEffort = (track === "frontier" ? response.frontierSubscription?.effort : response.unaidedSubscription?.effort);
          if (typeof bootstrapEffort === "string" && bootstrapEffort.trim()) setSubscriptionEffort(bootstrapEffort);
        }
        if (preferences.frontierMaxToolCalls === undefined) {
          const bootstrapToolCalls = response.frontierSubscription?.max_tool_calls;
          if (typeof bootstrapToolCalls === "number" && Number.isSafeInteger(bootstrapToolCalls) && bootstrapToolCalls >= 0) setFrontierMaxToolCalls(bootstrapToolCalls);
        }
        setFrontierRuns(response.frontierRuns ?? []);
        setRunId(response.active[0]?.runId ?? "");
        setStatus(response.active[0] ?? null);
        setSetName((current) => response.sets.some((set) => set.name === current) ? current : response.sets[0]?.name ?? "");
        setError("");
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorText(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify({
        version: PREFERENCES_VERSION,
        track,
        frontierMode,
        setName,
        selectionMode,
        selectedIds,
        provider,
        model,
        temperature,
        subscriptionEffort,
        frontierMaxToolCalls,
      } satisfies Preferences));
    } catch {
      // Preferences are a convenience; a restricted browser storage policy
      // should never block a run.
    }
  }, [track, frontierMode, setName, selectionMode, selectedIds, provider, model, temperature, subscriptionEffort, frontierMaxToolCalls]);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const next = await requestJson<TrackStatus>(`/api/tracks/status/${encodeURIComponent(runId)}`);
        if (cancelled) return;
        setStatus(next);
        setPollError("");
        if (next.state === "running" || next.state === "preparing") {
          timer = window.setTimeout(() => { void poll(); }, 1000);
        } else if (next.state === "complete" || next.state === "error") {
          if (next.report) setSelectedReport(next.report);
          try { await refreshReports(); } catch (reason: unknown) { setPollError(errorText(reason)); }
        }
      } catch (reason: unknown) {
        if (!cancelled) {
          // Keep the last good status visible while surfacing the polling error.
          setPollError(errorText(reason));
          timer = window.setTimeout(() => { void poll(); }, 2000);
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [runId, refreshReports]);

  const handleSetChange = (next: string) => {
    setSetName(next);
    setSelectedIds([]);
    setPriorRunId("");
    setFixtureResponsesText("");
  };

  const handleTrackChange = (next: TrackKind) => {
    setTrack(next);
  };

  const handleProviderChange = (next: RunProvider) => {
    const previous = provider;
    setProvider(next);
    if (isSubscriptionProvider(next)) setSubscriptionEffort(defaultEffortForProvider(next));
    setModel((current) => modelWasDefaultForProvider(current, previous) ? defaultModelForProvider(next) : current);
  };

  const handleIdsText = (text: string) => {
    setSelectedIds(text.split(/[\s,]+/).map((id) => id.trim()).filter(Boolean));
  };

  const toggleId = (id: string) => {
    setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  };

  const updateFrontierBudget = (key: keyof Budget, value: string) => {
    setFrontierBudget((current) => ({ ...current, [key]: value.trim() ? Number(value) : 0 }));
  };

  const updateFrontierToolCalls = (value: string) => {
    setFrontierMaxToolCalls(value.trim() ? Number(value) : 0);
  };

  const requestBody = () => {
    const body: Record<string, unknown> = {
      set: setName,
      ...(selectionMode === "explicit" ? { ids: selectedIds } : {}),
      provider,
      model: model.trim(),
    };
    if (!isSubscriptionProvider(provider)) body.temperature = temperature;
    if (track === "frontier") body.budget = frontierBudget;
    if (isSubscriptionProvider(provider)) {
      body.subscription = {
        effort: subscriptionEffort.trim(),
        max_tool_calls: track === "unaided" ? 0 : frontierMaxToolCalls,
      } satisfies SubscriptionSettings;
    }
    if (provider === "fixture") {
      let fixtureResponses: unknown;
      try {
        fixtureResponses = JSON.parse(fixtureResponsesText);
      } catch {
        throw new Error("Fixture responses must be valid JSON");
      }
      if (track === "frontier") {
        if (!Array.isArray(fixtureResponses)) throw new Error("Controlled Frontier fixture responses must be a JSON array");
      } else if (!fixtureResponses || typeof fixtureResponses !== "object" || Array.isArray(fixtureResponses)) {
        throw new Error("Unaided fixture responses must be a JSON object keyed by item ID");
      }
      body.fixtureResponses = fixtureResponses;
    }
    return body;
  };

  const startUnaided = async () => {
    setSubmitting(true);
    setError("");
    setPollError("");
    try {
      const response = await requestJson<{ runId: string; state: TrackStatus["state"]; total: number }>("/api/tracks/unaided", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody()),
      });
      setRunId(response.runId);
      setStatus({
        runId: response.runId,
        track: "unaided",
        mode: "unaided",
        state: response.state,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        completed: 0,
        generations: usingSubscription ? null : 0,
        client_sessions: usingSubscription ? 0 : undefined,
        tool_calls: usingSubscription ? 0 : undefined,
        provider,
        subscription: usingSubscription ? currentSubscription : undefined,
        budget: unaidedBudget,
        total: response.total,
        error: null,
        handoff: null,
        report: null,
      });
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setSubmitting(false);
    }
  };

  const startFrontier = async () => {
    setSubmitting(true);
    setError("");
    setPollError("");
    try {
      const response = await requestJson<{ runId: string; state: TrackStatus["state"]; mode: FrontierMode; total: number }>("/api/tracks/frontier/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...requestBody(), mode: frontierMode, priorRunId: frontierMode === "cumulative" ? priorRunId : undefined }),
      });
      setRunId(response.runId);
      setStatus({
        runId: response.runId,
        track: "frontier",
        mode: response.mode,
        state: response.state,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        completed: 0,
        generations: usingSubscription ? null : 0,
        client_sessions: usingSubscription ? 0 : undefined,
        tool_calls: usingSubscription ? 0 : undefined,
        provider,
        subscription: usingSubscription ? currentSubscription : undefined,
        budget: frontierBudget,
        total: response.total,
        error: null,
        handoff: null,
        report: null,
      });
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setSubmitting(false);
    }
  };

  const usingSubscription = isSubscriptionProvider(provider);
  const currentSubscription: SubscriptionSettings = {
    effort: subscriptionEffort.trim(),
    max_tool_calls: track === "unaided" ? 0 : frontierMaxToolCalls,
  };
  const statusUsesSubscription = !!status && (reportUsesSubscription(status.report) || isSubscriptionProvider(status.provider) || (status.report === null && usingSubscription));
  const activeAction = track === "unaided" ? startUnaided : startFrontier;
  const actionLabel = track === "unaided" ? "Start Unaided" : "Start Frontier";

  return (
    <div className="tracks-page">
      <header className="tracks-header">
        <div>
          <p className="tracks-eyebrow">Choose how the proof is made</p>
          <h2>Tracks</h2>
          <p>Measure proofs made without tools, or let a fully equipped agent search for shorter proofs. Both tracks use the same rules and verifier.</p>
        </div>
        <div className="tracks-scorer-note">
          <span>Scorer</span>
          <strong>efficiency-v2</strong>
          <small>lower loss is better</small>
        </div>
      </header>

      {error && (
        <div className="tracks-alert tracks-alert--error" role="alert">
          <strong>Track API error</strong>
          <span>{error}</span>
          <button type="button" className="tracks-link-button" onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
      {pollError && (
        <div className="tracks-alert tracks-alert--warning" role="status">
          <strong>Status refresh delayed</strong>
          <span>{pollError}</span>
        </div>
      )}

      <section className="track-choice" aria-label="Choose a track">
        <button type="button" className={`track-card ${track === "unaided" ? "is-selected" : ""}`} onClick={() => handleTrackChange("unaided")}>
          <span className="track-card-kicker">Track 01 · no tools</span>
          <span className="track-card-title">Unaided</span>
          <span className="track-card-copy">One fresh client session per theorem. The model cannot run programs or receive verifier feedback before the final grade.</span>
          <span className="track-card-tags"><span>No tools</span><span>Fresh session</span><span>Subscription ready</span></span>
        </button>
        <button type="button" className={`track-card track-card--frontier ${track === "frontier" ? "is-selected" : ""}`} onClick={() => handleTrackChange("frontier")}>
          <span className="track-card-kicker">Track 02 · tools in a separate workspace</span>
          <span className="track-card-title">Frontier</span>
          <span className="track-card-copy">Use scripts, custom solvers, subagents, and repeated checks to reduce proof length. Start fresh or inherit previous work.</span>
          <span className="track-card-tags"><span>Tools + subagents</span><span>Fresh / cumulative</span><span>Shared budget</span></span>
        </button>
      </section>

      <section className="tracks-workspace">
        <div className="tracks-config-card">
          <div className="section-heading">
            <div>
              <p className="tracks-eyebrow">{track === "unaided" ? "Unaided setup" : "Frontier setup"}</p>
              <h3>{track === "unaided" ? "Set the session limits" : "Set the agent's limits"}</h3>
            </div>
            <span className="track-status-pill">{track === "unaided" ? "Grade at the end" : "Start here"}</span>
          </div>

          {track === "frontier" && (
            <div className="field-group">
              <span className="field-label">Workspace history</span>
              <div className="segmented-control">
                <button type="button" className={frontierMode === "fresh" ? "is-active" : ""} onClick={() => setFrontierMode("fresh")}>Fresh</button>
                <button type="button" className={frontierMode === "cumulative" ? "is-active" : ""} onClick={() => setFrontierMode("cumulative")}>Cumulative</button>
              </div>
              <small className="field-help">Fresh starts empty. Cumulative carries forward the exact workspace you choose below.</small>
              {frontierMode === "cumulative" && (
                <select className="tracks-select" value={priorRunId} onChange={(event) => setPriorRunId(event.target.value)}>
                <option value="">Choose a prior workspace…</option>
                  {frontierRuns.map((run) => (
                    <option key={run.run_id} value={run.run_id}>
                      {run.run_id.slice(0, 8)} · {run.model} · {run.mode} · {run.state === "complete" ? `${formatNumber(run.score, 3)} loss` : "prepared"}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          <div className="config-grid">
            <label className="field-group">
              <span className="field-label">Frozen set</span>
              <select className="tracks-select" value={setName} onChange={(event) => handleSetChange(event.target.value)} disabled={loading}>
                <option value="">Choose a set…</option>
                {sets.map((set) => <option key={set.name} value={set.name}>{set.name} · {set.count} items · {set.core_tag}</option>)}
              </select>
              {selectedSet && <small className="field-help">{selectedSet.version} · {selectedSet.count} hashed items · core {selectedSet.core_tag}</small>}
            </label>

            <div className="field-group">
              <span className="field-label">Item selection</span>
              <div className="segmented-control">
                <button type="button" className={selectionMode === "all" ? "is-active" : ""} onClick={() => setSelectionMode("all")}>All items</button>
                <button type="button" className={selectionMode === "explicit" ? "is-active" : ""} onClick={() => setSelectionMode("explicit")}>Explicit IDs</button>
              </div>
              <small className="field-help">{selectedCount} of {selectedSet?.count ?? 0} selected</small>
            </div>
          </div>

          {selectionMode === "explicit" && selectedSet && (
            <div className="explicit-selection">
              <label className="field-group">
                <span className="field-label">IDs</span>
                <textarea className="tracks-textarea" value={selectedIds.join(", ")} onChange={(event) => handleIdsText(event.target.value)} placeholder="g1-2000001, g2-2100023" rows={2} />
                <small className="field-help">Use comma or whitespace separated IDs. The server accepts only IDs from the selected frozen set.</small>
              </label>
              <div className="id-check-grid" aria-label="Set item IDs">
                {selectedSet.ids.map((id) => (
                  <label key={id} className={`id-check ${selectedIds.includes(id) ? "is-checked" : ""}`}>
                    <input type="checkbox" checked={selectedIds.includes(id)} onChange={() => toggleId(id)} />
                    <span>{id}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="config-grid config-grid--three">
            <label className="field-group">
              <span className="field-label">How it runs</span>
              <select className="tracks-select" value={provider} onChange={(event) => handleProviderChange(event.target.value as RunProvider)}>
                <option value="codex-subscription">Codex subscription · live</option>
                <option value="fixture">Fixture rehearsal · local test</option>
              </select>
              <small className="field-help">{usingSubscription ? "Uses your native Codex subscription. The requested model and effort are checked before inference." : "Local, deterministic test responses. Fixture results are labeled separately from live evidence."}</small>
            </label>
            <label className="field-group">
              <span className="field-label">{usingSubscription ? "Native Codex model" : "Fixture label"}</span>
              <input className="tracks-input" list="track-model-options" value={model} onChange={(event) => setModel(event.target.value)} placeholder="model name" />
              <datalist id="track-model-options">
                {provider === "codex-subscription" && <option value="gpt-6-astra" />}
                {provider === "fixture" && <option value="fixture-v1" />}
              </datalist>
            </label>
            {usingSubscription ? (
              <label className="field-group">
                <span className="field-label">Native effort</span>
                <select className="tracks-select" value={subscriptionEffort} onChange={(event) => setSubscriptionEffort(event.target.value)}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="xhigh">Extra high</option>
                  <option value="max">Max</option>
                  <option value="ultra">Ultra</option>
                </select>
                <small className="field-help">The native client owns its internal turns and token use.</small>
              </label>
            ) : (
              <label className="field-group">
                <span className="field-label">Temperature <output>{temperature.toFixed(1)}</output></span>
                <input className="tracks-range" type="range" min="0" max="2" step="0.1" value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} />
                <small className="field-help">Saved with the run so matching results stay comparable.</small>
              </label>
            )}
          </div>

          {provider === "fixture" && (
            <label className="field-group fixture-input-group">
              <span className="field-label">{track === "frontier" ? "Frontier fixture responses JSON" : "Fixture responses JSON"}</span>
              <textarea
                className="tracks-textarea fixture-responses"
                value={fixtureResponsesText}
                onChange={(event) => setFixtureResponsesText(event.target.value)}
                placeholder={track === "frontier" ? '[{"response":"[]"}]' : '{"r1":"[]"}'}
                rows={3}
                spellCheck={false}
              />
              <small className="field-help">{track === "frontier" ? "Provide an ordered array of assistant responses, including tool calls. Every parent and delegated response consumes one generation." : "Use an object with one response per selected item ID. Missing or malformed responses remain visible in the results."}</small>
            </label>
          )}

          <div className="budget-panel">
            <div>
              <span className="field-label">{track === "unaided" ? usingSubscription ? "Fixed Unaided subscription limits" : "Fixed Unaided limits" : usingSubscription ? "Frontier subscription limits" : "Frontier limits"}</span>
              <p>{track === "unaided"
                ? usingSubscription
                  ? "One fresh tool-free client session per selected theorem; the wall clock is fixed."
                  : "One request is allowed per selected theorem; these limits are fixed."
                : usingSubscription
                  ? "Set the wall clock and tool allowance. The native client manages its own turns and tokens."
                  : "These limits are saved with the run."}</p>
            </div>
            {track === "unaided" ? (
              usingSubscription ? (
                <div className="budget-values">
                  <span><strong>{unaidedBudget.wall_seconds}s</strong><small>fixed wall</small></span>
                  <span><strong>{selectedCount}</strong><small>client sessions</small></span>
                  <span><strong>{currentSubscription.max_tool_calls}</strong><small>tool calls</small></span>
                  <span><strong>{currentSubscription.effort}</strong><small>effort</small></span>
                </div>
              ) : (
                <div className="budget-values">
                  <span><strong>{unaidedBudget.wall_seconds}s</strong><small>wall</small></span>
                  <span><strong>{selectedCount || unaidedBudget.max_generations}</strong><small>generations</small></span>
                  <span><strong>{unaidedBudget.max_output_tokens.toLocaleString()}</strong><small>output tokens</small></span>
                  <span><strong>{unaidedBudget.max_thinking_tokens.toLocaleString()}</strong><small>thinking tokens</small></span>
                </div>
              )
            ) : usingSubscription ? (
              <div className="budget-editor">
                <label><span>Wall seconds</span><input className="tracks-input" type="number" min="1" max={7 * 86400} step="1" value={frontierBudget.wall_seconds} onChange={(event) => updateFrontierBudget("wall_seconds", event.target.value)} /></label>
                <label><span>Tool calls</span><input className="tracks-input" type="number" min="0" max="10000" step="1" value={frontierMaxToolCalls} onChange={(event) => updateFrontierToolCalls(event.target.value)} /></label>
              </div>
            ) : (
              <div className="budget-editor">
                <label><span>Wall seconds</span><input className="tracks-input" type="number" min="1" max={7 * 86400} step="1" value={frontierBudget.wall_seconds} onChange={(event) => updateFrontierBudget("wall_seconds", event.target.value)} /></label>
                <label><span>Generations</span><input className="tracks-input" type="number" min="1" max="100000" step="1" value={frontierBudget.max_generations} onChange={(event) => updateFrontierBudget("max_generations", event.target.value)} /></label>
                <label><span>Output tokens</span><input className="tracks-input" type="number" min="1" max="1000000" step="1" value={frontierBudget.max_output_tokens} onChange={(event) => updateFrontierBudget("max_output_tokens", event.target.value)} /></label>
                <label><span>Thinking tokens</span><input className="tracks-input" type="number" min="0" max="1000000" step="1" value={frontierBudget.max_thinking_tokens} onChange={(event) => updateFrontierBudget("max_thinking_tokens", event.target.value)} /></label>
              </div>
            )}
          </div>

          <div className="tracks-actions">
            <button type="button" className="primary-action" disabled={!canSubmit} onClick={() => { void activeAction(); }}>
              {submitting ? "Starting…" : actionLabel}
            </button>
            <span className="action-hint">{track === "unaided"
              ? usingSubscription ? "One fresh session per theorem; no tools or verifier feedback." : "Fixture rehearsal keeps the one-request-per-theorem boundary."
              : usingSubscription ? "Native client turns are opaque; this run records the configured wall and tool allowance." : "The run uses one shared time and request limit."}</span>
          </div>
        </div>

        <div className="tracks-status-column">
          <section className="status-card">
            <div className="section-heading">
              <div><p className="tracks-eyebrow">Run status</p><h3>{status ? status.runId.slice(0, 12) : "No active track run"}</h3></div>
                {status && <span className={`run-state run-state--${status.state}`}>{stateLabel(status.state)}</span>}
            </div>
            {!status && <p className="muted-copy">Start a track run to see its progress and verified results here.</p>}
            {status && (
              <>
                <div className="status-progress"><div className="status-progress-bar"><span style={{ width: `${status.total ? Math.min(100, (status.completed / status.total) * 100) : status.state === "complete" ? 100 : 0}%` }} /></div><span>{status.completed}/{status.total || "?"} items</span></div>
                <div className="status-facts"><span><small>Track</small>{status.track}</span><span><small>Start</small>{status.mode}</span><span><small>{statusUsesSubscription ? "Client sessions used" : "Requests"}</small>{statusUsesSubscription ? formatClientSessions(status.client_sessions ?? status.report?.client_sessions) : formatGenerations(status.generations)}</span>{statusUsesSubscription && <><span><small>Tool calls used</small>{formatToolCalls(status.tool_calls)}</span><span><small>Tool calls allowed</small>{status.subscription?.max_tool_calls ?? "Unknown"}</span><span><small>Native effort</small>{status.subscription?.effort ?? "Unknown"}</span><span><small>Wall limit</small>{typeof status.budget?.wall_seconds === "number" ? `${status.budget.wall_seconds.toLocaleString()}s` : "Unknown"}</span></>}</div>
                {status.error && <div className="inline-error">{status.error}</div>}
                {status.handoff && (
                  <div className="handoff-panel">
                    <strong>Owner handoff ready</strong>
                    <p>{status.handoff.note}</p>
                    <small>{status.handoff.requirement}</small>
                    <code>{status.handoff.handoff_command}</code>
                    <code>{status.handoff.bridge_command}</code>
                    <code>{status.handoff.submit_command}</code>
                    {status.handoff.mcp_server.env?.PROPBENCH_DOCKER_HOST && <small>Runtime socket: {status.handoff.mcp_server.env.PROPBENCH_DOCKER_HOST}</small>}
                    <small>Bundle: {status.handoff.bundle_dir}</small>
                  </div>
                )}
                {status.report && <button type="button" className="secondary-action" onClick={() => setSelectedReport(status.report)}>View result details</button>}
              </>
            )}
          </section>

          {selectedReport && (
            <section className="result-card">
              <div className="section-heading"><div><p className="tracks-eyebrow">Run result</p><h3>{selectedReport.config.model}</h3><small className="field-help">{providerLabel(selectedReport.config.provider)}</small></div><button type="button" className="tracks-link-button" onClick={() => setSelectedReport(null)}>Close</button></div>
              <div className="result-metrics"><span><strong>{selectedReport.evaluation_status === "complete" ? formatNumber(selectedReport.score, 4) : "Unranked"}</strong><small>score · lower is better</small></span><span><strong>{selectedReport.valid_count}/{selectedReport.total}</strong><small>valid proofs</small></span><span><strong>{selectedReport.total_lines}</strong><small>valid lines</small></span><span><strong>{evidenceLabel(selectedReport.evidence)}</strong><small>evidence</small></span><span><strong>{formatEvaluationStatus(selectedReport.evaluation_status)}</strong><small>run status</small></span><span><strong>{selectedReport.execution_protocol ?? selectedReport.config.execution_protocol ?? "Unknown"}</strong><small>run protocol</small></span><span><strong>{formatActualModel(selectedReport)}</strong><small>returned model</small></span><span><strong>{formatReturned(selectedReport.returned_backends, "Unavailable")}</strong><small>returned backend</small></span>{reportUsesSubscription(selectedReport) && <><span><strong>{selectedReport.config.budget.wall_seconds.toLocaleString()}s</strong><small>wall limit</small></span><span><strong>{selectedReport.client_sessions ?? "Unknown"}</strong><small>client sessions used</small></span><span><strong>{selectedReport.tool_calls ?? "Unknown"}</strong><small>tool calls used</small></span><span><strong>{selectedReport.config.subscription?.effort ?? "Unknown"}</strong><small>native effort</small></span><span><strong>{selectedReport.config.subscription?.max_tool_calls ?? "Unknown"}</strong><small>tool calls allowed</small></span></>}</div>
              <p className="usage-line">{formatReportActivity(selectedReport)}</p>
              {selectedReport.evaluation_status === "interrupted" && <p className="field-help">This run is excluded from rankings. {selectedReport.items.flatMap(item => item.errors ?? []).slice(0, 1).join(" ")}</p>}
              {selectedReport.runtime && <p className="usage-line" title={selectedReport.runtime.image_id}>Runtime: {selectedReport.runtime.backend} · {selectedReport.runtime.architecture} · {selectedReport.runtime.image_id.slice(0, 19)}</p>}
              <div className="result-table-wrap"><table className="tracks-table"><thead><tr><th>Item</th><th>Status</th><th>Lines</th><th>Loss</th></tr></thead><tbody>{selectedReport.items.map((item) => <tr key={item.id}><td>{item.id}</td><td><span className={`outcome outcome--${item.status}`}>{item.status}</span></td><td>{item.line_count ?? "—"}</td><td>{formatNumber(item.loss, 4)}</td></tr>)}</tbody></table></div>
            </section>
          )}
        </div>
      </section>

      <section className="leaderboards-section">
        <div className="section-heading"><div><p className="tracks-eyebrow">Comparable results</p><h3>Track rankings</h3></div><button type="button" className="secondary-action" onClick={() => { void refreshReports().catch((reason: unknown) => setError(errorText(reason))); }}>Refresh</button></div>
        <p className="muted-copy">Only completed runs with matching sets, limits, history, and evidence are ranked together.</p>
        {leaderboards.length === 0 && <div className="empty-panel">No track reports yet. Fixture rehearsal is available for a deterministic first run.</div>}
        <div className="leaderboard-grid">
          {leaderboards.map((group) => (
            <article className="cohort-card" key={group.cohort}>
              <div className="cohort-heading"><div><span className="cohort-track">{group.track ?? "unknown"} · {group.mode ?? "unknown"}{group.provider ? ` · ${providerLabel(group.provider as Provider)}` : ""}</span><h4>{group.set_version ?? "Unknown set"}</h4></div><code>{group.cohort.slice(0, 12)}</code></div>
              <div className="cohort-meta"><span>{group.entries.length} run{group.entries.length === 1 ? "" : "s"}</span><span>{leaderboardUsesSubscription(group) ? formatSubscriptionCohort(group) : group.budget ? `${group.budget.max_output_tokens.toLocaleString()} output tokens` : "Unknown budget"}</span><span>lower loss wins</span></div>
              <div className="result-table-wrap"><table className="tracks-table"><thead><tr><th>#</th><th>Model</th><th>Loss</th><th>Valid</th><th>Evidence</th></tr></thead><tbody>{group.entries.map((entry) => <tr key={`${group.cohort}-${entry.run_id ?? entry.rank}`}><td>{entry.rank}</td><td><button type="button" className="table-link" onClick={() => { const report = reports.find((candidate) => candidate.config.run_id === entry.run_id); if (report) setSelectedReport(report); }}>{entry.model}</button></td><td>{formatNumber(entry.score, 4)}</td><td>{entry.valid_count}/{entry.total} · {formatRate(entry.valid_rate)}</td><td><span className="evidence-label">{evidenceLabel(entry.evidence)}</span><small className="usage-cell">{formatUsage(entry.usage)}</small></td></tr>)}</tbody></table></div>
            </article>
          ))}
        </div>
      </section>

      <section className="report-list-section">
        <div className="section-heading"><div><p className="tracks-eyebrow">History</p><h3>Track reports</h3></div></div>
        {reports.length === 0 ? <p className="muted-copy">Completed reports will appear here with explicit fixture, subscription, provider, or external evidence labels.</p> : <div className="report-list">{reports.map((report) => <button type="button" className="report-row" key={report.config.run_id} onClick={() => setSelectedReport(report)}><span className="report-run">{report.config.run_id.slice(0, 12)}</span><span>{report.config.track} · {report.config.mode}</span><span>{formatActualModel(report) === "Unknown" ? report.config.model : formatActualModel(report)}</span><strong>{report.evaluation_status === "complete" ? formatNumber(report.score, 4) : formatEvaluationStatus(report.evaluation_status)}</strong><span>{evidenceLabel(report.evidence)}</span></button>)}</div>}
      </section>
    </div>
  );
}
