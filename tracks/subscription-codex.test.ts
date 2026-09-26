import assert from "node:assert/strict";
import { test } from "node:test";
import { constrainedCatalog, restrictedConfig, subscriptionEnvironment, redact, CodexTurnGuard, assertIsolatedThread, assertRestrictedConfig, assertConstrainedCatalog, handleCodexToolCall } from "./subscription-codex";

test("subscription credentials stay native while API and provider overrides are removed", () => {
  const source = { HOME:"/real/home", CODEX_HOME:"/real/codex", PATH:"/usr/bin", OPENROUTER_API_KEY:"secret", OPENAI_BASE_URL:"https://example.invalid", ANTHROPIC_AUTH_TOKEN:"secret", NODE_OPTIONS:"--import /tmp/inject.js" };
  const result = subscriptionEnvironment(source);
  assert.deepEqual(result,{ HOME:source.HOME,CODEX_HOME:source.CODEX_HOME,PATH:source.PATH });
  assert.equal(source.OPENROUTER_API_KEY,"secret","do not mutate the process/global environment");
  assert.deepEqual(subscriptionEnvironment({HOME:"/real",CODEX_HOME:"/native",AWS_ACCESS_KEY_ID:"id",AWS_SECRET_ACCESS_KEY:"secret",GOOGLE_APPLICATION_CREDENTIALS:"/key.json",AZURE_CLIENT_SECRET:"secret",GITHUB_TOKEN:"secret"}),{HOME:"/real",CODEX_HOME:"/native"});
  assert.deepEqual(subscriptionEnvironment({HOME:"/real",CODEX_HOME:"/native",CODEX_INSTRUCTIONS:"inherited",DYLD_INSERT_LIBRARIES:"inject",LD_PRELOAD:"inject"}),{HOME:"/real",CODEX_HOME:"/native"});
});

test("event redaction removes credential fields and environment values without losing usage", () => {
  assert.deepEqual(redact({accessToken:"private",apiKey:"private",cookie:"private",nested:{clientSecret:"private"},text:"logged opaque-value",input_tokens:40,tokenUsage:{totalTokens:50}},["opaque-value"]),
    {accessToken:"[REDACTED]",apiKey:"[REDACTED]",cookie:"[REDACTED]",nested:{clientSecret:"[REDACTED]"},text:"logged [REDACTED]",input_tokens:40,tokenUsage:{totalTokens:50}});
});

const tool = {namespace:null,tool:"exec",arguments:{command:["echo","READY"]}};
const call = {method:"item/tool/call",params:{threadId:"thread",turnId:"turn",callId:"call",...tool}};
function guard(frontier=true) { const value = new CodexTurnGuard("thread",frontier); value.event({method:"turn/started",params:{threadId:"thread",turn:{id:"turn"}}}); return value; }

test("native tool callbacks are bound to a unique call in the active thread and turn", () => {
  const valid = guard();
  assert.deepEqual(valid.request(call),{accepted:true,input:{command:["echo","READY"]}});
  assert.throws(()=>valid.request(call),/duplicate/);
  for (const patch of [{threadId:"other"},{turnId:"old"},{turnId:undefined},{callId:undefined},{namespace:"mcp"},{tool:"shell"}]) {
    assert.throws(()=>guard().request({...call,params:{...call.params,...patch}}),/protocol violation/);
  }
  assert.throws(()=>guard(false).request(call),/protocol violation/);
  assert.throws(()=>new CodexTurnGuard("thread",true).request(call),/protocol violation/);
});

