import { Cause, Context, Effect } from "effect";
import type { ConfigError } from "effect/ConfigError";
import { type AppConfig, makeRequestAppConfig } from "../../shared/config.js";
import type { MemeRequestTask } from "../task.js";
import type { HostedTaskError, HostedTaskResult } from "./hosted-worker.js";
import {
  decodeScalewayQueueRequest,
  WorkerMessageError,
} from "./worker-transport.js";

export type WorkerProcessingError =
  ConfigError | HostedTaskError | WorkerMessageError;

export interface WorkerProcessor {
  readonly process: (
    task: MemeRequestTask,
  ) => Effect.Effect<HostedTaskResult, WorkerProcessingError>;
}

export class WorkerProcessorTag extends Context.Tag("WorkerProcessor")<
  WorkerProcessorTag,
  WorkerProcessor
>() {}

interface WorkerTaskConfig {
  readonly allowedRepository: string;
  readonly slackWebhookUrl: string;
}

export const makeWorkerTaskConfig = (
  task: MemeRequestTask,
  config: WorkerTaskConfig,
): Effect.Effect<AppConfig, WorkerMessageError> =>
  task.repo !== config.allowedRepository
    ? Effect.fail(
        new WorkerMessageError({
          detail: "Queued task repository is not allowed",
        }),
      )
    : makeRequestAppConfig({
        issueBody: task.issueBody,
        issueNumber: task.issueNumber,
        repo: task.repo,
        slackWebhookUrl: config.slackWebhookUrl,
      }).pipe(
        Effect.mapError(
          () =>
            new WorkerMessageError({
              detail: "Queued issue body is invalid",
            }),
        ),
      );

export interface WorkerHttpResult {
  readonly body: Readonly<Record<string, string>>;
  readonly status: 200 | 503;
}

const terminalMessage = (error: WorkerMessageError): WorkerHttpResult => ({
  body: { disposition: "rejected", error: error.message },
  status: 200,
});

const rejectMessage = (error: WorkerMessageError) =>
  Effect.logWarning(`Rejecting queue delivery: ${error.message}`).pipe(
    Effect.as(terminalMessage(error)),
  );

export const handleWorkerRequest = (
  requestBody: string,
): Effect.Effect<WorkerHttpResult, never, WorkerProcessorTag> =>
  decodeScalewayQueueRequest(requestBody).pipe(
    Effect.matchEffect({
      onFailure: rejectMessage,
      onSuccess: (task) =>
        WorkerProcessorTag.pipe(
          Effect.flatMap((processor) => processor.process(task)),
          Effect.matchEffect({
            onFailure: (error) =>
              error instanceof WorkerMessageError
                ? rejectMessage(error)
                : Effect.succeed({
                    body: { disposition: "retry" },
                    status: 503,
                  } satisfies WorkerHttpResult),
            onSuccess: (disposition) =>
              Effect.succeed({
                body: { disposition },
                status: 200 as const,
              } satisfies WorkerHttpResult),
          }),
        ),
    }),
    Effect.catchAllCause((cause) =>
      Effect.logError(Cause.pretty(cause)).pipe(
        Effect.as({
          body: { disposition: "retry" },
          status: 503,
        } satisfies WorkerHttpResult),
      ),
    ),
  );
