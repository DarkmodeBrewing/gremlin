import { randomUUID } from "node:crypto";
import postgres, {type Sql} from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOpenRouterConsolidationProvider } from "../../src/consolidation-provider.js";
import { consolidateSources } from "../../src/consolidation.js";
import { loadPriorConversationContext } from "../../src/consolidation-context.js";
import { searchMemories } from "../../src/memory-retrieval.js";

const url=process.env.DATABASE_URL;
if(!url) throw new Error("DATABASE_URL required");
describe("grounded incremental memory",()=>{
  let database:Sql;
  beforeAll(()=>{database=postgres(url,{max:3});});
  beforeEach(async()=>{
    await database`TRUNCATE principals, embedding_models CASCADE`;
    await database`INSERT INTO principals(principal_id,api_key_hash,can_consolidate) VALUES
      ('client:chat',${'a'.repeat(64)},false),('agent:other',${'b'.repeat(64)},false),('system:consolidator',${'c'.repeat(64)},true)`;
    await database`INSERT INTO principal_memory_read_policies(principal_id,namespace_prefix,include_descendants) VALUES('client:chat','user',true),('agent:other','restricted',true)`;
  });
  afterAll(async()=>{await database.end();});
  async function append(conversation:string,content:string,time:string,principal='client:chat',role='user') {
    const [row]=await database<Array<{id:string}>>`INSERT INTO interactions(conversation_id,source_principal,role,content,occurred_at)
      VALUES(${conversation},${principal},${role},${content},${time}) RETURNING id`;
    return row!.id;
  }
  it("resolves a follow-up using archived context, preserves evidence and returns it only to authorized Chat",async()=>{
    const conversation=randomUUID();
    const prior=await append(conversation,'I bought Brewery Reserve Ale 2030. It is beer.','2030-01-01');
    await append(conversation,'Other client secret','2030-01-01T01:00:00Z','agent:other');
    await append(randomUUID(),'Unrelated conversation','2030-01-01T02:00:00Z');
    let phase=0;
    const embeddingProvider={name:'test',configuredModel:'test',embedMany:async(texts:readonly string[])=>({model:'test',embeddings:texts.map(()=>[1,0,0])})};
    let current='';
    const provider=createOpenRouterConsolidationProvider({apiKey:'test',model:'test',timeoutMilliseconds:1000,
      namespaceRoots:{'client:chat':'user','agent:other':'restricted'},
      fetchImplementation:async(_input,init)=>{
        const data=JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
        if(phase===0) return new Response(JSON.stringify({choices:[{message:{content:'{"memories":[]}'}}]}));
        expect(data.priorContext.map((s:{id:string})=>s.id)).toEqual([prior]);
        expect(data.sources).toHaveLength(1);
        return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({memories:[{
          namespace:'cellar/beer',content:'The user has two bottles of Brewery Reserve Ale 2030.',confidence:0.9,
          evidence:[current,prior].map(id=>({kind:'interaction',id}))
        }]})}}]}));
      }});
    const dependencies={database,batchSize:20,maxSourceCharacters:200000,embeddingProvider,provider};
    await consolidateSources(dependencies,'system:consolidator');phase=1;
    current=await append(conversation,'I have two bottles of that vintage for the cellar.','2030-01-02');
    await append(conversation,'You have wine.','2030-01-02T01:00:00Z','client:chat','assistant');
    expect(await consolidateSources(dependencies,'system:consolidator')).toMatchObject({memoryCount:1,sourceCount:2,status:'succeeded'});
    const chat=await searchMemories({database,embeddingProvider},'client:chat','What is in my cellar?',5);
    expect(chat).toHaveLength(1);expect(chat[0]).toMatchObject({namespace:'user/cellar/beer'});
    expect(await searchMemories({database,embeddingProvider},'agent:other','What is in the cellar?',5)).toEqual([]);
    const evidence=await database<Array<{interaction_id:string}>>`SELECT interaction_id FROM memory_evidence ORDER BY interaction_id`;
    expect(evidence.map(row=>row.interaction_id).sort()).toEqual([current,prior].sort());
    expect((await database`SELECT count(*)::int AS count FROM interactions`)[0]!.count).toBe(5);
  });
  it("keeps a newly introduced second cat readable under the existing Chat grant",async()=>{
    const conversation=randomUUID();
    const current=await append(conversation,"My second cat is Pip, Ada's son.",'2030-01-02');
    const provider=createOpenRouterConsolidationProvider({apiKey:'test',model:'test',timeoutMilliseconds:1000,
      namespaceRoots:{'client:chat':'user'},fetchImplementation:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({memories:[{
        namespace:'pets/cats',content:"The user has two cats, Ada and Pip. Pip is Ada's son.",confidence:0.9,evidence:[{kind:'interaction',id:current}]
      }]})}}]}))});
    const embeddingProvider={name:'test',configuredModel:'test',embedMany:async(texts:readonly string[])=>({model:'test',embeddings:texts.map(()=>[1,0,0])})};
    expect(await consolidateSources({database,batchSize:20,maxSourceCharacters:200000,embeddingProvider,provider},'system:consolidator'))
      .toMatchObject({memoryCount:1,status:'succeeded'});
    expect((await searchMemories({database,embeddingProvider},'client:chat','Who is Pip?',5))[0])
      .toMatchObject({namespace:'user/pets/cats',content:"The user has two cats, Ada and Pip. Pip is Ada's son."});
    expect(await searchMemories({database,embeddingProvider},'agent:other','Who is Pip?',5)).toEqual([]);
  });
  it("does not read later records, assistant answers or another principal using the same conversation UUID",async()=>{
    const conversation=randomUUID();
    const prior=await append(conversation,'Earlier user fact','2030-01-01');
    await append(conversation,'Different principal','2030-01-01','agent:other');
    await append(conversation,'Assistant guess','2030-01-01','client:chat','assistant');
    await append(conversation,'Future correction','2030-01-03');
    const current={id:randomUUID(),kind:'interaction' as const,sourcePrincipal:'client:chat',conversationId:conversation,
      occurredAt:new Date('2030-01-02'),role:'user' as const,content:'Follow-up'};
    expect((await loadPriorConversationContext(database,[current])).map(row=>row.id)).toEqual([prior]);
  });
});
