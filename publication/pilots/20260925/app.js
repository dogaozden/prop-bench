import { parsePublication, groupRuns } from "./data.js";

const workspace = document.querySelector("#results-workspace");
const stamp = document.querySelector("#data-stamp");
const provenance = document.querySelector("#footer-provenance");
const resources = document.querySelector("#resource-links");
const campaignSummary = document.querySelector("#campaign-summary");
const datasetDisclosure = document.querySelector("#dataset-disclosure");
const datasetView = document.querySelector("#dataset-view");
const datasetCount = document.querySelector("#dataset-count");
const state = { data: null, groups: [], filter: "all", groupKey: null, recordKey: null };

function el(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined && content !== null) element.textContent = String(content);
  return element;
}
function append(parent, ...children) { for (const child of children) if (child) parent.append(child); return parent; }
function pretty(value) { return value == null || value === "" ? "Not recorded" : String(value); }
function number(value, digits = 2) { return value == null ? "—" : value.toFixed(digits); }
function date(value) { if (!value) return "Date not recorded"; const d = new Date(value); return Number.isNaN(d.getTime()) ? value : new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(d); }
function title(value) { return String(value).replaceAll("_", " ").replace(/\b\w/g, char => char.toUpperCase()); }
function recordKey(record) { return `${record.run.id}\u0000${record.result.id}`; }
function joined(values) { return values.length === 1 ? values[0] : values.length ? "Varies by run" : "Not recorded"; }
function resource(label, url, external = false) { const link = el("a", "resource-link", label); link.href = url; if (external) link.rel = "noreferrer"; return link; }
function renderResources() {
  const links = [resource("Download results JSON ↗", "./data/results.json")];
  if (state.data.set.version !== "pending") {
    links.push(resource("Read frozen rulebook ↗", "./data/rules.md"));
    links.push(resource("Dataset manifest ↗", "./data/theorems/manifest.json"));
  }
  if (state.data.campaign) {
    links.push(resource("Download job ledger CSV ↗", "./data/jobs.csv"));
    links.push(resource("Summary JSON ↗", "./data/summary.json"));
  }
  const commit = state.data.campaign?.source_commit;
  const repository = "https://github.com/dogaozden/prop-bench";
  const pinned = commit && /^[a-f0-9]{40}$/.test(commit);
  links.push(resource("Method and protocol ↗", `${repository}/blob/${pinned ? commit : "master"}/TRACKS.md`, true));
  links.push(resource(pinned ? "Source at campaign commit ↗" : "Source repository ↗",
    pinned ? `${repository}/tree/${commit}` : repository, true));
  resources.replaceChildren(...links);
}
function renderCampaignSummary() {
  const campaign = state.data.campaign;
  campaignSummary.hidden = !campaign;
  if (!campaign) return;
  const counts = { complete: 0, interrupted: 0, active: 0, pending: 0 };
  for (const job of campaign.jobs) {
    const bucket = job.status === "complete" ? "complete" : job.status === "interrupted" ? "interrupted" :
      ["running", "preparing", "prepared"].includes(job.status) ? "active" : "pending";
    counts[bucket]++;
  }
  const heading = el("div", "campaign-summary-heading");
  append(heading, el("span", "micro-label", "CAMPAIGN SNAPSHOT"), el("span", "", `Exported ${date(state.data.generated_at)}`));
  const pairedPlan = campaign.jobs.length === state.data.items.length * 4 &&
    ["unaided-1", "unaided-2", "frontier-fresh", "frontier-cumulative"].every(condition => campaign.jobs.filter(job => job.condition === condition).length === state.data.items.length);
  const progress = el("p", "", `${campaign.planned_jobs} planned jobs · ${counts.complete} complete · ${counts.interrupted} interrupted · ${counts.active} active · ${counts.pending} pending. ${pairedPlan ? "Each theorem has two separate Unaided attempts and a fresh Frontier run paired with its own cumulative continuation. " : ""}This static export records one point in the campaign.`);
  const facts = el("div", "campaign-summary-facts");
  append(facts, fact("CAMPAIGN", campaign.id), fact("REQUESTED MODEL", campaign.model), fact("EFFORT", campaign.effort), fact("NATIVE CLIENT", campaign.client?.version || "Not recorded"));
  campaignSummary.replaceChildren(heading, progress, facts);
}
function renderDataset() {
  const items = state.data.items;
  datasetDisclosure.hidden = !items.length;
  if (!items.length) return;
  datasetCount.textContent = `${items.length} item${items.length === 1 ? "" : "s"}`;
  const list = el("div", "dataset-list");
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", "Frozen theorem list");
  const detail = el("article", "dataset-detail");
  const buttons = [];
  function select(item) {
    for (const button of buttons) button.setAttribute("aria-pressed", String(button.dataset.itemId === item.id));
    const box = el("div", "dataset-formulas");
    append(box, el("span", "meta-label", "PREMISES"));
    if (item.theorem.premises.length) for (const premise of item.theorem.premises) append(box, el("code", "", premise));
    else append(box, el("code", "", "None"));
    append(box, el("span", "meta-label", "CONCLUSION"), el("code", "", item.theorem.conclusion));
    const provenance = el("div", "dataset-provenance");
    append(provenance, el("span", "", `Theorem SHA-256: ${pretty(item.theorem_sha256)}`), resource("Open exact theorem JSON ↗", `./data/theorems/${encodeURIComponent(item.id)}.json`));
    detail.replaceChildren(el("span", "run-kicker", `${item.id} / ${item.theorem.difficulty || "THEOREM"}`),
      el("h4", "", "The question"), el("p", "dataset-par", `Reference par ${item.par} · a known achievable length, not a certified minimum`), box, provenance);
  }
  for (const item of items) {
    const button = el("button", "dataset-item");
    button.type = "button";
    button.dataset.itemId = item.id;
    button.setAttribute("aria-label", `View theorem ${item.id}, reference par ${item.par}`);
    append(button, el("span", "", item.id), el("span", "", `PAR ${item.par}`));
    button.addEventListener("click", () => select(item));
    append(list, button);
    buttons.push(button);
  }
  datasetView.replaceChildren(list, detail);
  select(items[0]);
}

