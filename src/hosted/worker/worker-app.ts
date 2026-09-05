import { createServer } from "node:http";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Cause, Config, Context, Effect, Layer, Option } from "effect";
import type { ConfigError } from "effect/ConfigError";
import { makeRequestAppConfig } from "../../shared/config.js";
import { ProvidersLayer } from "../../shared/providers.js";
import { makeSagaCompressor } from "../../shared/saga.js";
import type { MemeRequestTask } from "../task.js";
import { makeGitHubApi, makeHostedGitHubRepository } from "./hosted-github.js";
import { makeSlackSender } from "./hosted-notifier.js";
import {
  makeHostedObjectStorage,
  makeS3ObjectStorageApi,
} from "./hosted-object-storage.js";
import {
  runHostedTask,
  type HostedTaskError,
  type HostedTaskResult,
} from "./hosted-worker.js";
import {
  decodeScalewayQueueRequest,
  WorkerMessageError,
} from "./worker-transport.js";

interface WorkerRuntimeConfig {
  readonly githubApiUrl: string;
  readonly githubRepository: string;
  readonly githubToken: string;
  readonly objectStorageAccessKey: string;
  readonly objectStorageBucket: string;
  readonly objectStorageEndpoint: string;
  readonly objectStoragePublicBaseUrl: string;
  readonly objectStorageRegion: string;
  readonly objectStorageSecretKey: string;
  readonly openAiApiKey: string | null;
  readonly slackWebhookUrl: string;
  readonly targetBranch: string;
}

export type WorkerProcessingError =
  ConfigError | HostedTaskError | WorkerMessageError;

interface WorkerProcessor {
  readonly process: (
    task: MemeRequestTask,
  ) => Effect.Effect<HostedTaskResult, WorkerProcessingError>;
}

export type WorkerMode = "diagnostic" | "live";
export type WorkerDiagnosticResponse = "retry" | "success";

export interface WorkerRequestPolicy {
  readonly diagnosticResponse: WorkerDiagnosticResponse;
  readonly mode: WorkerMode;
}

export class WorkerProcessorTag extends Context.Tag("WorkerProcessor")<
  WorkerProcessorTag,
  WorkerProcessor
>() {}

class WorkerRequestPolicyTag extends Context.Tag("WorkerRequestPolicy")<
  WorkerRequestPolicyTag,
  WorkerRequestPolicy
>() {}

const WorkerConfig = Config.all({
  githubApiUrl: Config.string("GITHUB_API_URL").pipe(
    Config.withDefault("https://api.github.com"),
  ),
  githubRepository: Config.string("GITHUB_REPOSITORY"),
  githubToken: Config.string("GITHUB_FINE_GRAINED_PAT"),
  objectStorageAccessKey: Config.string("OBJECT_STORAGE_ACCESS_KEY"),
  objectStorageBucket: Config.string("OBJECT_STORAGE_BUCKET"),
  objectStorageEndpoint: Config.string("OBJECT_STORAGE_ENDPOINT"),
  objectStoragePublicBaseUrl: Config.string("OBJECT_STORAGE_PUBLIC_BASE_URL"),
  objectStorageRegion: Config.string("OBJECT_STORAGE_REGION"),
  objectStorageSecretKey: Config.string("OBJECT_STORAGE_SECRET_KEY"),
  openAiApiKey: Config.option(Config.string("OPENAI_API_KEY")),
  slackWebhookUrl: Config.string("SLACK_WEBHOOK_URL"),
  targetBranch: Config.string("GITHUB_TARGET_BRANCH").pipe(
    Config.withDefault("main"),
  ),
});

const WorkerRuntimeConfigTag = Context.GenericTag<WorkerRuntimeConfig>(
  "WorkerRuntimeConfig",
);

const WorkerConfigLive = Layer.effect(
  WorkerRuntimeConfigTag,
  WorkerConfig.pipe(
    Effect.map((config) => ({
      ...config,
      openAiApiKey: Option.getOrNull(config.openAiApiKey),
    })),
  ),
);

const WorkerRequestPolicyLive = Layer.effect(
  WorkerRequestPolicyTag,
  Config.all({
    diagnosticResponse: Config.literal(
      "success",
      "retry",
    )("WORKER_DIAGNOSTIC_RESPONSE").pipe(Config.withDefault("success")),
    mode: Config.literal(
      "diagnostic",
      "live",
    )("WORKER_MODE").pipe(Config.withDefault("diagnostic")),
  }),
);

