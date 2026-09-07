import { createServer } from "node:http";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Config, Context, Effect, Layer, Option } from "effect";
import { ProvidersLayer } from "../../shared/providers.js";
import { makeSagaCompressor } from "../../shared/saga.js";
import { makeGitHubApi, makeHostedGitHubRepository } from "./hosted-github.js";
import { makeSlackSender } from "./hosted-notifier.js";
import {
  makeHostedObjectStorage,
  makeS3ObjectStorageApi,
} from "./hosted-object-storage.js";
import { runHostedTask } from "./hosted-worker.js";
import {
  handleWorkerRequest,
  makeWorkerTaskConfig,
  type WorkerProcessor,
  WorkerProcessorTag,
} from "./worker-handler.js";

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
        makeWorkerTaskConfig(task, runtime.githubRepository).pipe(
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

const workerRequest = HttpServerRequest.HttpServerRequest.pipe(
  Effect.flatMap((request) => request.text),
  Effect.flatMap(handleWorkerRequest),
  Effect.map((result) =>
    HttpServerResponse.unsafeJson(result.body, { status: result.status }),
  ),
);

const router = HttpRouter.empty.pipe(
  HttpRouter.get("/health", HttpServerResponse.unsafeJson({ status: "ok" })),
  HttpRouter.post("/queue", workerRequest),
);

const ServerLive = NodeHttpServer.layerConfig(() => createServer(), {
  port: Config.integer("PORT").pipe(Config.withDefault(8080)),
});

const ProcessorLive = WorkerProcessorLive.pipe(Layer.provide(WorkerConfigLive));

export const WorkerApiLive = router.pipe(
  HttpServer.serve(),
  Layer.provide(ProcessorLive),
  Layer.provide(ServerLive),
);