function renderEmpty() {
  workspace.replaceChildren(append(el("div", "empty-state"),
    el("span", "empty-index", "PUBLICATION STATUS / 00"),
    el("h3", "", "No evaluations are published yet."),
    el("p", "", "The site is ready for independently verified run exports. When results are released, this space will show their exact conditions, item outcomes, and available proof lines.")));
  stamp.textContent = "0 PUBLISHED RUNS";
}
function renderError(error) {
  workspace.replaceChildren(append(el("div", "error-state"),
    el("span", "empty-index", "DATA UNAVAILABLE"),
    el("h3", "", "The publication data could not be read."),
    el("p", "", "Serve this directory over HTTP and check that data/results.json is present and follows the documented public schema.")));
  stamp.textContent = "DATA UNAVAILABLE";
  console.error("PropBench publication data error:", error);
}
function filteredGroups() { return state.filter === "all" ? state.groups : state.groups.filter(group => group.track === state.filter); }

function filterButton(name, label) {
  const button = el("button", "filter-button", label);
  button.type = "button";
  button.dataset.filter = name;
  button.setAttribute("aria-pressed", String(state.filter === name));
  button.addEventListener("click", () => { state.filter = name; state.groupKey = null; state.recordKey = null; render(); workspace.querySelector(`[data-filter="${name}"]`)?.focus(); });
  return button;
}
function toolbar(groups) {
  const toolbar = el("div", "results-toolbar");
  const left = el("div");
  append(left, el("span", "toolbar-title", "PUBLISHED CONDITIONS"), el("span", "toolbar-count", `${groups.length} shown`));
  const filters = el("div", "filter-set");
  filters.setAttribute("role", "group");
  filters.setAttribute("aria-label", "Filter published conditions by track");
  append(filters, filterButton("all", "All"), filterButton("frontier", "Frontier"), filterButton("unaided", "Unaided"));
  return append(toolbar, left, filters);
}
function runCard(group) {
  const button = el("button", "run-card");
  button.type = "button";
  button.dataset.groupKey = group.key;
  button.setAttribute("aria-pressed", String(state.groupKey === group.key));
  button.setAttribute("aria-label", `${title(group.label)}. ${group.scoredRecords.length} completed scored verdicts of ${group.target} planned items; ${group.jobCounts.interrupted} interrupted and ${group.jobCounts.pending} pending. Open condition details.`);
  const kicker = el("div", "run-kicker");
  append(kicker, el("span", "", `${group.track.toUpperCase()} / ${group.mode.toUpperCase()}`), el("span", "", "↗"));
  const subline = el("div", "run-subline", `${joined(group.models)} · ${group.campaign_id ? "Campaign " + group.campaign_id : "Historical run"}`);
  const metrics = el("div", "run-metrics");
  const coverage = el("div");
  append(coverage, el("span", "meta-label", group.official ? "VALID / COMPLETED" : "FIXTURE / UNRANKED"), el("span", "metric-value", group.official && group.scoredRecords.length ? `${group.valid}/${group.scoredRecords.length}` : "—"));
  const seen = el("div");
  append(seen, el("span", "meta-label", "COMPLETED / PLANNED"), el("span", "metric-value", `${group.scoredRecords.length}/${group.target}`));
  append(metrics, coverage, seen);
  const progress = el("div", "run-progress", `${group.jobCounts.interrupted} interrupted · ${group.jobCounts.active} active · ${group.jobCounts.pending} pending`);
  append(button, kicker, el("h3", "", title(group.label)), subline, metrics, progress);
  button.addEventListener("click", () => {
    state.groupKey = group.key;
    state.recordKey = null;
    render();
    [...workspace.querySelectorAll("[data-group-key]")].find(node => node.dataset.groupKey === group.key)?.focus();
  });
  return button;
}
function fact(label, value) { const block = el("div", "run-fact"); append(block, el("span", "meta-label", label), el("strong", "", pretty(value))); return block; }
function detail(group) {
  const section = el("section", "run-detail");
  section.setAttribute("aria-label", `${title(group.label)} results`);
  const head = el("div", "detail-head");
  const headCopy = el("div");
  const kicker = el("span", "run-kicker", `${group.track.toUpperCase()} · ${group.mode.toUpperCase()} · ${group.runs.length} PUBLISHED RUN${group.runs.length === 1 ? "" : "S"}`);
  append(headCopy, kicker, el("h3", "", title(group.label)), el("p", "", group.campaign_id ? `Campaign ${group.campaign_id}. ${group.jobCounts.complete} completed, ${group.jobCounts.interrupted} interrupted, ${group.jobCounts.active} active, ${group.jobCounts.pending} pending of ${group.target} planned jobs.` : "A historical run, shown separately from campaign observations."));
  const pill = el("span", `evidence-pill${group.evidence.includes("fixture") ? " fixture" : ""}`, group.evidence.length ? group.evidence.map(title).join(" / ") + " EVIDENCE" : "PLANNED · NO EVIDENCE");
  append(head, headCopy, pill);
  const facts = el("div", "run-facts");
  append(facts, fact("MODEL", joined(group.models)), fact("REQUESTED EFFORT", joined(group.efforts)), fact("PER-RUN BUDGET", joined(group.budgets)), fact("PROTOCOL", group.protocols.length ? joined(group.protocols) : "Awaiting first run"));
  const intro = el("div", "detail-intro");
  const aggregate = !group.official ? "Fixture evidence is inspectable and excluded from the official comparison." :
    group.meanCompletedLoss == null ? "No completed subscription verdicts have a comparable score." :
      `Mean completed loss ${number(group.meanCompletedLoss, 3)} across ${group.scoredRecords.length} completed item verdict${group.scoredRecords.length === 1 ? "" : "s"}.`;
  const completion = group.scoredRecords.length < group.target ? " This is a partial census, not a full-set score." : " The complete census is available below.";
  const availability = group.observed === 0 ? " No item verdicts have been published for this condition." :
    ` ${group.observed} item verdict${group.observed === 1 ? " is" : "s are"} inspectable${group.records.some(record => !group.scoredRecords.includes(record)) ? ", including excluded records" : ""}.`;
  append(intro, el("h4", "", "ITEM RECORD"), el("p", "", aggregate + (group.official ? completion : "") + availability));
  const browser = el("div", "item-browser");
  const list = el("div", "item-list");
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", "Theorem results");
  const sortedRecords = [...group.records].sort((a, b) => a.result.id.localeCompare(b.result.id) || a.run.id.localeCompare(b.run.id));
  if (!sortedRecords.length) browser.classList.add("is-empty");
  const selected = sortedRecords.find(record => recordKey(record) === state.recordKey) || sortedRecords[0];
  if (selected) state.recordKey = recordKey(selected);
  if (!sortedRecords.length) append(list, el("div", "proof-unavailable", "No item verdicts have been published for this condition yet."));
  for (const record of sortedRecords) append(list, itemButton(record, group));
  append(browser, list, selected ? proofPanel(selected, group) : append(el("div", "proof-panel"), el("h4", "", "Awaiting the first verdict"), el("p", "proof-note", "The planned items and budget are recorded above. Proof details will appear after a run is independently graded and exported.")));
  return append(section, head, facts, intro, browser);
}
function itemButton(record, group) {
  const { result, item, run } = record;
  const excluded = !group.scoredRecords.includes(record);
  const button = el("button", "item-button");
  button.type = "button";
  button.dataset.itemKey = recordKey(record);
  button.setAttribute("aria-pressed", String(state.recordKey === recordKey(record)));
  button.setAttribute("aria-label", `${item.id}, ${title(result.status)}${excluded ? ", excluded from completed summary" : ""}, ${result.line_count == null ? "no verified length" : result.line_count + " verified lines"}. View proof record.`);
  const top = el("span", "item-button-top");
  append(top, el("span", "", item.id), el("span", `item-status ${result.status === "valid" && !excluded ? "valid" : ""}`, excluded ? `${title(result.status)} · ${run.evidence === "fixture" ? "fixture" : "excluded"}` : title(result.status)));
  const bottom = el("span", "item-button-bottom");
  append(bottom, el("span", "", result.line_count == null ? "No valid length" : `${result.line_count} lines`), el("span", "", `Par ${item.par}`));
  append(button, top, bottom);
  button.addEventListener("click", () => {
    state.recordKey = recordKey(record);
    render();
    [...workspace.querySelectorAll("[data-item-key]")].find(node => node.dataset.itemKey === state.recordKey)?.focus();
  });
  return button;
}
function proofPanel(record, group) {
  const { result, item, run } = record;
  const panel = el("article", "proof-panel");
  append(panel, el("span", "run-kicker", `${item.id} / ${item.theorem.difficulty || "THEOREM"}`), el("h4", "", "Theorem and proof record"));
  const included = group.scoredRecords.includes(record);
  if (!included) append(panel, el("p", "exclusion-note", run.evidence === "fixture" ?
    "Fixture evidence. This result is inspectable but does not enter the official campaign summary." :
    "Interrupted or incomplete run. Its verdict and verified lines are inspectable, but its loss and validity do not enter the completed campaign summary."));
  const theorem = el("div", "theorem-box");
  const definition = el("dl");
  append(definition, el("dt", "", "PREMISES"), el("dd", "", item.theorem.premises.length ? item.theorem.premises.join(" · ") : "None"), el("dt", "", "CONCLUSION"), el("dd", "", item.theorem.conclusion));
  append(theorem, definition);
  const summary = el("div", "proof-summary");
  append(summary, summaryPart("VERDICT", title(result.status)), summaryPart("VERIFIED LENGTH", result.line_count == null ? "—" : String(result.line_count)), summaryPart("REFERENCE PAR", String(item.par)), summaryPart(included ? "ITEM LOSS" : "ITEM LOSS, EXCLUDED", number(result.loss, 3)));
  const sourceLinks = el("div", "proof-source-links");
  append(sourceLinks, resource("Open exact theorem JSON ↗", `./data/theorems/${encodeURIComponent(item.id)}.json`));
  if (result.proof_file) append(sourceLinks, resource("Open submitted proof JSON ↗", `./data/${result.proof_file}`));
  append(panel, theorem, summary, sourceLinks);
  const progress = run.track === "frontier" ? verifiedProgress(run, item.id) : null;
  if (progress) append(panel, progress);
  if (result.proof && result.status === "valid") {
    const wrap = el("div", "proof-table-wrap");
    const table = el("table", "proof-table");
    table.setAttribute("role", "table");
    const caption = el("caption", "sr-only", `Verified submitted proof lines for ${item.id}`);
    const thead = el("thead"); thead.setAttribute("role", "rowgroup");
    const headings = el("tr"); headings.setAttribute("role", "row");
    for (const heading of ["LINE", "FORMULA", "JUSTIFICATION", "DEPTH"]) {
      const cell = el("th", "", heading); cell.setAttribute("role", "columnheader"); append(headings, cell);
    }
    append(thead, headings);
    const tbody = el("tbody"); tbody.setAttribute("role", "rowgroup");
    for (const line of result.proof) {
      const row = el("tr"); row.setAttribute("role", "row");
      for (const [index, value] of [String(line.line_number).padStart(2, "0"), line.formula, line.justification, String(line.depth)].entries()) {
        const cell = el("td", index === 0 ? "proof-step" : "", value); cell.setAttribute("role", "cell"); append(row, cell);
      }
      append(tbody, row);
    }
    append(table, caption, thead, tbody);
    append(wrap, table);
    append(panel, wrap, el("p", "proof-note", "The table shows submitted lines. Premises are supplied by the theorem and do not count toward length."));
  } else {
    append(panel, el("div", "proof-unavailable", result.status === "valid" ? "The proof passed verification, but its line-by-line public export is unavailable." : "No verified proof is available for this outcome."));
  }
  const receipt = el("div", "proof-receipt");
  append(receipt,
    receiptRow("RUN ID", run.id),
    receiptRow("GRADE DATE", date(run.graded_at)),
    receiptRow("EVIDENCE / STATUS", `${run.evidence} / ${run.evaluation_status}`),
    receiptRow("RUN OUTCOME", pretty(run.outcome)),
    receiptRow("EXECUTION", `${run.provider} · ${run.execution_protocol}`),
    receiptRow("REQUESTED MODEL", run.model),
    receiptRow("RETURNED MODEL", run.returned_models.length ? run.returned_models.join(", ") : "Not recorded"),
    receiptRow("OBSERVED MODELS", run.observed_models.length ? run.observed_models.join(", ") : "Not recorded"),
    receiptRow("BUDGET / EFFORT", `${run.budget.wall_seconds}s · ${run.subscription?.max_tool_calls == null ? "tool allowance not recorded" : run.subscription.max_tool_calls + " tool calls"} · ${run.subscription?.effort || "effort not recorded"}`),
    receiptRow("CLIENT SESSIONS", run.client_sessions == null ? "Not recorded" : String(run.client_sessions)),
    receiptRow("TOOL EVENTS", run.tool_counts ? `exec ${run.tool_counts.exec} · delegate ${run.tool_counts.delegate}` : "Not recorded"),
    receiptRow("ISOLATED RUNTIME", run.runtime ? [run.runtime.backend, run.runtime.architecture, run.runtime.image_id].filter(Boolean).join(" · ") : "Not applicable"),
    receiptRow("ELAPSED", run.elapsed_seconds == null ? "Not recorded" : `${number(run.elapsed_seconds, 1)} seconds`),
    receiptRow("USAGE COVERAGE", run.usage_coverage == null ? "Not recorded" : `${run.usage_coverage.attempts_with_usage}/${run.usage_coverage.attempts} attempts have usage`),
    receiptRow("SELECTED IDS", run.selected_ids.join(", ")),
    receiptRow("COHORT", pretty(run.cohort)),
    receiptRow("STARTING SNAPSHOT", run.mode === "fresh" || run.mode === "unaided" ? "None (fresh start)" : pretty(run.starting_snapshot)),
    receiptRow("CUMULATIVE SEED RUN", pretty(run.seed_run_id)),
    receiptRow("SET HASH", state.data.set.hash),
    receiptRow("THEOREM SHA-256", pretty(item.theorem_sha256)),
    receiptRow("PROOF SHA-256", pretty(result.proof_sha256)),
    receiptRow("PROOF FILE BYTES SHA-256", pretty(result.proof_bytes_sha256)),
    receiptRow("INDEPENDENT REPLAY", result.independently_replayed ? "Confirmed in public export" : "Not recorded"),
    receiptRow("EVALUATOR HASH", pretty(run.evaluator_hash)),
    receiptRow("REGRADE HASH", pretty(run.regraded_by)),
    receiptRow("VALIDATOR SHA-256", pretty(run.validator_sha256)),
    receiptRow("RULEBOOK SHA-256", pretty(run.rulebook_sha256)));
  append(panel, receipt);
  return panel;
}
function verifiedProgress(run, itemId) {
  const events = run.improvements.filter(event => event.item_id === itemId);
  if (!events.length) return null;
  const replayed = events.every(event => event.independently_replayed);
  const section = el("section", "checkpoint-section");
  section.setAttribute("aria-label", `${itemId} accepted proof checkpoints`);
  const heading = el("div", "checkpoint-heading");
  append(heading, el("span", "micro-label", "FRONTIER / ACCEPTED CHECKPOINTS"),
    el("h5", "", replayed ? "Verified progress" : "Recorded progress"));
  const description = el("p", "checkpoint-intro", replayed
    ? "Each checkpoint was accepted during the run and independently replayed for this public export."
    : "These accepted checkpoints are recorded in the public export; independent replay is not recorded for every checkpoint.");
  const list = el("ol", "checkpoint-list");
  for (const event of events) {
    const row = el("li", "checkpoint-event");
    const metrics = el("div", "checkpoint-metrics");
    const length = el("strong", "checkpoint-length");
    if (event.previous_line_count !== null) append(length, el("span", "checkpoint-previous", String(event.previous_line_count)),
      el("span", "checkpoint-arrow", "→"));
    append(length, document.createTextNode(String(event.line_count)), el("small", "", "lines"));
    append(metrics, length, el("span", "checkpoint-time", `at ${number(event.captured_elapsed_seconds, 2)} s`));
    const context = el("div", "checkpoint-context");
    append(context, el("span", "", event.previous_line_count === null ? "First accepted proof" : "Shorter accepted proof"),
      el("span", "", `checkpoint ${event.checkpoint_id} · command ${event.execution_command}`));
    append(row, metrics, context, resource("Open checkpoint proof JSON ↗", `./data/${event.proof_file}`));
    append(list, row);
  }
  return append(section, heading, description, list,
    el("p", "checkpoint-caveat", "Only accepted checkpoints are shown. Times are recorded capture offsets; no result is inferred between them. A shorter proof is not a claim of optimality."));
}
function summaryPart(label, value) { const node = el("span"); append(node, el("strong", "", value), document.createTextNode(` ${label.toLowerCase()}`)); return node; }
function receiptRow(label, value) { const node = el("div", "receipt-row"); append(node, el("span", "meta-label", label), el("code", "", value)); return node; }