const WorkerProcessorLive = Layer.effect(
  WorkerProcessorTag,
  Effect.gen(function* () {
    const runtime = yield* WorkerRuntimeConfigTag;
    const api = makeGitHubApi({
      baseUrl: runtime.githubApiUrl,
      token: runtime.githubToken,
    });
    const storageApi = makeS3ObjectStorageApi({
      accessKeyId: runtime.objectStorageAccessKey,
      endpoint: runtime.objectStorageEndpoint,
      region: runtime.objectStorageRegion,
      secretAccessKey: runtime.objectStorageSecretKey,
    });
    const slack = makeSlackSender({
      webhookUrl: runtime.slackWebhookUrl,
    });
    const compressSaga = makeSagaCompressor(runtime.openAiApiKey);

    return {
      process: (task) =>
        task.repo !== runtime.githubRepository
          ? Effect.fail(
              new WorkerMessageError({
                detail: "Queued task repository is not allowed",
              }),
            )
          : makeRequestAppConfig({
              issueBody: task.issueBody,
              issueNumber: task.issueNumber,
              repo: task.repo,
              slackWebhookUrl: runtime.slackWebhookUrl,
            }).pipe(
              Effect.mapError(
                () =>
                  new WorkerMessageError({
                    detail: "Queued issue body is invalid",
                  }),
              ),
              Effect.flatMap((config) => {
                const repository = makeHostedGitHubRepository({
                  api,
                  branch: runtime.targetBranch,
                  task,
                });
                return runHostedTask(task, config, {
                  compressSaga,
                  repository,
                  slack,
                  storage: makeHostedObjectStorage({
                    api: storageApi,
                    bucket: runtime.objectStorageBucket,
                    deliveryId: task.deliveryId,
                    memeId: repository.memeId,
                    publicBaseUrl: runtime.objectStoragePublicBaseUrl,
                  }),
                });
              }),
              Effect.provide(ProvidersLayer),
            ),
    } satisfies WorkerProcessor;
  }),
);

export interface WorkerHttpResult {
  readonly body: Readonly<Record<string, string>>;
  readonly status: 200 | 503;
}

const terminalMessage = (error: WorkerMessageError): WorkerHttpResult => ({
  body: { disposition: "rejected", error: error.message },
  status: 200,
});

export const handleWorkerRequest = (
  requestBody: string,
  policy: WorkerRequestPolicy,
): Effect.Effect<WorkerHttpResult, never, WorkerProcessorTag> =>
  decodeScalewayQueueRequest(requestBody).pipe(
    Effect.matchEffect({
      onFailure: (error) => Effect.succeed(terminalMessage(error)),
      onSuccess: (task) => {
        if (policy.mode === "diagnostic") {
          return Effect.log(
            `Diagnostic queue delivery for ${task.repo}#${task.issueNumber} (${task.deliveryId}); body omitted`,
          ).pipe(
            Effect.as(
              policy.diagnosticResponse === "retry"
                ? ({
                    body: { disposition: "diagnostic-retry" },
                    status: 503,
                  } satisfies WorkerHttpResult)
                : ({
                    body: { disposition: "diagnostic-acknowledged" },
                    status: 200,
                  } satisfies WorkerHttpResult),
            ),
          );
        }
        return WorkerProcessorTag.pipe(
          Effect.flatMap((processor) => processor.process(task)),
          Effect.match({
            onFailure: (error) =>
              error instanceof WorkerMessageError
                ? terminalMessage(error)
                : ({
                    body: { disposition: "retry" },
                    status: 503,
                  } satisfies WorkerHttpResult),
            onSuccess: (disposition) =>
              ({
                body: { disposition },
                status: 200 as const,
              }) satisfies WorkerHttpResult,
          }),
        );
      },
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

const workerRequest = HttpServerRequest.HttpServerRequest.pipe(
  Effect.flatMap((request) => request.text),
  Effect.flatMap((body) =>
    WorkerRequestPolicyTag.pipe(
      Effect.flatMap((policy) => handleWorkerRequest(body, policy)),
    ),
  ),
  Effect.map((result) =>
    HttpServerResponse.unsafeJson(result.body, { status: result.status }),
  ),
);

const router = HttpRouter.empty.pipe(
  HttpRouter.get("/health", HttpServerResponse.unsafeJson({ status: "ok" })),
  HttpRouter.post("/", workerRequest),
  HttpRouter.post("/queue", workerRequest),
);

const ServerLive = NodeHttpServer.layerConfig(() => createServer(), {
  port: Config.integer("PORT").pipe(Config.withDefault(8080)),
});

const ProcessorLive = WorkerProcessorLive.pipe(Layer.provide(WorkerConfigLive));

export const WorkerApiLive = router.pipe(
  HttpServer.serve(),
  Layer.provide(ProcessorLive),
  Layer.provide(WorkerRequestPolicyLive),
  Layer.provide(ServerLive),
);
