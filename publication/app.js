import { parsePublication, groupRuns } from "./data.js";

const workspace = document.querySelector("#results-workspace");
const stamp = document.querySelector("#data-stamp");
const provenance = document.querySelector("#footer-provenance");
const resources = document.querySelector("#resource-links");
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
  const commit = state.data.campaign?.source_commit;
  const repository = "https://github.com/dogaozden/prop-bench";
  links.push(resource("Method and protocol ↗", `${repository}/blob/master/TRACKS.md`, true));
  links.push(resource(commit && /^[a-f0-9]{40}$/.test(commit) ? "Source at campaign commit ↗" : "Source repository ↗",
    commit && /^[a-f0-9]{40}$/.test(commit) ? `${repository}/tree/${commit}` : repository, true));
  resources.replaceChildren(...links);
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
  append(intro, el("h4", "", "ITEM RECORD"), el("p", "", aggregate + (group.official ? completion : "") + ` ${group.observed} item verdict${group.observed === 1 ? " is" : "s are"} inspectable, including interrupted records.`));
  const browser = el("div", "item-browser");
  const list = el("div", "item-list");
  list.setAttribute("aria-label", "Theorem results");
  const sortedRecords = [...group.records].sort((a, b) => a.result.id.localeCompare(b.result.id) || a.run.id.localeCompare(b.run.id));
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
  append(panel, theorem, summary, resource("Open exact theorem JSON ↗", `./data/theorems/${encodeURIComponent(item.id)}.json`));
  if (result.proof && result.status === "valid") {
    const wrap = el("div", "proof-table-wrap");
    const table = el("table", "proof-table");
    const caption = el("caption", "sr-only", `Verified submitted proof lines for ${item.id}`);
    const thead = el("thead"); const headings = el("tr");
    for (const heading of ["LINE", "FORMULA", "JUSTIFICATION", "DEPTH"]) append(headings, el("th", "", heading));
    append(thead, headings);
    const tbody = el("tbody");
    for (const line of result.proof) {
      const row = el("tr");
      append(row, el("td", "proof-step", String(line.line_number).padStart(2, "0")), el("td", "", line.formula), el("td", "", line.justification), el("td", "", String(line.depth)));
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
    receiptRow("ELAPSED", run.elapsed_seconds == null ? "Not recorded" : `${number(run.elapsed_seconds, 1)} seconds`),
    receiptRow("USAGE COVERAGE", run.usage_coverage == null ? "Not recorded" : `${run.usage_coverage.attempts_with_usage}/${run.usage_coverage.attempts} attempts have usage`),
    receiptRow("SELECTED IDS", run.selected_ids.join(", ")),
    receiptRow("COHORT", pretty(run.cohort)),
    receiptRow("STARTING SNAPSHOT", run.mode === "fresh" || run.mode === "unaided" ? "None (fresh start)" : pretty(run.starting_snapshot)),
    receiptRow("CUMULATIVE SEED RUN", pretty(run.seed_run_id)),
    receiptRow("SET HASH", state.data.set.hash),
    receiptRow("THEOREM SHA-256", pretty(item.theorem_sha256)),
    receiptRow("PROOF SHA-256", pretty(result.proof_sha256)),
    receiptRow("INDEPENDENT REPLAY", result.independently_replayed ? "Confirmed in public export" : "Not recorded"),
    receiptRow("EVALUATOR HASH", pretty(run.evaluator_hash)),
    receiptRow("VALIDATOR SHA-256", pretty(run.validator_sha256)),
    receiptRow("RULEBOOK SHA-256", pretty(run.rulebook_sha256)));
  append(panel, receipt);
  return panel;
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
    provenance.textContent = `Exported ${date(state.data.generated_at)} · Set ${state.data.set.version} · ${state.data.evaluator.scorer_version}`;
    render();
  } catch (error) { renderError(error); }
}
start();
