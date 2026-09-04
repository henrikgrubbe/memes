import { FileSystem } from "@effect/platform";
import * as PlatformError from "@effect/platform/Error";
import { NodePath } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { MemePublishError, PushFailedError } from "./errors.js";
import { makeGitLayer } from "./git.js";
import {
  MemePublisherLayer,
  MemePublisherServiceTag,
} from "./meme-publisher.js";
import { failureOrThrow } from "./test-support.js";

describe("MemePublisherService", () => {
  it("preserves the filesystem and git publication behavior", async () => {
    let directory: string | null = null;
    let writtenFile: string | null = null;
    let writtenImage: Uint8Array | null = null;
    let commitMessage: string | null = null;
    let stagedPaths: ReadonlyArray<string> = [];
    const fileSystem = FileSystem.layerNoop({
      makeDirectory: (path) =>
        Effect.sync(() => {
          directory = path;
        }),
      writeFile: (path, image) =>
        Effect.sync(() => {
          writtenFile = path;
          writtenImage = image;
        }),
    });
    const git = makeGitLayer({
      commitToMain: (plan) =>
        Effect.sync(() => {
          commitMessage = plan.message;
        }).pipe(
          Effect.zipRight(plan.stage),
          Effect.tap((paths) =>
            Effect.sync(() => {
              stagedPaths = paths;
            }),
          ),
          Effect.asVoid,
        ),
    });
    const layer = MemePublisherLayer.pipe(
      Layer.provide(Layer.mergeAll(fileSystem, NodePath.layer, git)),
    );

    const preparedMeme = await Effect.runPromise(
      MemePublisherServiceTag.pipe(
        Effect.flatMap((publisher) =>
          publisher
            .prepare("42")
            .pipe(
              Effect.tap((prepared) => prepared.publish(Buffer.from("image"))),
            ),
        ),
        Effect.provide(layer),
      ),
    );

    expect(preparedMeme.memeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(directory).toBe(`${process.cwd()}/memes`);
    expect(writtenFile).toBe(
      `${process.cwd()}/memes/${preparedMeme.memeId}.jpg`,
    );
    expect(Buffer.from(writtenImage ?? []).toString()).toBe("image");
    expect(stagedPaths).toEqual([`memes/${preparedMeme.memeId}.jpg`]);
    expect(commitMessage).toBe(
      `Add meme for issue #42 (${preparedMeme.memeId})`,
    );
  });

  it("maps directory preparation failures to the publisher error", async () => {
    const platformError = new PlatformError.SystemError({
      reason: "PermissionDenied",
      module: "FileSystem",
      method: "makeDirectory",
    });
    const fileSystem = FileSystem.layerNoop({
      makeDirectory: () => Effect.fail(platformError),
    });
    const layer = MemePublisherLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          fileSystem,
          NodePath.layer,
          makeGitLayer({ commitToMain: () => Effect.void }),
        ),
      ),
    );

    const exit = await Effect.runPromise(
      MemePublisherServiceTag.pipe(
        Effect.flatMap((publisher) => publisher.prepare("42")),
        Effect.provide(layer),
        Effect.exit,
      ),
    );

    expect(failureOrThrow(exit)).toEqual(
      new MemePublishError({ detail: platformError.message }),
    );
  });

  it("maps git failures to the publisher error", async () => {
    const pushError = new PushFailedError({ attempts: 5 });
    const layer = MemePublisherLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({
            makeDirectory: () => Effect.void,
          }),
          NodePath.layer,
          makeGitLayer({
            commitToMain: () => Effect.fail(pushError),
          }),
        ),
      ),
    );

    const exit = await Effect.runPromise(
      MemePublisherServiceTag.pipe(
        Effect.flatMap((publisher) => publisher.prepare("42")),
        Effect.flatMap((prepared) => prepared.publish(Buffer.from("image"))),
        Effect.provide(layer),
        Effect.exit,
      ),
    );

    expect(failureOrThrow(exit)).toEqual(
      new MemePublishError({ detail: pushError.message }),
    );
  });
});
