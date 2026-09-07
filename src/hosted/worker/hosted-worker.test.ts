import { Deferred, Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ModerationBlockedError,
  NotificationError,
} from "../../shared/errors.js";
import {
  makeProvidersLayer,
  ProvidersServiceTag,
} from "../../shared/providers.js";
import type {
  DeliveryOutcome,
  SuccessDeliveryOutcome,
} from "./hosted-delivery.js";
import {
  HostedGitHubError,
  type HostedGitHubRepository,
} from "./hosted-github.js";
import type { SlackSender } from "./hosted-notifier.js";
import type {
  DeliveryReceiptStore,
  PublishImagePlan,
  RecordFailurePlan,
} from "./hosted-object-storage.js";
import { makeQueuedDeliveryHandler } from "./hosted-worker.js";

const encode = Schema.encodeSync(Schema.parseJson(Schema.Unknown));

const taskFor = (
  message: string,
  overrides: Readonly<Record<string, unknown>> = {},
) => ({
  deliveryId: "delivery-1",
  issueBody: `sender: U123\nmessage: ${message}\nchannel: C123\nlink: https://example.test/thread`,
  issueNumber: "42",
  repo: "owner/repo",
  ...overrides,
});

const requestFor = (task: Readonly<Record<string, unknown>>): string =>
  encode(task);

const storedSuccess: DeliveryOutcome = {
  history: [{ provider: "OpenAI", status: "success" }],
  imageUrl: "https://images.example/memes/meme-1.jpg",
  kind: "success",
  memeId: "meme-1",
  prompt: "A functional meme",
  provider: "OpenAI",
};

type StoredOutcome = Exclude<
  DeliveryOutcome,
  { readonly kind: "saga-updated" }
>;

interface Harness {
  readonly comments: () => ReadonlyArray<string>;
  readonly currentOutcome: () => StoredOutcome | null;
  readonly events: () => ReadonlyArray<string>;
  readonly repository: HostedGitHubRepository;
  readonly slack: SlackSender;
  readonly storage: DeliveryReceiptStore;
}

const makeHarness = (
  initialOutcome: StoredOutcome | null = null,
  initialSagaFolded = false,
): Harness => {
  let comments: ReadonlyArray<string> = [];
  let events: ReadonlyArray<string> = [];
  let outcome = initialOutcome;
  let sagaFolded = initialSagaFolded;
  const record = (event: string) => {
    events = [...events, event];
  };
  const repository: HostedGitHubRepository = {
    branch: "main",
    closeIssue: () =>
      Effect.sync(() => {
        record("github:close");
      }),
    commentOnce: (body) =>
      Effect.sync(() => {
        comments = [...comments, body];
        record("github:comment");
      }),
    foldSaga: (plan) =>
      sagaFolded
        ? Effect.succeed(false)
        : Effect.gen(function* () {
            const saga = yield* plan.derive("Existing canon");
            record(`github:saga:${plan.path}:${saga}`);
            sagaFolded = true;
            return true;
          }),
    memeId: "meme-1",
    readText: () => Effect.succeed("Existing canon"),
  };
  const slack: SlackSender = {
    post: () =>
      Effect.sync(() => {
        record("slack:post");
      }),
  };
  function recordDelivery(
    delivery: PublishImagePlan,
  ): Effect.Effect<SuccessDeliveryOutcome>;
  function recordDelivery(
    delivery: RecordFailurePlan,
  ): Effect.Effect<StoredOutcome>;
  function recordDelivery(
    delivery: PublishImagePlan | RecordFailurePlan,
  ): Effect.Effect<StoredOutcome> {
    return Effect.sync(() => {
      if (delivery.kind === "image") {
        record("storage:put-image");
        const published = {
          ...delivery.outcome,
          imageUrl: "https://images.example/memes/meme-1.jpg",
        };
        outcome = published;
        return published;
      }
      record("storage:put-failure");
      outcome = delivery.outcome;
      return delivery.outcome;
    });
  }
  const storage: DeliveryReceiptStore = {
    receiptFor: () =>
      Effect.sync(() => {
        record("storage:get");
        if (outcome != null) {
          return { status: "recorded" as const, outcome };
        }
        return {
          status: "missing" as const,
          record: recordDelivery,
        };
      }),
  };

  return {
    comments: () => comments,
    currentOutcome: () => outcome,
    events: () => events,
    repository,
    slack,
    storage,
  };
};

const successProviders = (
  onGenerate: (prompt: string) => void = () => undefined,
) =>
  makeProvidersLayer({
    OpenAI: (prompt) =>
      Effect.sync(() => {
        onGenerate(prompt);
        return {
          buffer: Buffer.from("image"),
          history: [{ provider: "OpenAI", status: "success" as const }],
        };
      }),
  });