function render() {
  if (!state.data) return;
  if (!state.groups.length) return renderEmpty();
  const groups = filteredGroups();
  if (!groups.some(group => group.key === state.groupKey)) state.groupKey = groups[0]?.key || null;
  const chosen = groups.find(group => group.key === state.groupKey);
  const list = el("div", "run-list");
  for (const group of groups) append(list, runCard(group));
  workspace.replaceChildren(toolbar(groups), groups.length ? list : append(el("div", "empty-state"), el("h3", "", "No runs in this track."), el("p", "", "Choose another filter to inspect the published evidence.")), chosen ? detail(chosen) : el("div"));
  stamp.textContent = state.data.campaign ? `${state.data.campaign.jobs.filter(job => job.status === "complete").length} / ${state.data.campaign.planned_jobs} JOBS COMPLETE` :
    `${state.data.runs.length} PUBLISHED RUN${state.data.runs.length === 1 ? "" : "S"}`;
}

async function start() {
  try {
    const response = await fetch(new URL("./data/results.json", import.meta.url), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = parsePublication(await response.json());
    state.groups = groupRuns(state.data);
    renderResources();
    renderCampaignSummary();
    renderDataset();
    provenance.textContent = `Exported ${date(state.data.generated_at)} · Set ${state.data.set.version} · ${state.data.evaluator.scorer_version}`;
    render();
  } catch (error) { renderError(error); }
}
start();
