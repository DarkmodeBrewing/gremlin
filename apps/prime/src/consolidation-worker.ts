import type { FastifyBaseLogger } from "fastify";

import {
  consolidateSources,
  ConsolidationExecutionError,
  type BackgroundConsolidationOptions,
  type ConsolidationDependencies,
  type ConsolidationResult
} from "./consolidation.js";

export type ConsolidationWorkerOptions = BackgroundConsolidationOptions &
  Readonly<{
    pollIntervalMilliseconds: number;
    principalId: string;
  }>;

type WorkerLogger = Pick<FastifyBaseLogger, "error" | "info">;

export async function validateConsolidationWorkerPrincipal(
  dependencies: ConsolidationDependencies,
  principalId: string
): Promise<void> {
  const rows = await dependencies.database<Array<{
    active: boolean;
    can_consolidate: boolean;
  }>>`
    SELECT active, can_consolidate
    FROM principals
    WHERE principal_id = ${principalId}
    LIMIT 1
  `;
  const principal = rows[0];

  if (principal === undefined || !principal.active || !principal.can_consolidate) {
    throw new Error(
      `Background consolidation principal ${principalId} must exist, be active, and have can_consolidate`
    );
  }
}

export async function runBackgroundConsolidationOnce(
  dependencies: ConsolidationDependencies,
  options: ConsolidationWorkerOptions,
  logger: WorkerLogger
): Promise<ConsolidationResult | null> {
  const startedAt = Date.now();

  try {
    await validateConsolidationWorkerPrincipal(
      dependencies,
      options.principalId
    );
    const result = await consolidateSources(
      dependencies,
      options.principalId,
      "background",
      options
    );

    if (result !== null) {
      logger.info(
        {
          durationMilliseconds: Date.now() - startedAt,
          memoryCount: result.memoryCount,
          operation: "consolidation.background",
          runId: result.runId,
          sourceCount: result.sourceCount,
          status: result.status,
          triggerKind: "background"
        },
        "Background consolidation completed"
      );
    }

    return result;
  } catch (error: unknown) {
    if (error instanceof ConsolidationExecutionError) {
      logger.error(
        {
          durationMilliseconds: Date.now() - startedAt,
          errorCode: error.code,
          operation: "consolidation.background",
          runId: error.runId,
          status: "failed",
          triggerKind: "background"
        },
        "Background consolidation failed"
      );
      return null;
    }

    logger.error(
      {
        err: error,
        durationMilliseconds: Date.now() - startedAt,
        operation: "consolidation.background",
        status: "failed",
        triggerKind: "background"
      },
      "Background consolidation tick failed"
    );
    return null;
  }
}

export function startConsolidationWorker(
  dependencies: ConsolidationDependencies,
  options: ConsolidationWorkerOptions,
  logger: WorkerLogger
): Readonly<{ stop: () => void }> {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), options.pollIntervalMilliseconds);
    timer.unref();
  };
  const tick = async (): Promise<void> => {
    if (stopped) return;
    await runBackgroundConsolidationOnce(dependencies, options, logger);
    schedule();
  };

  void tick();

  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}
