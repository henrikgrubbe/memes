import { FileSystem, Path } from "@effect/platform";
import { Effect, Layer } from "effect";
import { GitServiceTag } from "./git.js";
import { MemePublishError } from "../shared/errors.js";
import {
  type MemePublisherService,
  MemePublisherServiceTag,
} from "../shared/meme-publisher.js";

export const MemePublisherLayer: Layer.Layer<
  MemePublisherServiceTag,
  never,
  FileSystem.FileSystem | Path.Path | GitServiceTag
> = Layer.effect(
  MemePublisherServiceTag,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitServiceTag;

    return {
      prepare: (issueNumber) =>
        Effect.gen(function* () {
          const memeId = crypto.randomUUID();
          const memesDir = path.join(process.cwd(), "memes");
          const outFile = path.join(memesDir, `${memeId}.jpg`);

          yield* fs
            .makeDirectory(memesDir, { recursive: true })
            .pipe(
              Effect.mapError(
                (error) => new MemePublishError({ detail: error.message }),
              ),
            );

          return {
            memeId,
            publish: (image) => {
              const stageMeme = fs.writeFile(outFile, image).pipe(
                Effect.orDie,
                Effect.tap(() => Effect.log(`Image saved: ${outFile}`)),
                Effect.as([`memes/${memeId}.jpg`]),
              );

              return git
                .commitToMain({
                  message: `Add meme for issue #${issueNumber} (${memeId})`,
                  stage: stageMeme,
                })
                .pipe(
                  Effect.mapError(
                    (error) => new MemePublishError({ detail: error.message }),
                  ),
                );
            },
          };
        }),
    } satisfies MemePublisherService;
  }),
);
