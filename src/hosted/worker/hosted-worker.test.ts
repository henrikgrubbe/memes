import { Deferred, Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../shared/config.js";
import { makeProvidersLayer } from "../../shared/providers.js";
import type {
  CompletedDeliveryState,
  DeliveryState,
  HostedGitHubRepository,
} from "./hosted-github.js";
import type { SlackSender } from "./hosted-notifier.js";
import { runHostedTask } from "./hosted-worker.js";

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

  return { events: () => events, repository, slack };
};

describe("hosted worker orchestration", () => {
  it("publishes the image before notifying while the saga updates concurrently", async () => {
    const harness = makeHarness();
    let providerPrompt = "";
    const slackPosted = await Effect.runPromise(Deferred.make<void>());
    const providers = makeProvidersLayer({
      OpenAI: (prompt) =>
        Effect.sync(() => {
          providerPrompt = prompt;
          return {
            buffer: Buffer.from("image"),
            history: [{ provider: "OpenAI", status: "success" as const }],
          };
        }),
    });

    const result = await Effect.runPromise(
      runHostedTask(task, config, {
        compressSaga: (_saga, canon, prompt) =>
          Deferred.await(slackPosted).pipe(Effect.as(`${canon}\n- ${prompt}`)),
        repository: harness.repository,
        slack: {
          post: (payload) =>
            harness.slack
              .post(payload)
              .pipe(
                Effect.zipRight(Deferred.succeed(slackPosted, undefined)),
                Effect.asVoid,
              ),
        },
      }).pipe(Effect.provide(providers)),
    );

    expect(result).toBe("processed");
    expect(providerPrompt).toContain("Existing canon");
    expect(harness.events()).toEqual([
      "github:complete:memes/meme-1.jpg:saga-pending",
      "slack:post",
      "github:comment",
      "github:close",
      "github:saga:context/story.md:Existing canon\n- A functional meme",
    ]);
  });

  it("resumes completion without calling the provider or Slack twice", async () => {
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
      slack: "claimed",
      status: "completed",
      version: 1,
    };
    const harness = makeHarness(completed);
    let providerCalls = 0;
    const providers = makeProvidersLayer({
      OpenAI: () =>
        Effect.sync(() => {
          providerCalls += 1;
          return {
            buffer: Buffer.from("image"),
            history: [{ provider: "OpenAI", status: "success" as const }],
          };
        }),
    });

    const result = await Effect.runPromise(
      runHostedTask(task, config, {
        compressSaga: (_saga, canon) => Effect.succeed(canon),
        repository: harness.repository,
        slack: harness.slack,
      }).pipe(Effect.provide(providers)),
    );

    expect(result).toBe("resumed");
    expect(providerCalls).toBe(0);
    expect(harness.events()).toEqual(["github:comment", "github:close"]);
  });
});