test("native streamed and terminal-only capability leakage is rejected", () => {
  for (const type of ["commandExecution","mcpToolCall","collabAgentToolCall","dynamicToolCall"]) {
    const item = {type,...tool};
    assert.throws(()=>guard(false).event({method:"item/started",params:{threadId:"thread",turnId:"turn",item}}),/protocol violation/);
    assert.throws(()=>guard(false).event({method:"turn/completed",params:{threadId:"thread",turn:{id:"turn",items:[item]}}}),/protocol violation/);
  }
  assert.throws(()=>guard().event({method:"item/completed",params:{threadId:"other",turnId:"turn",item:{type:"agentMessage"}}}),/wrong session/);
  assert.throws(()=>guard().event({method:"item/commandExecution/outputDelta",params:{threadId:"thread",turnId:"turn"}}),/unexpected event/);
  assert.throws(()=>guard().event({method:"turn/completed",params:{threadId:"thread",turn:{id:"old",items:[]}}}),/wrong session or turn/);
  const valid = guard();
  valid.start({id:"turn"}); // The RPC response confirms the same early event.
  valid.event({method:"item/started",params:{threadId:"thread",turnId:"turn",item:{type:"dynamicToolCall",id:"call",...tool}}});
  valid.request(call);
  valid.event({method:"item/completed",params:{threadId:"thread",turnId:"turn",item:{type:"dynamicToolCall",id:"call",...tool}}});
  valid.event({method:"turn/completed",params:{threadId:"thread",turn:{id:"turn",items:[{type:"agentMessage",text:"READY"}]}}});
});

test("a tool-rich model catalog cannot re-enable computation or silently select another model", () => {
  const original = {models:[{slug:"exact-model",supported_reasoning_levels:[{effort:"xhigh"}],tool_mode:"code_mode_only",shell_type:"unified_exec",apply_patch_tool_type:"freeform",experimental_supported_tools:["clock"],node_repl_disabled:false}]};
  const constrained = constrainedCatalog(original,"exact-model","xhigh").models[0];
  assert.equal(constrained.slug,"exact-model");
  assert.equal(constrained.tool_mode,"direct");
  assert.equal(constrained.shell_type,"disabled");
  assert.equal(constrained.apply_patch_tool_type,null);
  assert.deepEqual(constrained.experimental_supported_tools,[]);
  assert.equal(constrained.node_repl_disabled,true);
  assert.equal(original.models[0].tool_mode,"code_mode_only","the installed catalog is never changed");
  assert.throws(()=>constrainedCatalog(original,"missing-model","xhigh"),/no fallback/);
  assert.throws(()=>constrainedCatalog(original,"exact-model","ultra"),/does not support/);
});

test("native configuration cannot acquire tools via inherited plugins, MCP, or ambiguous names", () => {
  const config = restrictedConfig("/tmp/per-run-models.json",["node_repl","computer-use"]);
  assert.equal(config["mcp_servers.node_repl.enabled"],false);
  assert.equal(config["mcp_servers.computer-use.enabled"],false);
  for (const feature of ["plugins","multi_agent","code_mode","shell_tool","js_repl","apps"]) assert.equal(config[`features.${feature}`],false);
  assert.equal(config.forced_login_method,"chatgpt");
  assert.throws(()=>restrictedConfig("/tmp/catalog",['name.with.dots']),/unusual/);
});

test("thread preflight requires exact model, effort, normal speed, and empty instructions and roots",()=>{
  const valid={model:"gpt-6-astra",modelProvider:"openai",reasoningEffort:"xhigh",serviceTier:"default",instructionSources:[],runtimeWorkspaceRoots:[],approvalPolicy:"never",sandbox:{type:"readOnly"}};
  assert.doesNotThrow(()=>assertIsolatedThread(valid,"gpt-6-astra","xhigh"));
  for(const patch of [{model:"alias"},{modelProvider:"other"},{reasoningEffort:"low"},{reasoningEffort:undefined},{serviceTier:"priority"},{instructionSources:undefined},{instructionSources:["AGENTS.md"]},{runtimeWorkspaceRoots:["/owner"]},{approvalPolicy:"on-request"},{sandbox:{type:"dangerFullAccess"}}]) {
    assert.throws(()=>assertIsolatedThread({...valid,...patch},"gpt-6-astra","xhigh"),/isolation mismatch/);
  }
});

test("all requested effective settings must resolve, including absence and newly injected MCP",()=>{
  const expected={model_provider:"openai","features.shell_tool":false,"skills.include_instructions":false};
  const valid={model_provider:"openai",features:{shell_tool:false},skills:{include_instructions:false},mcp_servers:{disabled:{enabled:false}}};
  assert.doesNotThrow(()=>assertRestrictedConfig(valid,expected));
  assert.throws(()=>assertRestrictedConfig({...valid,features:{}},expected),/did not resolve exactly/);
  assert.throws(()=>assertRestrictedConfig({...valid,mcp_servers:{new:{}}},expected),/MCP server remained enabled/);
});

