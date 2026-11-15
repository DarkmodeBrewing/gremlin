import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderUsageRecorder, readProviderUsage } from "../../src/provider-usage.js";
import { createOpenRouterEmbeddingProvider } from "../../src/embedding-provider.js";
import { createOpenRouterConsolidationProvider } from "../../src/consolidation-provider.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required');
describe("Prime provider cost accounting", () => {
 let database: Sql;
 beforeAll(()=> { database = postgres(url,{max:1}); });
 beforeEach(async()=> { await database`TRUNCATE provider_usage`; });
 afterAll(async()=> { await database.end(); });
 it("persists exact decimal totals, zero and unknown coverage across new recorder instances", async()=> {
   const first = createProviderUsageRecorder(database);
   await first.record('embedding',{usage:{cost:0.1,prompt_tokens:10,total_tokens:10},secret:'private'});
   const restarted = createProviderUsageRecorder(database);
   await restarted.record('embedding',{usage:{cost:0.2}});
   await restarted.record('embedding',{usage:{cost:0}});
   await restarted.record('embedding',{});
   const usage = await readProviderUsage(database);
   const total = usage.summaries.find(r=>r.period==='all_time');
   expect(total).toMatchObject({kind:'embedding', parsedResponses:4,reportedCostResponses:3,unknownCostResponses:1,reportedCostCredits:'0.3',promptTokens:'10'});
   expect(JSON.stringify(await database`SELECT * FROM provider_usage`)).not.toContain('private');
   expect(usage.summaries.find(r=>r.period==='last_24_hours')?.parsedResponses).toBe(4);
 });
 it("records billing metadata before rejecting invalid model output, without extra requests", async()=> {
   const recorder = createProviderUsageRecorder(database);
   const request = vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({choices:[],usage:{cost:0.5,total_tokens:5},secret:'private'})));
   const provider = createOpenRouterConsolidationProvider({apiKey:'private',model:'test',timeoutMilliseconds:1000,fetchImplementation:request,
    reportUsage:body=>recorder.record('consolidation',body)});
   await expect(provider.consolidate([])).rejects.toThrow();
   expect(request).toHaveBeenCalledTimes(1);
   expect((await readProviderUsage(database)).summaries.find(r=>r.period==='all_time')).toMatchObject({reportedCostCredits:'0.5',parsedResponses:1});
 });
 it("integrates embedding usage reporting without altering embedding results", async()=> {
   const recorder = createProviderUsageRecorder(database);
   const provider = createOpenRouterEmbeddingProvider({apiKey:'private',model:'test',timeoutMilliseconds:1000,
    fetchImplementation:async()=>new Response(JSON.stringify({model:'test',data:[{index:0,embedding:[1,0]}],usage:{cost:0,prompt_tokens:2,total_tokens:2}})),
    reportUsage:body=>recorder.record('embedding',body)});
   expect((await provider.embedMany(['private prompt'])).embeddings).toEqual([[1,0]]);
   expect((await readProviderUsage(database)).summaries[0]).toMatchObject({reportedCostCredits:'0',reportedCostResponses:1});
 });
 it("reports storage failure while preserving a successful paid provider result", async()=> {
   const recorder = createProviderUsageRecorder(database);
   await database`SET default_transaction_read_only = on`;
   try {
    const request = vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({model:'test',data:[{index:0,embedding:[1]}]})));
    const provider = createOpenRouterEmbeddingProvider({apiKey:'private',model:'test',timeoutMilliseconds:1000,fetchImplementation:request,
      reportUsage:body=>recorder.record('embedding',body)});
    expect((await provider.embedMany(['test'])).embeddings).toEqual([[1]]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(recorder.snapshot().status).toBe('unavailable');
   }finally{await database`SET default_transaction_read_only = off`;}
 });
 it("separates recent reporting from old usage and leaves entirely unknown sums null", async()=> {
   await database`INSERT INTO provider_usage(kind,cost_credits,recorded_at) VALUES('embedding',0.9,now()-interval '2 days')`;
   await createProviderUsageRecorder(database).record('consolidation',{});
   const usage=await readProviderUsage(database);
   expect(usage.summaries.some(r=>r.kind==='embedding'&&r.period==='last_24_hours')).toBe(false);
   expect(usage.summaries.find(r=>r.kind==='consolidation'&&r.period==='all_time')).toMatchObject({reportedCostCredits:null,unknownCostResponses:1});
 });
});
