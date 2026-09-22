import { open, mkdir, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

import type { TransactionSql } from "postgres";

import type { Database } from "./database.js";

type JsonValue =
  | null
  | string
  | number
  | boolean
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

type InteractionRow = Readonly<{
  content: string;
  conversation_id: string;
  created_at: Date;
  id: string;
  metadata: Record<string, JsonValue>;
  occurred_at: Date;
  role: "user" | "assistant" | "system" | "tool";
  source_principal: string;
}>;

type EventRow = Readonly<{
  content: string;
  created_at: Date;
  id: string;
  metadata: Record<string, JsonValue>;
  occurred_at: Date;
  source_principal: string;
  type: string;
}>;

type ExportCursor = Readonly<{
  createdAt: Date;
  id: string;
}>;

export type SourceExportResult = Readonly<{
  events: number;
  eventsPath: string;
  interactions: number;
  interactionsPath: string;
}>;

const exportBatchSize = 500;
const interactionsFilename = "interactions.jsonl";
const eventsFilename = "events.jsonl";

async function writeJsonLines(
  file: FileHandle,
  records: readonly Record<string, unknown>[]
): Promise<void> {
  if (records.length === 0) {
    return;
  }

  await file.writeFile(
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
  );
}

async function loadInteractions(
  database: TransactionSql,
  cursor: ExportCursor | null
): Promise<InteractionRow[]> {
  if (cursor === null) {
    return database<InteractionRow[]>`
      SELECT
        id,
        conversation_id,
        occurred_at,
        created_at,
        source_principal,
        role,
        content,
        metadata
      FROM interactions
      ORDER BY created_at, id
      LIMIT ${exportBatchSize}
    `;
  }

  return database<InteractionRow[]>`
    SELECT
      id,
      conversation_id,
      occurred_at,
      created_at,
      source_principal,
      role,
      content,
      metadata
    FROM interactions
    WHERE (created_at, id) > (${cursor.createdAt}, ${cursor.id}::uuid)
    ORDER BY created_at, id
    LIMIT ${exportBatchSize}
  `;
}

async function loadEvents(
  database: TransactionSql,
  cursor: ExportCursor | null
): Promise<EventRow[]> {
  if (cursor === null) {
    return database<EventRow[]>`
      SELECT
        id,
        occurred_at,
        created_at,
        source_principal,
        type,
        content,
        metadata
      FROM events
      ORDER BY created_at, id
      LIMIT ${exportBatchSize}
    `;
  }

  return database<EventRow[]>`
    SELECT
      id,
      occurred_at,
      created_at,
      source_principal,
      type,
      content,
      metadata
    FROM events
    WHERE (created_at, id) > (${cursor.createdAt}, ${cursor.id}::uuid)
    ORDER BY created_at, id
    LIMIT ${exportBatchSize}
  `;
}

async function exportInteractions(
  database: TransactionSql,
  file: FileHandle
): Promise<number> {
  let cursor: ExportCursor | null = null;
  let count = 0;

  while (true) {
    const rows = await loadInteractions(database, cursor);

    await writeJsonLines(
      file,
      rows.map((row) => ({
        schemaVersion: 1,
        id: row.id,
        conversationId: row.conversation_id,
        timestamp: row.occurred_at.toISOString(),
        createdAt: row.created_at.toISOString(),
        sourcePrincipal: row.source_principal,
        role: row.role,
        content: row.content,
        metadata: row.metadata
      }))
    );

    count += rows.length;
    const lastRow = rows.at(-1);

    if (lastRow === undefined || rows.length < exportBatchSize) {
      return count;
    }

    cursor = { createdAt: lastRow.created_at, id: lastRow.id };
  }
}

async function exportEvents(
  database: TransactionSql,
  file: FileHandle
): Promise<number> {
  let cursor: ExportCursor | null = null;
  let count = 0;

  while (true) {
    const rows = await loadEvents(database, cursor);

    await writeJsonLines(
      file,
      rows.map((row) => ({
        schemaVersion: 1,
        id: row.id,
        timestamp: row.occurred_at.toISOString(),
        createdAt: row.created_at.toISOString(),
        sourcePrincipal: row.source_principal,
        type: row.type,
        content: row.content,
        metadata: row.metadata
      }))
    );

    count += rows.length;
    const lastRow = rows.at(-1);

    if (lastRow === undefined || rows.length < exportBatchSize) {
      return count;
    }

    cursor = { createdAt: lastRow.created_at, id: lastRow.id };
  }
}

async function removeIncompleteExport(
  outputDirectory: string,
  paths: readonly string[]
): Promise<void> {
  for (const path of paths) {
    try {
      await unlink(path);
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }

  await rmdir(outputDirectory);
}

export async function exportCanonicalSources(
  database: Database,
  requestedOutputDirectory: string
): Promise<SourceExportResult> {
  const outputDirectory = resolve(requestedOutputDirectory);
  const interactionsPath = resolve(outputDirectory, interactionsFilename);
  const eventsPath = resolve(outputDirectory, eventsFilename);

  // Requiring a new directory prevents an export from overwriting an earlier copy.
  await mkdir(outputDirectory, { mode: 0o700 });

  let interactionsFile: FileHandle | undefined;
  let eventsFile: FileHandle | undefined;

  try {
    interactionsFile = await open(interactionsPath, "wx", 0o600);
    eventsFile = await open(eventsPath, "wx", 0o600);

    const counts = await database.begin(
      "read only isolation level repeatable read",
      async (transaction) => ({
        interactions: await exportInteractions(transaction, interactionsFile!),
        events: await exportEvents(transaction, eventsFile!)
      })
    );

    await interactionsFile.close();
    interactionsFile = undefined;
    await eventsFile.close();
    eventsFile = undefined;

    return {
      ...counts,
      eventsPath,
      interactionsPath
    };
  } catch (error: unknown) {
    await interactionsFile?.close();
    await eventsFile?.close();
    await removeIncompleteExport(outputDirectory, [interactionsPath, eventsPath]);
    throw error;
  }
}