test("resolved catalog is constrained to exactly one model and the complete tool restrictions",()=>{
  const safe=constrainedCatalog({models:[{slug:"exact",supported_reasoning_levels:[{effort:"high"}]}]},"exact","high");
  assert.doesNotThrow(()=>assertConstrainedCatalog(safe,"exact"));
  for(const patch of [{supports_search_tool:true},{node_repl_disabled:undefined},{include_skills_usage_instructions:true},{experimental_supported_tools:undefined}]) {
    assert.throws(()=>assertConstrainedCatalog({models:[{...safe.models[0],...patch}]},"exact"),/refusing inference/);
  }
  assert.throws(()=>assertConstrainedCatalog({models:[...safe.models,{slug:"extra"}]},"exact"),/refusing inference/);
});

test("recognized tool controls omitted by native ToolsV2 require their exact winning session layer",()=>{
  const expected={"tools.update_plan.enabled":false};
  const report={origins:{"tools.update_plan.enabled":{name:{type:"sessionFlags"}}},layers:[{name:{type:"sessionFlags"},config:{tools:{update_plan:{enabled:false}}}}]};
  assert.doesNotThrow(()=>assertRestrictedConfig({tools:{}},expected,report));
  assert.throws(()=>assertRestrictedConfig({tools:{}},expected),/no winning session origin/);
  assert.throws(()=>assertRestrictedConfig({tools:{}},expected,{...report,origins:{}}),/no winning session origin/);
  assert.throws(()=>assertRestrictedConfig({tools:{}},expected,{...report,layers:[{...report.layers[0],disabledReason:"policy"}]}),/did not resolve exactly/);
  assert.throws(()=>assertRestrictedConfig({tools:{}},expected,{...report,layers:[{name:{type:"sessionFlags"},config:{tools:{update_plan:{enabled:true}}}}]}),/did not resolve exactly/);
});

test("terminal summaries preserve leakage checks and end callback authority",()=>{
  const unobserved={type:"dynamicToolCall",id:"call",...tool};
  assert.throws(()=>guard().event({method:"turn/completed",params:{threadId:"thread",turn:{id:"turn",itemsView:"summary",items:[unobserved]}}}),/unobserved/);
  assert.throws(()=>guard().event({method:"turn/completed",params:{threadId:"thread",turn:{id:"turn",itemsView:"summary",items:[{type:"commandExecution"}]}}}),/unexpected item/);
  const valid=guard(); valid.request(call);
  valid.event({method:"turn/completed",params:{threadId:"thread",turn:{id:"turn",itemsView:"summary",items:[unobserved,{type:"agentMessage",text:"READY"}]}}});
  assert.throws(()=>valid.request({...call,params:{...call.params,callId:"later"}}),/after terminal/);
  assert.throws(()=>valid.event({method:"turn/completed",params:{threadId:"thread",turn:{id:"turn",items:[]}}}),/duplicate terminal/);
  assert.throws(()=>valid.event({method:"item/started",params:{threadId:"thread",turnId:"turn",item:unobserved}}),/after terminal/);
});

test("streamed tool completions match an actual callback even when terminal history is summarized",()=>{
  const valid=guard();valid.request(call);
  for(const patch of [{id:"unobserved"},{id:"call",arguments:{command:["changed"]}},{id:"call",tool:"delegate",arguments:{task:"other"}}]) {
    assert.throws(()=>valid.event({method:"item/completed",params:{threadId:"thread",turnId:"turn",item:{type:"dynamicToolCall",...tool,...patch}}}),/unobserved or mismatched/);
  }
});


