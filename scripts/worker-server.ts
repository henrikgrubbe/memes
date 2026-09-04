import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Cause, Config, Context, Effect, Layer, Option } from "effect";
import { makeRequestAppConfig } from "./config.js";
import { type MemeRequestTask } from "./github-webhook.js";
import { makeGitHubApi, makeHostedGitHubRepository } from "./hosted-github.js";
import { makeSlackSender } from "./hosted-notifier.js";
import { runHostedTask, type HostedTaskResult } from "./hosted-worker.js";
import { ProvidersLayer } from "./providers.js";
import { makeSagaCompressor } from "./saga.js";
import {
  decodeScalewayQueueRequest,
  WorkerMessageError,
} from "./worker-transport.js";

interface WorkerRuntimeConfig {
  readonly githubApiUrl: string;
  readonly githubToken: string;
  readonly openAiApiKey: string | null;
  readonly slackWebhookUrl: string;
  readonly targetBranch: string;
}

interface WorkerProcessor {
  readonly process: (
    task: MemeRequestTask,
  ) => Effect.Effect<HostedTaskResult, unknown>;
}

export class WorkerProcessorTag extends Context.Tag("WorkerProcessor")<
  WorkerProcessorTag,
  WorkerProcessor
>() {}

const WorkerConfig = Config.all({
  githubApiUrl: Config.string("GITHUB_API_URL").pipe(
    Config.withDefault("https://api.github.com"),
  ),
  githubToken: Config.string("GITHUB_FINE_GRAINED_PAT"),
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

const WorkerProcessorLive = Layer.effect(
  WorkerProcessorTag,
  Effect.gen(function* () {
    const runtime = yield* WorkerRuntimeConfigTag;
    const api = makeGitHubApi({
      baseUrl: runtime.githubApiUrl,
      token: runtime.githubToken,
    });
    const slack = makeSlackSender({
      webhookUrl: runtime.slackWebhookUrl,
    });
    const compressSaga = makeSagaCompressor(runtime.openAiApiKey);

    return {
      process: (task) =>
        makeRequestAppConfig({
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
          Effect.flatMap((config) =>
            runHostedTask(task, config, {
              compressSaga,
              repository: makeHostedGitHubRepository({
                api,
                branch: runtime.targetBranch,
                task,
              }),
              slack,
            }),
          ),
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
): Effect.Effect<WorkerHttpResult, never, WorkerProcessorTag> =>
  decodeScalewayQueueRequest(requestBody).pipe(
    Effect.matchEffect({
      onFailure: (error) => Effect.succeed(terminalMessage(error)),
      onSuccess: (task) =>
        WorkerProcessorTag.pipe(
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

const workerRequest = HttpServerRequest.HttpServerRequest.pipe(
  Effect.flatMap((request) => request.text),
  Effect.flatMap(handleWorkerRequest),
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

const ApiLive = router.pipe(
  HttpServer.serve(),
  Layer.provide(ProcessorLive),
  Layer.provide(ServerLive),
);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  NodeRuntime.runMain(Layer.launch(ApiLive));
}
