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
import type {
  CompletedDeliveryState,
  DeliveryState,
  HostedGitHubRepository,
} from "./hosted-github.js";
import { HostedGitHubError } from "./hosted-github.js";
import type { SlackSender } from "./hosted-notifier.js";
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

interface Harness {
  readonly currentState: () => DeliveryState | null;
  readonly events: () => ReadonlyArray<string>;
  readonly repository: HostedGitHubRepository;
  readonly slack: SlackSender;
}

const makeHarness = (initialState: DeliveryState | null = null): Harness => {
  let events: ReadonlyArray<string> = [];
  let state = initialState;
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
    complete: (plan) =>
      Effect.sync(() => {
        if (state?.status === "completed") {
          return state;
        }
        record(
          `github:complete:${plan.files?.map(({ path }) => path).join(",") ?? ""}:${plan.sagaPending ? "saga-pending" : ""}`,
        );
        const completed: CompletedDeliveryState = {
          deliveryId: task.deliveryId,
          issueNumber: task.issueNumber,
          memeId: "meme-1",
          outcome: plan.outcome,
          repo: task.repo,
          ...(plan.sagaPending ? { saga: "pending" as const } : {}),
          status: "completed",
          version: 1,
        };
        state = completed;
        return completed;
      }),
    contributeSaga: (plan) =>
      Effect.gen(function* () {
        if (state?.status === "completed" && state.saga !== "pending") {
          return false;
        }
        const saga = yield* plan.saga.derive("Existing canon");
        record(`github:saga:${plan.saga.path}:${saga}`);
        state = {
          deliveryId: task.deliveryId,
          issueNumber: task.issueNumber,
          memeId: "meme-1",
          outcome: plan.outcome,
          repo: task.repo,
          saga: "completed",
          status: "completed",
          version: 1,
        };
        return true;
      }),
    getDelivery: () => Effect.succeed(state),
    memeId: "meme-1",
    readText: () => Effect.succeed("Existing canon"),
  };
  const slack: SlackSender = {
    post: () =>
      Effect.sync(() => {
        record("slack:post");
      }),
  };

  return {
    currentState: () => state,
    events: () => events,
    repository,
    slack,
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

  it("processes a plain success without Saga work", async () => {
    const harness = makeHarness();
    let providerPrompt = "";
    const result = await Effect.runPromise(
      runHostedTask(
        task,
        { ...config, readSaga: null, writeSaga: null },
        {
          compressSaga: (_saga, canon) => Effect.succeed(canon),
          repository: harness.repository,
          slack: harness.slack,
        },
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
      "github:complete:memes/meme-1.jpg:",
      "slack:post",
      "github:comment",
      "github:close",
    ]);
    expect(harness.currentState()).toMatchObject({
      outcome: { kind: "success" },
      status: "completed",
    });
  });

  it("processes a write-only Saga without calling an image provider", async () => {
    const harness = makeHarness();
    let providerCalls = 0;
    const result = await Effect.runPromise(
      runHostedTask(
        task,
        { ...config, readSaga: null },
        {
          compressSaga: (_saga, canon, prompt) =>
            Effect.succeed(`${canon}\n- ${prompt}`),
          repository: harness.repository,
          slack: harness.slack,
        },
      ).pipe(
        Effect.provide(
          successProviders(() => {
            providerCalls += 1;
          }),
        ),
      ),
    );

    expect(result).toBe("processed");
    expect(providerCalls).toBe(0);
    expect(harness.events()).toEqual([
      "github:saga:context/story.md:Existing canon\n- A functional meme",
      "slack:post",
      "github:comment",
      "github:close",
    ]);
    expect(harness.currentState()).toMatchObject({
      outcome: { kind: "saga-updated", updated: true },
      saga: "completed",
    });
  });

  it("resumes a pending Saga without regenerating the image", async () => {
    const completed: CompletedDeliveryState = {
      deliveryId: task.deliveryId,
      issueNumber: task.issueNumber,
      memeId: "meme-1",
      outcome: {
        history: [{ provider: "OpenAI", status: "success" }],
        kind: "success",
        memeId: "meme-1",
        prompt: config.memePrompt,
        provider: "OpenAI",
      },
      repo: task.repo,
      saga: "pending",
      status: "completed",
      version: 1,
    };
    const harness = makeHarness(completed);
    let providerCalls = 0;

    const result = await Effect.runPromise(
      runHostedTask(task, config, {
        compressSaga: (_saga, canon, prompt) =>
          Effect.succeed(`${canon}\n- ${prompt}`),
        repository: harness.repository,
        slack: harness.slack,
      }).pipe(
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
      "github:saga:context/story.md:Existing canon\n- A functional meme",
      "slack:post",
      "github:comment",
      "github:close",
    ]);
    expect(harness.currentState()).toMatchObject({ saga: "completed" });
  });

  it("does not regenerate or reapply Saga for an already completed delivery", async () => {
    const completed: CompletedDeliveryState = {
      deliveryId: task.deliveryId,
      issueNumber: task.issueNumber,
      memeId: "meme-1",
      outcome: {
        history: [{ provider: "OpenAI", status: "success" }],
        kind: "success",
        memeId: "meme-1",
        prompt: config.memePrompt,
        provider: "OpenAI",
      },
      repo: task.repo,
      saga: "completed",
      status: "completed",
      version: 1,
    };
    const harness = makeHarness(completed);
    let providerCalls = 0;

    const result = await Effect.runPromise(
      runHostedTask(task, config, {
        compressSaga: (_saga, canon) => Effect.succeed(canon),
        repository: harness.repository,
        slack: harness.slack,
      }).pipe(
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
      "slack:post",
      "github:comment",
      "github:close",
    ]);
  });

  it("persists and notifies a moderation failure as terminal", async () => {
    const harness = makeHarness();
    const providers = makeProvidersLayer({
      OpenAI: () =>
        Effect.fail(
          new ModerationBlockedError({
            detail: "unsafe",
            provider: "OpenAI",
          }),
        ),
    });

    const result = await Effect.runPromise(
      runHostedTask(
        task,
        { ...config, readSaga: null, writeSaga: null },
        {
          compressSaga: (_saga, canon) => Effect.succeed(canon),
          repository: harness.repository,
          slack: harness.slack,
        },
      ).pipe(Effect.provide(providers)),
    );

    expect(result).toBe("processed");
    expect(harness.currentState()).toMatchObject({
      outcome: {
        closeNotPlanned: true,
        kind: "failure",
      },
    });
    expect(harness.events()).toEqual([
      "github:complete::",
      "slack:post",
      "github:comment",
      "github:close",
    ]);
  });

  it("persists and notifies an exhausted provider failure as terminal", async () => {
    const harness = makeHarness();
    const providers = makeProvidersLayer({
      OpenAI: () =>
        Effect.fail(
          new ProviderError({
            detail: "provider unavailable",
            provider: "OpenAI",
          }),
        ),
    });

    const result = await Effect.runPromise(
      runHostedTask(
        task,
        { ...config, readSaga: null, writeSaga: null },
        {
          compressSaga: (_saga, canon) => Effect.succeed(canon),
          repository: harness.repository,
          slack: harness.slack,
        },
      ).pipe(Effect.provide(providers)),
    );

    expect(result).toBe("processed");
    expect(harness.currentState()).toMatchObject({
      outcome: {
        closeNotPlanned: false,
        kind: "failure",
      },
    });
    expect(harness.events()).toEqual([
      "github:complete::",
      "slack:post",
      "github:comment",
    ]);
  });

  it("lets Saga persistence finish when Slack fails quickly", async () => {
    const harness = makeHarness();
    const slackFailed = await Effect.runPromise(Deferred.make<void>());
    const exit = await Effect.runPromise(
      runHostedTask(task, config, {
        compressSaga: (_saga, canon, prompt) =>
          Deferred.await(slackFailed).pipe(Effect.as(`${canon}\n- ${prompt}`)),
        repository: harness.repository,
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
      }).pipe(Effect.provide(successProviders()), Effect.exit),
    );

    expect(failureOfType(exit, NotificationError).message).toContain(
      "Slack unavailable",
    );
    expect(harness.events()).toContain(
      "github:saga:context/story.md:Existing canon\n- A functional meme",
    );
    expect(harness.currentState()).toMatchObject({ saga: "completed" });
  });

  it("lets notification finish when Saga persistence fails quickly", async () => {
    const harness = makeHarness();
    const sagaFailed = await Effect.runPromise(Deferred.make<void>());
    const sagaError = new HostedGitHubError({
      detail: "Saga persistence unavailable",
      operation: "contribute saga",
    });
    const repository: HostedGitHubRepository = {
      ...harness.repository,
      contributeSaga: () =>
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
        compressSaga: (_saga, canon) => Effect.succeed(canon),
        repository,
        slack,
      }).pipe(Effect.provide(successProviders()), Effect.exit),
    );

    expect(failureOfType(exit, HostedGitHubError)).toBe(sagaError);
    expect(harness.events()).toEqual([
      "github:complete:memes/meme-1.jpg:saga-pending",
      "slack:post",
      "github:comment",
      "github:close",
    ]);
    expect(harness.currentState()).toMatchObject({ saga: "pending" });
  });
});
