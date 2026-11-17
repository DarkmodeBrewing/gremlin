import type { ConsolidationSource } from "./consolidation-provider.js";
import type { Database } from "./database.js";

const maximumContextRecords = 32;
const maximumContextCharacters = 40_000;
const recordsPerConversation = 8;

function anchors(sources: readonly ConsolidationSource[]) {
  const result = new Map<string, Extract<ConsolidationSource, { kind: "interaction" }>>();
  for (const source of sources) {
    if (source.kind !== "interaction") continue;
    const key = JSON.stringify([source.sourcePrincipal, source.conversationId]);
    const previous = result.get(key);
    if (!previous || source.occurredAt < previous.occurredAt ||
      (source.occurredAt.getTime() === previous.occurredAt.getTime() && source.id < previous.id)) result.set(key, source);
  }
  return result;
}

/** Earlier user assertions only; never pull future, other-client or other-conversation context. */
export function selectPriorConversationContext(
  sources: readonly ConsolidationSource[],
  history: readonly ConsolidationSource[]
): readonly ConsolidationSource[] {
  const first = anchors(sources);
  const selectedIds = new Set(sources.map(source => source.id));
  const counts = new Map<string, number>();
  let characters = 0;
  const result: ConsolidationSource[] = [];
  const newestFirst = [...history].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.id.localeCompare(a.id));
  for (const record of newestFirst) {
    if (record.kind !== "interaction" || record.role !== "user" || selectedIds.has(record.id)) continue;
    const key = JSON.stringify([record.sourcePrincipal, record.conversationId]);
    const anchor = first.get(key);
    if (!anchor || record.occurredAt > anchor.occurredAt ||
      (record.occurredAt.getTime() === anchor.occurredAt.getTime() && record.id >= anchor.id)) continue;
    if ((counts.get(key) ?? 0) >= recordsPerConversation || result.length >= maximumContextRecords ||
      characters + record.content.length > maximumContextCharacters) continue;
    result.push(record);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    characters += record.content.length;
  }
  return result.reverse();
}

export async function loadPriorConversationContext(
  database: Database,
  sources: readonly ConsolidationSource[]
): Promise<readonly ConsolidationSource[]> {
  const first = [...anchors(sources).values()].map(source => ({
    principal: source.sourcePrincipal, conversation: source.conversationId,
    occurred_at: source.occurredAt.toISOString(), id: source.id
  }));
  if (first.length === 0) return [];
  const rows = await database<Array<{
    id: string; source_principal: string; conversation_id: string;
    occurred_at: Date; content: string; role: "user";
  }>>`
    SELECT i.* FROM jsonb_to_recordset(${database.json(first)}::jsonb)
      AS anchor(principal text, conversation uuid, occurred_at timestamptz, id uuid)
    CROSS JOIN LATERAL (
      SELECT i.id, i.source_principal, i.conversation_id, i.occurred_at, i.content, i.role
      FROM interactions i
      WHERE i.source_principal = anchor.principal AND i.conversation_id = anchor.conversation
        AND i.role = 'user' AND (i.occurred_at, i.id) < (anchor.occurred_at, anchor.id)
      ORDER BY i.occurred_at DESC, i.id DESC LIMIT ${recordsPerConversation}
    ) i`;
  return selectPriorConversationContext(sources, rows.map(row => ({
    id: row.id, sourcePrincipal: row.source_principal, conversationId: row.conversation_id,
    occurredAt: row.occurred_at, content: row.content, role: row.role, kind: "interaction" as const
  })));
}
