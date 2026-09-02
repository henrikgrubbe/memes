import { FileSystem } from "@effect/platform";
import { NodePath } from "@effect/platform-node";
import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { type AppConfig, AppConfigService } from "./config.js";
import { PushFailedError } from "./errors.js";
import { program } from "./generate-meme.js";
import { makeGitLayer } from "./git.js";
import { NotifierServiceTag } from "./notifier.js";
import {
  providerErrorProvider,
  successfulProvider,
} from "./provider-test-support.js";
import { makeProvidersLayer, type ProviderFn } from "./providers.js";
import { makeSagaLayer } from "./saga.js";

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
  readonly gitFails?: boolean;
}

const runWorkflow = ({
  config = baseConfig,
  provider = successfulProvider("OpenAI"),
  gitFails = false,
}: HarnessOptions = {}) => {
  let events: ReadonlyArray<string> = [];
  const record = (event: string) =>
    Effect.sync(() => {
      events = [...events, event];
    });

  const fileSystem = FileSystem.layerNoop({
    makeDirectory: (path) => record(`mkdir:${path}`),
    writeFile: (path) => record(`write:${path}`),
  });
  const saga = makeSagaLayer({
    read: (name) =>
      record(`saga:read:${name}`).pipe(Effect.as("Existing canon")),
    contribute: (name, prompt) => record(`saga:write:${name}:${prompt}`),
  });
  const git = makeGitLayer({
    commitToMain: (plan) =>
      record("git:start").pipe(
        Effect.zipRight(plan.stage),
        Effect.flatMap((paths) => record(`git:commit:${paths.join(",")}`)),
        Effect.zipRight(
          gitFails
            ? Effect.fail(new PushFailedError({ attempts: 5 }))
            : Effect.void,
        ),
      ),
  });
  const notifier = Layer.succeed(NotifierServiceTag, {
    notifySuccess: ({ memeId, prompt }) =>
      record(`notify:success:${memeId}:${prompt}`),
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
    fileSystem,
    NodePath.layer,
    saga,
    git,
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
    expect(events[1]).toContain("mkdir:");
    expect(events[2]).toBe(
      "provider:U123:Background for continuity:\nExisting canon\n\nCurrent request - depict this now:\nA typed functional meme",
    );
    expect(events[3]).toBe("git:start");
    expect(events[4]).toMatch(/^write:.*\/memes\/.+\.jpg$/);
    expect(events[5]).toMatch(/^git:commit:memes\/.+\.jpg$/);
    expect(events[6]).toMatch(/^notify:success:.+:A typed functional meme$/);
    expect(events[7]).toBe("saga:write:fp:A typed functional meme");
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
    expect(events.some((event) => event.startsWith("git:"))).toBe(false);
    expect(events.some((event) => event.startsWith("notify:success:"))).toBe(
      false,
    );
    expect(events.some((event) => event.startsWith("saga:write:"))).toBe(false);
  });

  it("reports a commit failure without announcing success or updating the saga", async () => {
    const { events, exit } = await runWorkflow({ gitFails: true });

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
});
