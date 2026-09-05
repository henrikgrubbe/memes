import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { type AppConfig, AppConfigService } from "../shared/config.js";
import { MemePublishError } from "../shared/errors.js";
import { makeMemePublisherLayer } from "../shared/meme-publisher.js";
import { NotifierServiceTag } from "../shared/notifier.js";
import {
  providerErrorProvider,
  successfulProvider,
} from "../shared/provider-test-support.js";
import { makeProvidersLayer, type ProviderFn } from "../shared/providers.js";
import { makeSagaLayer } from "../shared/saga.js";
import { program } from "./generate-meme.js";

const baseConfig: AppConfig = {
  issueNumber: "42",
  repo: "owner/repo",
  slackWebhookUrl: "https://example.test/hook",
  requester: "U123",
  memePrompt: "A typed functional meme",
  channel: "C123",
  slackLink: "https://example.test/thread",
  readSaga: "fp",
  writeSaga: "fp",
};

interface HarnessOptions {
  readonly config?: AppConfig;
  readonly provider?: ProviderFn;
  readonly publishFails?: boolean;
  readonly sagaUpdateSucceeds?: boolean;
}

const runWorkflow = ({
  config = baseConfig,
  provider = successfulProvider("OpenAI"),
  publishFails = false,
  sagaUpdateSucceeds = true,
}: HarnessOptions = {}) => {
  let events: ReadonlyArray<string> = [];
  const record = (event: string) =>
    Effect.sync(() => {
      events = [...events, event];
    });

  const saga = makeSagaLayer({
    read: (name) =>
      record(`saga:read:${name}`).pipe(Effect.as("Existing canon")),
    contribute: (name, prompt) =>
      record(`saga:write:${name}:${prompt}`).pipe(
        Effect.as(sagaUpdateSucceeds),
      ),
  });
  const memePublisher = makeMemePublisherLayer({
    prepare: (issueNumber) =>
      record(`publish:prepare:${issueNumber}`).pipe(
        Effect.as({
          memeId: "meme-1",
          publish: (image: Uint8Array) =>
            record(`publish:image:${Buffer.from(image).toString()}`).pipe(
              Effect.zipRight(
                publishFails
                  ? Effect.fail(
                      new MemePublishError({
                        detail: "Failed to push after 5 attempts",
                      }),
                    )
                  : Effect.void,
              ),
            ),
        }),
      ),
  });
  const notifier = Layer.succeed(NotifierServiceTag, {
    notifySuccess: ({ memeId, prompt }) =>
      record(`notify:success:${memeId}:${prompt}`),
    notifySagaUpdate: ({ saga, contribution, updated }) =>
      record(`notify:saga:${saga}:${updated}:${contribution}`),
    notifyFailure: (message) => record(`notify:failure:${message}`),
  });
  const providers = makeProvidersLayer({
    OpenAI: (prompt, user) =>
      record(`provider:${user}:${prompt}`).pipe(
        Effect.zipRight(provider(prompt, user)),
      ),
  });
  const layer = Layer.mergeAll(
    Layer.succeed(AppConfigService, config),
    saga,
    memePublisher,
    notifier,
    providers,
  );

  return Effect.runPromise(
    program.pipe(Effect.provide(layer), Effect.exit),
  ).then((exit) => ({ events, exit }));
};

describe("meme generation workflow", () => {
  it("reads context, commits the generated image, notifies success, then updates the saga", async () => {
    const { events, exit } = await runWorkflow();

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(events[0]).toBe("saga:read:fp");
    expect(events[1]).toBe("publish:prepare:42");
    expect(events[2]).toBe(
      "provider:U123:Background for continuity:\nExisting canon\n\nCurrent request - depict this now:\nA typed functional meme",
    );
    expect(events[3]).toBe("publish:image:hello");
    expect(events[4]).toBe("notify:success:meme-1:A typed functional meme");
    expect(events[5]).toBe("saga:write:fp:A typed functional meme");
  });

  it("notifies failure without committing when generation fails", async () => {
    const { events, exit } = await runWorkflow({
      provider: providerErrorProvider("OpenAI"),
    });

    expect(Exit.isFailure(exit)).toBe(true);
    expect(events).toContain(
      "provider:U123:Background for continuity:\nExisting canon\n\nCurrent request - depict this now:\nA typed functional meme",
    );
    expect(events).toContain("notify:failure:OpenAI failed: error");
    expect(events).toContain("publish:prepare:42");
    expect(events.some((event) => event.startsWith("publish:image:"))).toBe(
      false,
    );
    expect(events.some((event) => event.startsWith("notify:success:"))).toBe(
      false,
    );
    expect(events.some((event) => event.startsWith("saga:write:"))).toBe(false);
  });

  it("reports a commit failure without announcing success or updating the saga", async () => {
    const { events, exit } = await runWorkflow({ publishFails: true });

    expect(Exit.isFailure(exit)).toBe(true);
    expect(events).toContain("notify:failure:Failed to push after 5 attempts");
    expect(events.some((event) => event.startsWith("notify:success:"))).toBe(
      false,
    );
    expect(events.some((event) => event.startsWith("saga:write:"))).toBe(false);
  });

  it("generates without saga operations when no directives are configured", async () => {
    const { events, exit } = await runWorkflow({
      config: { ...baseConfig, readSaga: null, writeSaga: null },
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(events).toContain("provider:U123:A typed functional meme");
    expect(events.some((event) => event.startsWith("saga:"))).toBe(false);
  });

  it("updates and confirms a write-only saga contribution without generating an image", async () => {
    const { events, exit } = await runWorkflow({
      config: { ...baseConfig, readSaga: null, writeSaga: "fp" },
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(events).toEqual([
      "saga:write:fp:A typed functional meme",
      "notify:saga:fp:true:A typed functional meme",
    ]);
  });

  it("reports a failed write-only saga contribution without generating an image", async () => {
    const { events, exit } = await runWorkflow({
      config: { ...baseConfig, readSaga: null, writeSaga: "fp" },
      sagaUpdateSucceeds: false,
    });

    expect(Exit.isFailure(exit)).toBe(true);
    expect(events).toEqual([
      "saga:write:fp:A typed functional meme",
      "notify:saga:fp:false:A typed functional meme",
    ]);
  });
});