const handlerDependencies = (
  harness: Harness,
  providers = successProviders(),
) => ({
  allowedRepository: "owner/repo",
  compressSaga: (_saga: string, canon: string, prompt: string) =>
    Effect.succeed(`${canon}\n- ${prompt}`),
  providers: ProvidersServiceTag.pipe(Effect.provide(providers)),
  repositoryFor: () => harness.repository,
  slack: harness.slack,
  storageFor: () => harness.storage,
});

describe("hosted queued delivery", () => {
  it("accepts the raw SQS message body Scaleway's queue trigger actually posts, with no wrapping envelope", async () => {
    // Regression for the #975/#976 incident: Scaleway's queue trigger invokes
    // the container with the queue message content as the literal HTTP
    // request body, not wrapped in a `{ body: ... }` envelope. A prior
    // "simplification" assumed such a wrapper existed, silently rejecting
    // every real delivery.
    const harness = makeHarness();
    const handler = makeQueuedDeliveryHandler(
      handlerDependencies(
        harness,
        successProviders(() => undefined),
      ),
    );

    const requestBody = JSON.stringify(taskFor("A functional meme"));
    const result = await Effect.runPromise(handler.handle(requestBody));

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ disposition: "processed" });
  });

  it("publishes a first no-Saga success before notifying", async () => {
    const harness = makeHarness();
    let providerPrompt = "";
    const handler = makeQueuedDeliveryHandler(
      handlerDependencies(
        harness,
        successProviders((prompt) => {
          providerPrompt = prompt;
        }),
      ),
    );

    const result = await Effect.runPromise(
      handler.handle(requestFor(taskFor("A functional meme"))),
    );

    expect(result).toEqual({
      body: { disposition: "processed" },
      status: 200,
    });
    expect(providerPrompt).toBe("A functional meme");
    expect(harness.events()).toEqual([
      "storage:get",
      "storage:put-image",
      "slack:post",
      "github:comment",
      "github:close",
    ]);
    expect(harness.currentOutcome()).toMatchObject({
      imageUrl: "https://images.example/memes/meme-1.jpg",
      kind: "success",
    });
  });

  it("resumes an existing image without calling a provider", async () => {
    const harness = makeHarness(storedSuccess);
    let providerCalls = 0;
    const handler = makeQueuedDeliveryHandler(
      handlerDependencies(
        harness,
        successProviders(() => {
          providerCalls += 1;
        }),
      ),
    );

    const result = await Effect.runPromise(
      handler.handle(requestFor(taskFor("A functional meme"))),
    );

    expect(result.body["disposition"]).toBe("resumed");
    expect(providerCalls).toBe(0);
    expect(harness.events()).toEqual([
      "storage:get",
      "slack:post",
      "github:comment",
      "github:close",
    ]);
  });

  it("publishes and folds a read-and-write Saga delivery", async () => {
    const harness = makeHarness();
    let providerPrompt = "";
    const handler = makeQueuedDeliveryHandler(
      handlerDependencies(
        harness,
        successProviders((prompt) => {
          providerPrompt = prompt;
        }),
      ),
    );

    await Effect.runPromise(
      handler.handle(requestFor(taskFor("saga:story A functional meme"))),
    );

    expect(providerPrompt).toContain("Existing canon");
    expect(harness.events()).toContain("storage:put-image");
    expect(harness.events()).toContain(
      "github:saga:context/story.md:Existing canon\n- A functional meme",
    );
    expect(harness.events()).toContain("slack:post");
    expect(harness.comments()).toHaveLength(1);
    expect(harness.comments()[0]).toContain(
      "**Requested prompt:** `A functional meme`",
    );
    expect(harness.comments()[0]).toContain(
      "<summary><strong>Full generation prompt</strong></summary>",
    );
    expect(harness.comments()[0]).toContain("Existing canon");
  });

  it("processes and resumes a write-only Saga without storage or providers", async () => {
    const harness = makeHarness();
    let providerCalls = 0;
    const handler = makeQueuedDeliveryHandler(
      handlerDependencies(
        harness,
        successProviders(() => {
          providerCalls += 1;
        }),
      ),
    );
    const request = requestFor(taskFor("write:story A functional meme"));

    const first = await Effect.runPromise(handler.handle(request));
    const second = await Effect.runPromise(handler.handle(request));

    expect(first.body["disposition"]).toBe("processed");
    expect(second.body["disposition"]).toBe("resumed");
    expect(providerCalls).toBe(0);
    expect(harness.events().filter((event) => event === "storage:get")).toEqual(
      [],
    );
    expect(
      harness
        .events()
        .filter((event) => event.startsWith("github:saga:context/story.md")),
    ).toHaveLength(1);
  });

  it("persists a terminal failure so a notification retry skips providers", async () => {
    const harness = makeHarness();
    let providerCalls = 0;
    const providers = makeProvidersLayer({
      OpenAI: () =>
        Effect.sync(() => {
          providerCalls += 1;
        }).pipe(
          Effect.zipRight(
            Effect.fail(
              new ModerationBlockedError({
                detail: "unsafe",
                provider: "OpenAI",
              }),
            ),
          ),
        ),
    });
    const handler = makeQueuedDeliveryHandler(
      handlerDependencies(harness, providers),
    );
    const request = requestFor(taskFor("A functional meme"));

    const first = await Effect.runPromise(handler.handle(request));
    const second = await Effect.runPromise(handler.handle(request));

    expect(first.body["disposition"]).toBe("processed");
    expect(second.body["disposition"]).toBe("resumed");
    expect(providerCalls).toBe(1);
    expect(
      harness.events().filter((event) => event === "storage:put-failure"),
    ).toHaveLength(1);
    expect(harness.currentOutcome()).toMatchObject({
      closeNotPlanned: true,
      kind: "failure",
    });
  });

  it("lets Saga persistence finish when Slack fails quickly", async () => {
    const harness = makeHarness();
    const slackFailed = await Effect.runPromise(Deferred.make<void>());
    const dependencies = {
      ...handlerDependencies(harness),
      compressSaga: (_saga: string, canon: string, prompt: string) =>
        Deferred.await(slackFailed).pipe(Effect.as(`${canon}\n- ${prompt}`)),
      slack: {
        post: () =>
          Deferred.succeed(slackFailed, undefined).pipe(
            Effect.zipRight(
              Effect.fail(
                new NotificationError({ detail: "Slack unavailable" }),
              ),
            ),
          ),
      },
    };

    const result = await Effect.runPromise(
      makeQueuedDeliveryHandler(dependencies).handle(
        requestFor(taskFor("saga:story A functional meme")),
      ),
    );

    expect(result.status).toBe(503);
    expect(harness.events()).toContain(
      "github:saga:context/story.md:Existing canon\n- A functional meme",
    );
  });

  it("lets notification finish when Saga persistence fails quickly", async () => {
    const harness = makeHarness();
    const sagaFailed = await Effect.runPromise(Deferred.make<void>());
    const sagaError = new HostedGitHubError({
      detail: "Saga persistence unavailable",
      operation: "fold saga",
    });
    const repository: HostedGitHubRepository = {
      ...harness.repository,
      foldSaga: () =>
        Deferred.succeed(sagaFailed, undefined).pipe(
          Effect.zipRight(Effect.fail(sagaError)),
        ),
    };
    const slack: SlackSender = {
      post: (payload) =>
        Deferred.await(sagaFailed).pipe(
          Effect.zipRight(harness.slack.post(payload)),
        ),
    };
    const dependencies = {
      ...handlerDependencies(harness),
      repositoryFor: () => repository,
      slack,
    };

    const result = await Effect.runPromise(
      makeQueuedDeliveryHandler(dependencies).handle(
        requestFor(taskFor("saga:story A functional meme")),
      ),
    );

    expect(result.status).toBe(503);
    expect(harness.events()).toContain("slack:post");
    expect(harness.events()).toContain("github:comment");
    expect(harness.events()).toContain("github:close");
  });

  it("rejects malformed payloads, invalid task identities, repositories, and issue bodies", async () => {
    const harness = makeHarness();
    const handler = makeQueuedDeliveryHandler(handlerDependencies(harness));
    const invalidRequests = [
      "{",
      requestFor(taskFor("A functional meme", { deliveryId: " " })),
      requestFor(taskFor("A functional meme", { issueNumber: "0" })),
      requestFor(taskFor("A functional meme", { repo: "owner" })),
      requestFor(taskFor("A functional meme", { repo: "another/repository" })),
      requestFor({
        ...taskFor("A functional meme"),
        issueBody: "invalid",
      }),
    ];

    const results = await Promise.all(
      invalidRequests.map((request) =>
        Effect.runPromise(handler.handle(request)),
      ),
    );

    expect(results.every(({ status }) => status === 200)).toBe(true);
    expect(
      results.every(({ body }) => body["disposition"] === "rejected"),
    ).toBe(true);
    expect(harness.events()).toEqual([]);
  });

  it("returns a retryable status for hosted failures and defects", async () => {
    const harness = makeHarness();
    const repository: HostedGitHubRepository = {
      ...harness.repository,
      readText: () =>
        Effect.fail(
          new HostedGitHubError({
            detail: "temporary failure",
            operation: "read saga",
          }),
        ),
    };
    const failed = makeQueuedDeliveryHandler({
      ...handlerDependencies(harness),
      repositoryFor: () => repository,
    });
    const defective = makeQueuedDeliveryHandler({
      ...handlerDependencies(harness),
      providers: Effect.die("unexpected defect"),
    });
    const request = requestFor(taskFor("saga:story A functional meme"));

    const failedResult = await Effect.runPromise(failed.handle(request));
    const defectiveResult = await Effect.runPromise(defective.handle(request));

    expect(failedResult).toEqual({
      body: { disposition: "retry" },
      status: 503,
    });
    expect(defectiveResult).toEqual({
      body: { disposition: "retry" },
      status: 503,
    });
  });
});
