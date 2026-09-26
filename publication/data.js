// The public viewer deliberately reads an allowlisted export, not owner run files.
export const PUBLICATION_SCHEMA = "propbench-publication-v1";
const OUTCOMES = new Set(["valid", "invalid", "parse_error", "transport_error", "protocol_error", "missing", "interrupted"]);
const JOB_STATUSES = new Set(["pending", "queued", "preparing", "prepared", "running", "complete", "interrupted"]);
const CAMPAIGN_CONDITIONS = {
  "unaided-1": { track: "unaided", mode: "unaided" },
  "unaided-2": { track: "unaided", mode: "unaided" },
  "frontier-fresh": { track: "frontier", mode: "fresh" },
  "frontier-cumulative": { track: "frontier", mode: "cumulative" }
};

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function string(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}
function optionalString(value, label) { return value == null ? null : string(value, label); }
function array(value, label) { if (!Array.isArray(value)) throw new Error(`${label} must be an array`); return value; }
function finite(value, label) { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`); return value; }

export function parsePublication(raw) {
  const source = object(raw, "publication");
  if (source.schema_version !== PUBLICATION_SCHEMA) throw new Error(`Unsupported publication schema: ${String(source.schema_version)}`);
  const set = object(source.set, "set");
  const evaluator = object(source.evaluator, "evaluator");
  const items = array(source.items, "items").map((entry, index) => {
    const item = object(entry, `items[${index}]`);
    const theorem = object(item.theorem, `items[${index}].theorem`);
    const id = string(item.id, `items[${index}].id`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id)) throw new Error(`Unsafe published item ID: ${id}`);
    return {
      id,
      par: finite(item.par, `items[${index}].par`),
      theorem_sha256: optionalString(item.theorem_sha256, "theorem_sha256"),
      theorem: {
        premises: array(theorem.premises, "premises").map(p => string(p, "premise")),
        conclusion: string(theorem.conclusion, "conclusion"),
        difficulty: optionalString(theorem.difficulty, "difficulty")
      }
    };
  });
  const itemIds = new Set(items.map(item => item.id));
  if (itemIds.size !== items.length) throw new Error("Published item IDs must be unique");
  const campaign = source.campaign == null ? null : (() => {
    const value = object(source.campaign, "campaign");
    const jobs = array(value.jobs, "campaign.jobs").map((entry, index) => {
      const job = object(entry, `campaign.jobs[${index}]`);
      const status = string(job.status, "job.status");
      if (!JOB_STATUSES.has(status)) throw new Error(`Unsupported campaign job status: ${status}`);
      const condition = string(job.condition, "job.condition");
      if (!CAMPAIGN_CONDITIONS[condition]) throw new Error(`Unsupported campaign condition: ${condition}`);
      const item_id = string(job.item_id, "job.item_id");
      if (!itemIds.has(item_id)) throw new Error(`Campaign job contains unknown item ${item_id}`);
      return { key: string(job.key, "job.key"), item_id, condition, status,
        wall_seconds: finite(job.wall_seconds, "job.wall_seconds"), max_tool_calls: finite(job.max_tool_calls, "job.max_tool_calls"),
        run_id: optionalString(job.run_id, "job.run_id") };
    });
    if (new Set(jobs.map(job => job.key)).size !== jobs.length) throw new Error("Campaign job keys must be unique");
    return { id: string(value.id, "campaign.id"), model: string(value.model, "campaign.model"), effort: string(value.effort, "campaign.effort"),
      status: string(value.status, "campaign.status"), planned_jobs: finite(value.planned_jobs, "campaign.planned_jobs"),
      source_commit: optionalString(value.source_commit, "campaign.source_commit"), jobs };
  })();
  const runs = array(source.runs, "runs").map((entry, index) => {
    const run = object(entry, `runs[${index}]`);
    const id = string(run.id, `runs[${index}].id`);
    const track = string(run.track, `runs[${index}].track`);
    const mode = string(run.mode, `runs[${index}].mode`);
    if (!["frontier", "unaided"].includes(track)) throw new Error(`Unsupported track in ${id}`);
    if (!["fresh", "cumulative", "unaided"].includes(mode)) throw new Error(`Unsupported mode in ${id}`);
    if ((track === "unaided") !== (mode === "unaided")) throw new Error(`Track/mode mismatch in ${id}`);
    const budget = object(run.budget, `${id}.budget`);
    const subscription = run.subscription == null ? null : object(run.subscription, `${id}.subscription`);
    const rawItems = array(run.items, `${id}.items`);
    return {
      id, track, mode,
      label: optionalString(run.label, `${id}.label`),
      campaign_id: optionalString(run.campaign_id, `${id}.campaign_id`),
      campaign_condition: optionalString(run.campaign_condition, `${id}.campaign_condition`),
      campaign_target_count: run.campaign_target_count == null ? null : finite(run.campaign_target_count, `${id}.campaign_target_count`),
      model: string(run.model, `${id}.model`),
      returned_models: run.returned_models == null ? [] : array(run.returned_models, `${id}.returned_models`).map(model => string(model, "returned model")),
      observed_models: run.observed_models == null ? [] : array(run.observed_models, `${id}.observed_models`).map(model => string(model, "observed model")),
      provider: string(run.provider, `${id}.provider`),
      execution_protocol: string(run.execution_protocol, `${id}.execution_protocol`),
      evidence: string(run.evidence, `${id}.evidence`),
      evaluation_status: string(run.evaluation_status, `${id}.evaluation_status`),
      graded_at: optionalString(run.graded_at, `${id}.graded_at`),
      completed_at: optionalString(run.completed_at, `${id}.completed_at`),
      cohort: optionalString(run.cohort, `${id}.cohort`),
      outcome: optionalString(run.outcome, `${id}.outcome`),
      starting_snapshot: optionalString(run.starting_snapshot, `${id}.starting_snapshot`),
      seed_run_id: optionalString(run.seed_run_id, `${id}.seed_run_id`),
      selected_ids: array(run.selected_ids, `${id}.selected_ids`).map(id => string(id, "selected ID")),
      budget: { wall_seconds: finite(budget.wall_seconds, `${id}.budget.wall_seconds`), max_tool_calls: budget.max_tool_calls == null ? null : finite(budget.max_tool_calls, "max_tool_calls") },
      subscription: subscription ? { effort: optionalString(subscription.effort, "effort"), max_tool_calls: subscription.max_tool_calls == null ? null : finite(subscription.max_tool_calls, "max_tool_calls") } : null,
      score: run.score == null ? null : finite(run.score, `${id}.score`),
      usage_coverage: run.usage_coverage == null ? null : {
        attempts_with_usage: finite(object(run.usage_coverage, "usage_coverage").attempts_with_usage, "attempts_with_usage"),
        attempts: finite(run.usage_coverage.attempts, "attempts")
      },
      client_sessions: run.client_sessions == null ? null : finite(run.client_sessions, "client_sessions"),
      elapsed_seconds: run.elapsed_seconds == null ? null : finite(run.elapsed_seconds, "elapsed_seconds"),
      evaluator_hash: optionalString(run.evaluator_hash, "evaluator_hash"),
      validator_sha256: optionalString(run.validator_sha256, "validator_sha256"),
      rulebook_sha256: optionalString(run.rulebook_sha256, "rulebook_sha256"),
      items: rawItems.map((rawItem, j) => {
        const result = object(rawItem, `${id}.items[${j}]`);
        const itemId = string(result.id, `${id}.items[${j}].id`);
        if (!itemIds.has(itemId)) throw new Error(`${id} contains unknown item ${itemId}`);
        const status = string(result.status, `${id}.items[${j}].status`);
        if (!OUTCOMES.has(status)) throw new Error(`${id} contains unknown status ${status}`);
        const lineCount = result.line_count == null ? null : finite(result.line_count, "line_count");
        if (status === "valid" && (!Number.isInteger(lineCount) || lineCount < 0)) throw new Error(`${id} has valid item without a verified line count`);
        const proof = result.proof == null ? null : array(result.proof, "proof").map((line, k) => {
          const step = object(line, `${id}.proof[${k}]`);
          return { line_number: finite(step.line_number, "line_number"), formula: string(step.formula, "formula"), justification: string(step.justification, "justification"), depth: finite(step.depth, "depth") };
        });
        if (proof && status !== "valid") throw new Error(`${id} includes proof lines for a non-valid item`);
        if (proof && proof.length !== lineCount) throw new Error(`${id} proof length disagrees with verified line count`);
        return { id: itemId, status, line_count: lineCount, par: finite(result.par, "par"), loss: finite(result.loss, "loss"), proof,
          proof_sha256: optionalString(result.proof_sha256, "proof_sha256"), independently_replayed: result.independently_replayed === true };
      })
    };
  });
  if (new Set(runs.map(run => run.id)).size !== runs.length) throw new Error("Published run IDs must be unique");
  return {
    schema_version: source.schema_version,
    generated_at: string(source.generated_at, "generated_at"),
    set: { version: string(set.version, "set.version"), hash: string(set.hash, "set.hash"), core_tag: string(set.core_tag, "set.core_tag") },
    evaluator: { scorer_version: string(evaluator.scorer_version, "scorer_version"), rulebook_sha256: optionalString(evaluator.rulebook_sha256, "rulebook_sha256"), validator_sha256: optionalString(evaluator.validator_sha256, "validator_sha256") },
    campaign, items, runs
  };
}

export function groupRuns(data) {
  const groups = new Map();
  const jobByRun = new Map();
  if (data.campaign) for (const job of data.campaign.jobs) {
    const key = `${data.campaign.id}\u0000${job.condition}`;
    if (!groups.has(key)) groups.set(key, { key, campaign_id: data.campaign.id, campaign_condition: job.condition, jobs: [], runs: [], records: [] });
    groups.get(key).jobs.push(job);
    if (job.run_id) {
      if (jobByRun.has(job.run_id)) throw new Error(`Campaign repeats run ${job.run_id}`);
      jobByRun.set(job.run_id, job);
    }
  }
  for (const run of data.runs) {
    const key = run.campaign_id && run.campaign_condition ? `${run.campaign_id}\u0000${run.campaign_condition}` : `run\u0000${run.id}`;
    if (data.campaign && run.campaign_id === data.campaign.id && !groups.has(key)) throw new Error(`Published run ${run.id} has no planned condition`);
    if (!groups.has(key)) groups.set(key, { key, campaign_id: run.campaign_id, campaign_condition: run.campaign_condition, jobs: [], runs: [], records: [] });
    const group = groups.get(key);
    const job = data.campaign && run.campaign_id === data.campaign.id ? jobByRun.get(run.id) : null;
    if (data.campaign && run.campaign_id === data.campaign.id && (!job || job.condition !== run.campaign_condition)) throw new Error(`Published run ${run.id} does not match a campaign job`);
    group.runs.push(run);
    for (const result of run.items) {
      if (job && (result.id !== job.item_id || run.budget.wall_seconds !== job.wall_seconds || run.subscription?.max_tool_calls !== job.max_tool_calls)) throw new Error(`Published run ${run.id} differs from its planned item or budget`);
      group.records.push({ result, run, job, item: data.items.find(item => item.id === result.id) });
    }
  }
  return [...groups.values()].map(group => {
    const first = group.runs[0];
    const plannedCondition = group.campaign_condition ? CAMPAIGN_CONDITIONS[group.campaign_condition] : null;
    const track = first?.track ?? plannedCondition?.track;
    const mode = first?.mode ?? plannedCondition?.mode;
    if (!track || !mode) throw new Error(`Campaign group ${group.key} has no track condition`);
    if (group.runs.some(run => run.track !== track || run.mode !== mode)) throw new Error(`Campaign group ${group.key} mixes track conditions`);
    if (plannedCondition && (track !== plannedCondition.track || mode !== plannedCondition.mode)) throw new Error(`Campaign group ${group.key} contradicts its planned track`);
    const signature = run => [run.model, run.provider, run.execution_protocol, run.subscription?.effort ?? "", run.budget.wall_seconds, run.subscription?.max_tool_calls ?? "", run.evidence].join("\u0000");
    if (group.runs.some(run => signature(run) !== signature(first))) throw new Error(`Campaign group ${group.key} mixes models, budgets, protocols, or evidence`);
    if (group.jobs.length && (new Set(group.jobs.map(job => `${job.wall_seconds}/${job.max_tool_calls}`)).size !== 1)) throw new Error(`Campaign group ${group.key} has mismatched planned budgets`);
    if (new Set(group.records.map(record => record.result.id)).size !== group.records.length) throw new Error(`Campaign group ${group.key} repeats a theorem`);
    const target = group.jobs.length || first?.campaign_target_count || data.items.length;
    const observed = new Set(group.records.map(record => record.result.id)).size;
    const official = first?.evidence === "subscription" || (!first && group.jobs.length > 0);
    const scoredRecords = group.records.filter(record => official && record.run.evidence === "subscription" && record.run.evaluation_status === "complete" &&
      (!record.run.outcome || record.run.outcome === "completed") && (!record.job || record.job.status === "complete"));
    const valid = scoredRecords.filter(record => record.result.status === "valid").length;
    const meanCompletedLoss = scoredRecords.length ? scoredRecords.reduce((sum, record) => sum + record.result.loss, 0) / scoredRecords.length : null;
    const jobCounts = { complete: 0, interrupted: 0, active: 0, pending: 0 };
    if (group.jobs.length) for (const job of group.jobs) {
      const bucket = job.status === "complete" ? "complete" : job.status === "interrupted" ? "interrupted" :
        ["running", "preparing", "prepared"].includes(job.status) ? "active" : "pending";
      jobCounts[bucket]++;
    }
    else for (const run of group.runs) jobCounts[run.evaluation_status === "complete" && (!run.outcome || run.outcome === "completed") ? "complete" : "interrupted"]++;
    const models = group.runs.length ? [...new Set(group.runs.map(run => run.model))] : data.campaign && group.campaign_id === data.campaign.id ? [data.campaign.model] : [];
    const efforts = group.runs.length ? [...new Set(group.runs.map(run => run.subscription?.effort).filter(Boolean))] : data.campaign && group.campaign_id === data.campaign.id ? [data.campaign.effort] : [];
    return { ...group, track, mode, target, observed, valid, scoredRecords, meanCompletedLoss, jobCounts, official,
      label: group.campaign_condition ? group.campaign_condition.replaceAll("-", " ") : first.label || `${track} / ${mode}`,
      models, efforts,
      providers: [...new Set(group.runs.map(run => run.provider))],
      evidence: [...new Set(group.runs.map(run => run.evidence))],
      protocols: [...new Set(group.runs.map(run => run.execution_protocol))],
      budgets: group.jobs.length ? [...new Set(group.jobs.map(job => `${job.wall_seconds}s / ${job.max_tool_calls} calls`))] :
        [...new Set(group.runs.map(run => `${run.budget.wall_seconds}s${run.subscription?.max_tool_calls == null ? "" : ` / ${run.subscription.max_tool_calls} calls`}`))]
    };
  });
}
