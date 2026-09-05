import { Deferred, Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../shared/config.js";
import {
  AllProvidersExhaustedError,
  ModerationBlockedError,
  ModerationFailedError,
  NotificationError,
  ProviderError,
  QuotaExhaustedError,
  RateLimitError,
} from "../../shared/errors.js";
import {
  makeProvidersLayer,
  type GenerationError,
} from "../../shared/providers.js";
import { failureOfType } from "../../shared/test-support.js";
import type { DeliveryOutcome } from "./hosted-delivery.js";
import {
  HostedGitHubError,
  type HostedGitHubRepository,
} from "./hosted-github.js";
import type { SlackSender } from "./hosted-notifier.js";
import type { HostedObjectStorage } from "./hosted-object-storage.js";
import {
  classifyHostedGenerationError,
  runHostedTask,
} from "./hosted-worker.js";

const task = {
  deliveryId: "delivery-1",
  issueBody: "unused",
  issueNumber: "42",
  repo: "owner/repo",
};

const config: AppConfig = {
  channel: "C123",
  issueNumber: "42",
  memePrompt: "A functional meme",
  readSaga: "story",
  repo: "owner/repo",
  requester: "U123",
  slackLink: "https://example.test/thread",
  slackWebhookUrl: "https://example.test/hook",
  writeSaga: "story",
};

const storedSuccess: DeliveryOutcome = {
  history: [{ provider: "OpenAI", status: "success" }],
  imageUrl: "https://images.example/memes/meme-1.jpg",
  kind: "success",
  memeId: "meme-1",
  prompt: config.memePrompt,
  provider: "OpenAI",
};

type StoredOutcome = Exclude<
  DeliveryOutcome,
  { readonly kind: "saga-updated" }
>;

interface Harness {
  readonly currentOutcome: () => StoredOutcome | null;
  readonly events: () => ReadonlyArray<string>;
  readonly repository: HostedGitHubRepository;
  readonly slack: SlackSender;
  readonly storage: HostedObjectStorage;
}

const makeHarness = (
  initialOutcome: StoredOutcome | null = null,
  initialSagaFolded = false,
): Harness => {
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
    commentOnce: () =>
      Effect.sync(() => {
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
  const storage: HostedObjectStorage = {
    getOutcome: () =>
      Effect.sync(() => {
        record("storage:get");
        return outcome;
      }),
    publishImage: ({ outcome: generated }) =>
      Effect.sync(() => {
        record("storage:put-image");
        const published = {
          ...generated,
          imageUrl: "https://images.example/memes/meme-1.jpg",
        };
        outcome = published;
        return published;
      }),
    recordTerminalFailure: (_prompt, failure) =>
      Effect.sync(() => {
        record("storage:put-failure");
        if (outcome?.kind === "success") {
          return outcome;
        }
        outcome = failure;
        return failure;
      }),
  };

  return {
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

const dependencies = (harness: Harness) => ({
  compressSaga: (_saga: string, canon: string, prompt: string) =>
    Effect.succeed(`${canon}\n- ${prompt}`),
  repository: harness.repository,
  slack: harness.slack,
  storage: harness.storage,
});

describe("hosted worker orchestration", () => {
  it("classifies every exhausted generation outcome as terminal", () => {
    const errors: ReadonlyArray<GenerationError> = [
      new AllProvidersExhaustedError({ providers: ["OpenAI"] }),
      new ModerationFailedError({
        detail: "blocked",
        fallbackProvider: null,
        provider: "OpenAI",
      }),
      new ProviderError({ detail: "unavailable", provider: "OpenAI" }),
      new QuotaExhaustedError({ detail: "no credits", provider: "OpenAI" }),
      new RateLimitError({ attempts: 10, provider: "OpenAI" }),
    ];

    for (const error of errors) {
      expect(classifyHostedGenerationError(error)).toBe("terminal");
    }
  });

  it("publishes a first no-Saga success before notifying", async () => {
    const harness = makeHarness();
    let providerPrompt = "";

    const result = await Effect.runPromise(
      runHostedTask(
        task,
        { ...config, readSaga: null, writeSaga: null },
        dependencies(harness),
      ).pipe(
        Effect.provide(
          successProviders((prompt) => {
            providerPrompt = prompt;
          }),
        ),
      ),
    );

    expect(result).toBe("processed");
    expect(providerPrompt).toBe(config.memePrompt);
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

    const result = await Effect.runPromise(
      runHostedTask(
        task,
        { ...config, readSaga: null, writeSaga: null },
        dependencies(harness),
      ).pipe(
        Effect.provide(
          successProviders(() => {
            providerCalls += 1;
          }),
        ),
      ),
    );

    expect(result).toBe("resumed");
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

    await Effect.runPromise(
      runHostedTask(task, config, dependencies(harness)).pipe(
        Effect.provide(
          successProviders((prompt) => {
            providerPrompt = prompt;
          }),
        ),
      ),
    );

    expect(providerPrompt).toContain("Existing canon");
    expect(harness.events()).toContain("storage:put-image");
    expect(harness.events()).toContain(
      "github:saga:context/story.md:Existing canon\n- A functional meme",
    );
    expect(harness.events()).toContain("slack:post");
  });

  it("processes and resumes a write-only Saga without storage or providers", async () => {
    const harness = makeHarness();
    let providerCalls = 0;
    const writeOnly = { ...config, readSaga: null };
    const deps = dependencies(harness);

    const first = await Effect.runPromise(
      runHostedTask(task, writeOnly, deps).pipe(
        Effect.provide(
          successProviders(() => {
            providerCalls += 1;
          }),
        ),
      ),
    );
    const second = await Effect.runPromise(
      runHostedTask(task, writeOnly, deps).pipe(
        Effect.provide(
          successProviders(() => {
            providerCalls += 1;
          }),
        ),
      ),
    );

    expect(first).toBe("processed");
    expect(second).toBe("resumed");
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
    const noSaga = { ...config, readSaga: null, writeSaga: null };

    const first = await Effect.runPromise(
      runHostedTask(task, noSaga, dependencies(harness)).pipe(
        Effect.provide(providers),
      ),
    );
    const second = await Effect.runPromise(
      runHostedTask(task, noSaga, dependencies(harness)).pipe(
        Effect.provide(providers),
      ),
    );

    expect(first).toBe("processed");
    expect(second).toBe("resumed");
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
    const deps = {
      ...dependencies(harness),
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

    const exit = await Effect.runPromise(
      runHostedTask(task, config, deps).pipe(
        Effect.provide(successProviders()),
        Effect.exit,
      ),
    );

    expect(failureOfType(exit, NotificationError).message).toContain(
      "Slack unavailable",
    );
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

    const exit = await Effect.runPromise(
      runHostedTask(task, config, {
        ...dependencies(harness),
        repository,
        slack,
      }).pipe(Effect.provide(successProviders()), Effect.exit),
    );

    expect(failureOfType(exit, HostedGitHubError)).toBe(sagaError);
    expect(harness.events()).toContain("slack:post");
    expect(harness.events()).toContain("github:comment");
    expect(harness.events()).toContain("github:close");
  });
});
