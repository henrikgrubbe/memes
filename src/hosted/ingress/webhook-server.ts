import { createServer } from "node:http";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Config, Context, Effect, Layer } from "effect";
import {
  handleGitHubWebhook,
  type HostedIngressMode,
} from "./github-webhook.js";
import { ScalewayQueueLive } from "./scaleway-queue.js";

class WebhookSecret extends Context.Tag("WebhookSecret")<
  WebhookSecret,
  string
>() {}

class WebhookMode extends Context.Tag("WebhookMode")<
  WebhookMode,
  HostedIngressMode
>() {}

const WebhookSecretLive = Layer.effect(
  WebhookSecret,
  Config.string("GITHUB_WEBHOOK_SECRET"),
);

const WebhookModeLive = Layer.effect(
  WebhookMode,
  Config.literal(
    "off",
    "canary",
    "live",
  )("HOSTED_INGRESS_MODE").pipe(Config.withDefault("off")),
);

const githubWebhook = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body = yield* request.text;
  const secret = yield* WebhookSecret;
  const mode = yield* WebhookMode;
  const result = yield* handleGitHubWebhook(secret, mode, {
    body,
    deliveryId: request.headers["x-github-delivery"],
    event: request.headers["x-github-event"],
    signature: request.headers["x-hub-signature-256"],
  }).pipe(
    Effect.catchTags({
      WebhookRequestError: (error) =>
        Effect.succeed(
          HttpServerResponse.unsafeJson(
            { error: error.message },
            { status: error.status },
          ),
        ),
      WebhookQueueError: (error) =>
        Effect.succeed(
          HttpServerResponse.unsafeJson(
            { error: error.message },
            { status: 503 },
          ),
        ),
    }),
  );

  return HttpServerResponse.isServerResponse(result)
    ? result
    : HttpServerResponse.unsafeJson(result, { status: result.status });
});

const router = HttpRouter.empty.pipe(
  HttpRouter.get("/health", HttpServerResponse.unsafeJson({ status: "ok" })),
  HttpRouter.post("/webhooks/github", githubWebhook),
);

const ServerLive = NodeHttpServer.layerConfig(() => createServer(), {
  port: Config.integer("PORT").pipe(Config.withDefault(8080)),
});

const ApiLive = router.pipe(
  HttpServer.serve(),
  Layer.provide(
    Layer.mergeAll(ScalewayQueueLive, WebhookSecretLive, WebhookModeLive),
  ),
  Layer.provide(ServerLive),
);

NodeRuntime.runMain(Layer.launch(ApiLive));
