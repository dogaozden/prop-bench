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
const EDITORIAL_LIMITATIONS = {
  "f5718b6e-dc3e-4219-b823-cd62cb98023c": {
    title: "Editorial limitation · submission capture",
    body: "In this campaign, an extra draft JSON file in a proof folder caused the frozen harness to reject canonical submissions. Affected published verdicts remain missing (loss 1). This is a submission-capture failure, not evidence that the model could not construct a valid proof.",
    href: "https://github.com/dogaozden/prop-bench/blob/master/research/SUBMISSION-FAILURE.md"
  }
};

export function editorialLimitation(campaign) {
  return campaign && Object.hasOwn(EDITORIAL_LIMITATIONS, campaign.id) ? EDITORIAL_LIMITATIONS[campaign.id] : null;
}

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
function nonnegativeInteger(value, label) {
  const number = finite(value, label);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${label} must be a nonnegative integer`);
  return number;
}
function proofLines(value, label) {
  return array(value, label).map((line, index) => {
    const step = object(line, `${label}[${index}]`);
    return { line_number: nonnegativeInteger(step.line_number, "line_number"), formula: string(step.formula, "formula"),
      justification: string(step.justification, "justification"), depth: nonnegativeInteger(step.depth, "depth") };
  });
}
function publicProofPath(value, label, checkpoint = false) {
  const file = string(value, label);
  const segment = "[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}";
  const pattern = checkpoint
    ? new RegExp(`^proofs/${segment}/checkpoints/${segment}\\.json$`)
    : new RegExp(`^proofs/${segment}/${segment}\\.json$`);
  if (!pattern.test(file)) throw new Error(`unsafe public proof path: ${file}`);
  return file;
}

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
    if (new Set(jobs.map(job => `${job.condition}\u0000${job.item_id}`)).size !== jobs.length) throw new Error("Campaign repeats a planned theorem in a condition");
    if (finite(value.planned_jobs, "campaign.planned_jobs") !== jobs.length) throw new Error("Campaign planned job count disagrees with its job list");
    const client = value.client == null ? null : object(value.client, "campaign.client");
    return { id: string(value.id, "campaign.id"), model: string(value.model, "campaign.model"), effort: string(value.effort, "campaign.effort"),
      status: string(value.status, "campaign.status"), planned_jobs: finite(value.planned_jobs, "campaign.planned_jobs"),
      created_at: optionalString(value.created_at, "campaign.created_at"),
      client: client ? { version: optionalString(client.version, "campaign.client.version"), sha256: optionalString(client.sha256, "campaign.client.sha256") } : null,
      evaluator_hash: optionalString(value.evaluator_hash, "campaign.evaluator_hash"),
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
    const selectedIds = array(run.selected_ids, `${id}.selected_ids`).map(itemId => string(itemId, "selected ID"));
    const improvements = run.improvements == null ? [] : array(run.improvements, `${id}.improvements`).map((entry, j) => {
      if (track !== "frontier") throw new Error(`${id} has Frontier checkpoints on another track`);
      const event = object(entry, `${id}.improvements[${j}]`);
      const itemId = string(event.item_id, "improvement.item_id");
      if (!itemIds.has(itemId) || !selectedIds.includes(itemId)) throw new Error(`${id} checkpoint names an unselected theorem`);
      const importId = string(event.import_id, "improvement.import_id");
      const checkpointId = string(event.checkpoint_id, "improvement.checkpoint_id");
      if (!/^\d{6}$/.test(importId) || !/^\d{6}$/.test(checkpointId)) throw new Error(`${id} has malformed checkpoint identity`);
      const lineCount = nonnegativeInteger(event.line_count, "improvement.line_count");
      const previous = event.previous_line_count == null ? null : nonnegativeInteger(event.previous_line_count, "improvement.previous_line_count");
      if (previous !== null && lineCount >= previous) throw new Error(`${id} checkpoint is not a strict line reduction`);
      const proof = proofLines(event.proof, "improvement.proof");
      if (proof.length !== lineCount) throw new Error(`${id} checkpoint proof length disagrees with verified count`);
      const proofFile = publicProofPath(event.proof_file, "improvement.proof_file", true);
      if (proofFile !== `proofs/${id}/checkpoints/${itemId}-${importId}.json`) throw new Error(`${id} checkpoint proof path disagrees with its identity`);
      return { item_id: itemId, import_id: importId, checkpoint_id: checkpointId,
        execution_command: nonnegativeInteger(event.execution_command, "improvement.execution_command"),
        captured_elapsed_seconds: finite(event.captured_elapsed_seconds, "improvement.captured_elapsed_seconds"),
        line_count: lineCount, previous_line_count: previous,
        proof, proof_sha256: string(event.proof_sha256, "improvement.proof_sha256"),
        proof_bytes_sha256: string(event.proof_bytes_sha256, "improvement.proof_bytes_sha256"),
        proof_file: proofFile,
        independently_replayed: event.independently_replayed === true };
    });
    const seenImports = new Set();
    const priorByItem = new Map();
    for (const event of improvements) {
      if (event.captured_elapsed_seconds < 0 || event.captured_elapsed_seconds > budget.wall_seconds) throw new Error(`${id} checkpoint capture exceeds run allowance`);
      const key = `${event.item_id}\u0000${event.import_id}`;
      if (seenImports.has(key)) throw new Error(`${id} repeats an accepted checkpoint import`);
      seenImports.add(key);
      const prior = priorByItem.get(event.item_id);
      if (prior && (event.captured_elapsed_seconds < prior.captured_elapsed_seconds || event.execution_command < prior.execution_command || event.previous_line_count !== prior.line_count))
        throw new Error(`${id} checkpoint sequence is inconsistent`);
      priorByItem.set(event.item_id, event);
    }
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
      selected_ids: selectedIds,
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
      regraded_by: optionalString(run.regraded_by, "regraded_by"),
      validator_sha256: optionalString(run.validator_sha256, "validator_sha256"),
      rulebook_sha256: optionalString(run.rulebook_sha256, "rulebook_sha256"),
      tool_counts: run.tool_counts == null ? null : (() => { const counts = object(run.tool_counts, "tool_counts"); return { exec: counts.exec == null ? 0 : finite(counts.exec, "tool_counts.exec"), delegate: counts.delegate == null ? 0 : finite(counts.delegate, "tool_counts.delegate") }; })(),
      runtime: run.runtime == null ? null : (() => { const runtime = object(run.runtime, "runtime"); return { backend: optionalString(runtime.backend, "runtime.backend"), image_id: optionalString(runtime.image_id, "runtime.image_id"), architecture: optionalString(runtime.architecture, "runtime.architecture") }; })(),
      improvements,
      items: rawItems.map((rawItem, j) => {
        const result = object(rawItem, `${id}.items[${j}]`);
        const itemId = string(result.id, `${id}.items[${j}].id`);
        if (!itemIds.has(itemId)) throw new Error(`${id} contains unknown item ${itemId}`);
        const publicItem = items.find(item => item.id === itemId);
        const status = string(result.status, `${id}.items[${j}].status`);
        if (!OUTCOMES.has(status)) throw new Error(`${id} contains unknown status ${status}`);
        const lineCount = result.line_count == null ? null : finite(result.line_count, "line_count");
        if (status === "valid" && (!Number.isInteger(lineCount) || lineCount < 0)) throw new Error(`${id} has valid item without a verified line count`);
        const par = finite(result.par, "par");
        if (par <= 0 || par !== publicItem.par) throw new Error(`${id} has an item par inconsistent with the frozen set`);
        const loss = finite(result.loss, "loss");
        const expectedLoss = status === "valid" ? lineCount / (lineCount + par) : 1;
        if (Math.abs(loss - expectedLoss) > 1e-8) throw new Error(`${id} has a loss inconsistent with the published scoring rule`);
        const proof = result.proof == null ? null : proofLines(result.proof, "proof");
        if (proof && status !== "valid") throw new Error(`${id} includes proof lines for a non-valid item`);
        if (proof && proof.length !== lineCount) throw new Error(`${id} proof length disagrees with verified line count`);
        const proofFile = result.proof_file == null ? null : publicProofPath(result.proof_file, "proof_file");
        return { id: itemId, status, line_count: lineCount, par, loss, proof,
          proof_sha256: optionalString(result.proof_sha256, "proof_sha256"), proof_bytes_sha256: optionalString(result.proof_bytes_sha256, "proof_bytes_sha256"),
          proof_file: proofFile, independently_replayed: result.independently_replayed === true };
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
    if (group.jobs.length && group.runs.some(run => run.evidence !== "subscription" || run.provider !== "codex-subscription" ||
      !(track === "unaided" ? run.execution_protocol === "unaided-subscription-v1" :
        ["frontier-subscription-v1", "frontier-subscription-v2"].includes(run.execution_protocol))))
      throw new Error(`Campaign group ${group.key} has non-subscription evidence or protocol`);
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

export const MATCHED_CONDITIONS = ["unaided-1", "unaided-2", "frontier-fresh", "frontier-cumulative"];

/** A campaign-only view of each planned theorem; interrupted records stay inspectable but unscored. */
export function matchedLedger(data, groups) {
  if (!data.campaign) return null;
  const byCondition = new Map(groups.filter(group => group.campaign_id === data.campaign.id && group.campaign_condition)
    .map(group => [group.campaign_condition, group]));
  const columns = MATCHED_CONDITIONS.map(condition => {
    const group = byCondition.get(condition);
    return { condition, group, completed: group?.scoredRecords.length ?? 0, planned: group?.jobs.length ?? 0 };
  });
  const rows = data.items.map(item => ({ item, cells: columns.map(column => {
    const group = column.group;
    const job = group?.jobs.find(candidate => candidate.item_id === item.id);
    const record = group?.records.find(candidate => candidate.result.id === item.id);
    if (record && group.scoredRecords.includes(record)) {
      if (record.result.status === "valid") return { kind: "valid", label: `${record.result.line_count} ${record.result.line_count === 1 ? "line" : "lines"}`, record, group };
      return { kind: "nonvalid", label: record.result.status.replaceAll("_", " "), record, group };
    }
    if (job?.status === "interrupted" || record?.run.evaluation_status === "interrupted")
      return { kind: "interrupted", label: "Interrupted", record, group };
    if (record) return { kind: "incomplete", label: "Incomplete record", record, group };
    if (job?.status === "complete") return { kind: "awaiting", label: "Awaiting export", record: null, group };
    if (["running", "preparing", "prepared"].includes(job?.status)) return { kind: "active", label: "Active", record: null, group };
    return { kind: job ? "pending" : "unplanned", label: job ? "Pending" : "Not planned", record: null, group };
  }) }));
  return { columns, rows };
}

/** Descriptive counts only; every compared cell is a completed, valid campaign verdict. */
export function summarizeMatchedEvidence(ledger) {
  if (!ledger) return null;
  const total = ledger.rows.length;
  const fresh = { matched: 0, unavailable: 0, shorterThanBoth: 0, withinUnaidedRange: 0, longerThanBoth: 0 };
  const cumulative = { matched: 0, unavailable: 0, shorter: 0, tied: 0, longer: 0 };
  for (const row of ledger.rows) {
    const [u1, u2, frontierFresh, frontierCumulative] = row.cells;
    if ([u1, u2, frontierFresh].every(cell => cell.kind === "valid")) {
      fresh.matched++;
      const a = u1.record.result.line_count, b = u2.record.result.line_count, f = frontierFresh.record.result.line_count;
      if (f < Math.min(a, b)) fresh.shorterThanBoth++;
      else if (f > Math.max(a, b)) fresh.longerThanBoth++;
      else fresh.withinUnaidedRange++;
    } else fresh.unavailable++;
    if ([frontierFresh, frontierCumulative].every(cell => cell.kind === "valid")) {
      cumulative.matched++;
      const f = frontierFresh.record.result.line_count, c = frontierCumulative.record.result.line_count;
      if (c < f) cumulative.shorter++;
      else if (c > f) cumulative.longer++;
      else cumulative.tied++;
    } else cumulative.unavailable++;
  }
  return { total, fresh, cumulative };
}