test("fake native stream rejects an extra timeout through the owner and continues with a valid exec",async()=>{
  const g=guard();const receipts:unknown[]=[];const executed:string[][]=[];const calls:string[]=[];
  const tools={exec:async(command:string[])=>{executed.push(command);return {stdout:"READY",exitCode:0};},delegate:async()=>{throw Error("must not delegate");},reject:async(rejection:unknown)=>{receipts.push(rejection);return {error:{code:"invalid_tool_arguments",message:"Only command is accepted. No command ran."}};}};
  const invalid={...tool,arguments:{command:["echo","READY"],timeout:20}};
  const started=(id:string,input:any)=>g.event({method:"item/started",params:{threadId:"thread",turnId:"turn",item:{id,type:"dynamicToolCall",...input}}});
  const request=(id:string,input:any)=>({method:"item/tool/call",params:{threadId:"thread",turnId:"turn",callId:id,...input}});
  const completed=(id:string,input:any,reply:any)=>g.event({method:"item/completed",params:{threadId:"thread",turnId:"turn",item:{id,type:"dynamicToolCall",...input,...reply}}});
  started("bad",invalid);
  const rejection=await handleCodexToolCall(g,request("bad",invalid),tools,name=>calls.push(name));
  assert.equal(rejection.success,false);assert.equal(executed.length,0);assert.deepEqual(receipts,[{tool:"exec",arguments:invalid.arguments,native_call_id:"bad"}]);
  assert.match(rejection.contentItems[0].text,/invalid_tool_arguments/);
  completed("bad",invalid,rejection);
  started("good",tool);
  const success=await handleCodexToolCall(g,request("good",tool),tools,name=>calls.push(name));
  assert.equal(success.success,true);completed("good",tool,success);
  g.event({method:"turn/completed",params:{threadId:"thread",turn:{id:"turn",itemsView:"full",items:[{id:"bad",type:"dynamicToolCall",...invalid},{id:"good",type:"dynamicToolCall",...tool},{type:"agentMessage",text:"READY"}]}}});
  assert.deepEqual(executed,[["echo","READY"]]);assert.deepEqual(calls,["exec","exec"]);
});

test("invalid allowed-tool arguments are owner-rejected, including delegate and non-object input",async()=>{
  for(const [name,args] of [["delegate",{task:0}],["delegate",{task:"valid",extra:true}],["exec",null],["exec",[]],["exec","not json"],["exec",{command:[1]}],["exec",{command:[]}]] as const){
    const g=guard();let rejects=0;let executes=0;
    const event={...call,params:{...call.params,tool:name,arguments:args}};
    const tools={exec:async()=>{executes++;},delegate:async()=>{executes++;},reject:async()=>{rejects++;return {error:{code:"invalid_tool_arguments"}};}};
    const reply=await handleCodexToolCall(g,event,tools,()=>{});
    assert.equal(reply.success,false);assert.equal(rejects,1);assert.equal(executes,0);
    g.event({method:"item/completed",params:{threadId:"thread",turnId:"turn",item:{type:"dynamicToolCall",id:"call",namespace:null,tool:name,arguments:args}}});
  }
});

test("malformed input cannot weaken identity, namespace, Unaided, or duplicate-call boundaries",async()=>{
  const invalid={...tool,arguments:{command:["echo"],timeout:1}};let rejected=0;
  const tools={exec:async()=>{},delegate:async()=>{},reject:async()=>{rejected++;return {error:{code:"invalid_tool_arguments"}};}};
  for(const patch of [{namespace:"other"},{tool:"shell"},{threadId:"other"},{turnId:"other"}])await assert.rejects(handleCodexToolCall(guard(),{...call,params:{...call.params,...invalid,...patch}},tools,()=>{}),/protocol violation/);
  await assert.rejects(handleCodexToolCall(guard(false),{...call,params:{...call.params,...invalid}},tools,()=>{}),/protocol violation/);
  assert.equal(rejected,0);
  const g=guard();g.event({method:"item/started",params:{threadId:"thread",turnId:"turn",item:{type:"dynamicToolCall",id:"call",...invalid}}});
  await assert.rejects(handleCodexToolCall(g,call,tools,()=>{}),/mismatched started/);
  await handleCodexToolCall(g,{...call,params:{...call.params,...invalid}},tools,()=>{});
  await assert.rejects(handleCodexToolCall(g,{...call,params:{...call.params,...invalid}},tools,()=>{}),/duplicate/);
  assert.equal(rejected,1);
  assert.throws(()=>g.event({method:"item/completed",params:{threadId:"thread",turnId:"turn",item:{type:"dynamicToolCall",id:"call",...tool}}}),/mismatched streamed/);
  assert.throws(()=>g.event({method:"turn/completed",params:{threadId:"thread",turn:{id:"turn",items:[{type:"dynamicToolCall",id:"call",...tool}]}}}),/mismatched terminal/);
});
