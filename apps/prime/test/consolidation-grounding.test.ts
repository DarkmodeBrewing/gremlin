import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createOpenRouterConsolidationProvider, groundCandidateMemories, type CandidateMemory, type SourceInteraction } from "../src/consolidation-provider.js";
import { selectPriorConversationContext } from "../src/consolidation-context.js";

function source(overrides: Partial<SourceInteraction> = {}): SourceInteraction {
  return { id: randomUUID(), kind: "interaction", sourcePrincipal: "client:chat",
    conversationId: randomUUID(), occurredAt: new Date("2030-01-02"), role: "user", content: "My cat is called Ada.", ...overrides };
}
function memory(record: SourceInteraction, namespace = "pets/cats"): CandidateMemory {
  return { content: "The user's cat is Ada.", namespace, confidence: 0.9, evidence: [{kind:"interaction", id:record.id}] };
}
const roots = { "client:chat": "user", "agent:other": "restricted" };

describe("consolidation grounding", () => {
  it("puts model topics inside the configured root without granting read access", () => {
    const record = source();
    expect(groundCandidateMemories([memory(record)], [record], [], roots)[0]?.namespace).toBe("user/pets/cats");
    expect(groundCandidateMemories([memory(record,"user/pets")], [record], [], roots)[0]?.namespace).toBe("user/pets");
    expect(groundCandidateMemories([memory(record,"restricted/secret")], [record], [], roots)[0]?.namespace).toBe("user/restricted/secret");
    expect(()=>groundCandidateMemories([memory(record)], [record], [], {})).toThrow();
  });
  it("supports exact destinations without appending model-selected topics", () => {
    const record = source({sourcePrincipal:"agent:other"});
    const destinations = {"agent:other": {namespace:"project/client",includeDescendants:false}};
    expect(groundCandidateMemories([memory(record,"arbitrary/topic")],[record],[],destinations)[0]?.namespace)
      .toBe("project/client");
    const user = source();
    expect(()=>groundCandidateMemories([{...memory(user),evidence:[user,record].map(s=>({kind:"interaction" as const,id:s.id}))}],
      [user,record],[],{"client:chat":{namespace:"project/client",includeDescendants:true},...destinations})).toThrow();
  });
  it("rejects assistant-only, context-only, unknown and cross-root evidence", () => {
    const user = source(); const assistant=source({role:"assistant"}); const prior=source();
    for(const evidence of [[assistant],[prior],[source()]]) {
      const candidate={...memory(user),evidence:evidence.map(s=>({kind:"interaction" as const,id:s.id}))};
      expect(()=>groundCandidateMemories([candidate],[user,assistant],[prior],roots)).toThrow();
    }
    const other=source({sourcePrincipal:"agent:other"});
    expect(()=>groundCandidateMemories([{...memory(user),evidence:[user,other].map(s=>({kind:"interaction" as const,id:s.id}))}],[user,other],[],roots)).toThrow();
    expect(()=>groundCandidateMemories([{...memory(user),evidence:[user,assistant].map(s=>({kind:"interaction" as const,id:s.id}))}],[user,assistant],[],roots)).toThrow();
  });
  it("supplies the earlier named beverage, excludes assistant guesses and roots the result", async () => {
    const user=source({content:"I have two bottles of that vintage for the cellar."});
    const prior=source({conversationId:user.conversationId,occurredAt:new Date("2030-01-01"),content:"I bought Brewery Reserve Ale 2030. It is beer."});
    const assistant=source({conversationId:user.conversationId,role:"assistant",content:"You have wine."});
    const request=vi.fn<typeof fetch>(async(_url,init)=>{
      const body=JSON.parse(String(init?.body));
      const data=JSON.parse(body.messages[1].content);
      expect(data.sources.map((s:SourceInteraction)=>s.id)).toEqual([user.id]);
      expect(data.priorContext[0].content).toContain("Reserve Ale");
      expect(JSON.stringify(data)).not.toContain("You have wine");
      expect(body.messages[0].content).toContain("omit unresolved facts");
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({memories:[{
        ...memory(user,"cellar/beer"),content:"The user has two bottles of Brewery Reserve Ale 2030.",
        evidence:[user,prior].map(s=>({kind:"interaction",id:s.id}))
      }]})}}]}));
    });
    const provider=createOpenRouterConsolidationProvider({apiKey:"test",model:"test",timeoutMilliseconds:1000,namespaceRoots:roots,fetchImplementation:request});
    expect((await provider.consolidate([user,assistant],[prior]))[0]).toMatchObject({namespace:"user/cellar/beer",evidence:[{id:user.id},{id:prior.id}]});
    await expect(provider.consolidate([assistant])).resolves.toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("fails before a paid request when a source destination is unconfigured", async()=>{
    const request=vi.fn<typeof fetch>();
    const provider=createOpenRouterConsolidationProvider({apiKey:"test",model:"test",timeoutMilliseconds:1000,fetchImplementation:request});
    await expect(provider.consolidate([source()])).rejects.toThrow("no configured namespace root");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("bounded conversation context",()=>{
  it("includes only earlier same-principal, same-conversation user records",()=>{
    const current=source();
    const prior=source({conversationId:current.conversationId,occurredAt:new Date("2030-01-01")});
    const history=[prior,source({occurredAt:new Date("2030-01-01")}),
      {...prior,id:randomUUID(),sourcePrincipal:"agent:other"},
      {...prior,id:randomUUID(),role:"assistant" as const},
      {...prior,id:randomUUID(),occurredAt:new Date("2030-01-03")},current];
    expect(selectPriorConversationContext([current],history)).toEqual([prior]);
  });
  it("bounds history and omits oversized records without truncating evidence",()=>{
    const current=source();
    const history=Array.from({length:20},(_,n)=>source({conversationId:current.conversationId,occurredAt:new Date(Date.UTC(2030,0,1,0,n))}));
    const result=selectPriorConversationContext([current],history);
    expect(result).toHaveLength(8);expect(result).toEqual(history.slice(-8));
    expect(selectPriorConversationContext([current],[{...history[0]!,content:"x".repeat(40_001)}])).toEqual([]);
  });
});
