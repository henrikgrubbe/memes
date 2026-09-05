import { FileSystem, Path } from "@effect/platform";
import { Config, Effect, Layer, Option } from "effect";
import { AppConfigService } from "../shared/config.js";
import {
  CONTEXT_DIR,
  makeSagaCompressor,
  type SagaService,
  SagaServiceTag,
  sagaPath,
} from "../shared/saga.js";
import { GitServiceTag } from "./git.js";

export const SagaLayer: Layer.Layer<
  SagaServiceTag,
  never,
  FileSystem.FileSystem | Path.Path | AppConfigService | GitServiceTag
> = Layer.effect(
  SagaServiceTag,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* AppConfigService;
    const git = yield* GitServiceTag;
    const apiKey = yield* Config.option(Config.string("OPENAI_API_KEY")).pipe(
      Effect.orDie,
    );
    const compress = makeSagaCompressor(Option.getOrNull(apiKey));

    const absPath = (saga: string) =>
      path.join(process.cwd(), CONTEXT_DIR, `${saga}.md`);

    const readCanon = (saga: string): Effect.Effect<string | null> =>
      fs.readFileString(absPath(saga)).pipe(Effect.orElseSucceed(() => null));

    const stage = (
      saga: string,
      prompt: string,
    ): Effect.Effect<ReadonlyArray<string>> =>
      Effect.gen(function* () {
        const canon = (yield* readCanon(saga)) ?? "";
        const newCanon = yield* compress(saga, canon, prompt);
        yield* fs
          .makeDirectory(path.join(process.cwd(), CONTEXT_DIR), {
            recursive: true,
          })
          .pipe(Effect.ignore);
        yield* fs
          .writeFileString(absPath(saga), `${newCanon}\n`)
          .pipe(Effect.orDie);

        return [sagaPath(saga)];
      });

    return {
      read: readCanon,
      contribute: (saga, prompt) =>
        git
          .commitToMain({
            message: `Update saga ${saga} for issue #${config.issueNumber}`,
            stage: stage(saga, prompt),
          })
          .pipe(
            Effect.tap(() => Effect.log(`Saga "${saga}" updated.`)),
            Effect.as(true),
            Effect.catchAll(() =>
              Effect.logWarning(`Saga "${saga}" update failed.`).pipe(
                Effect.as(false),
              ),
            ),
          ),
    } satisfies SagaService;
  }),
);
