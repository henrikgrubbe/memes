import {Command, CommandExecutor, FileSystem} from "@effect/platform";
import {Context, Effect, Layer, Schedule} from "effect";
import {UploadFailedError} from "./errors.js";
import {AppConfigService} from "./config.js";

// ---- AssetStore -------------------------------------------------------------
// Deep interface: callers hand over a memeId and the image bytes; where the
// image is stored and how a public URL is produced all live behind this seam.
//
// The real implementation uploads each meme as a GitHub Release asset. This
// keeps binaries out of the repo's git history (no per-meme commits) while
// still giving a permanent, publicly hotlinkable URL for Slack and the issue
// comment. Distinct UUID filenames make concurrent uploads collision-free, so
// there's no pull/rebase/push contention between simultaneous runs.

export interface AssetStore {
    /** Publish the image and resolve to its public URL. */
    publish(memeId: string, image: Uint8Array): Effect.Effect<string, UploadFailedError>;
}

export class AssetStoreTag extends Context.Tag("AssetStore")<AssetStoreTag, AssetStore>() {}

// ---- Test helper ------------------------------------------------------------

/** Build a Layer from a pre-constructed AssetStore implementation (bypasses gh). */
export const makeAssetStoreLayer = (impl: AssetStore): Layer.Layer<AssetStoreTag> =>
    Layer.succeed(AssetStoreTag, impl);

// ---- Real adapter -----------------------------------------------------------

// All memes land on one long-lived release; asset names are unique UUIDs.
const RELEASE_TAG        = "memes";
const MAX_UPLOAD_RETRIES = 5;

type AssetDeps = CommandExecutor.CommandExecutor | AppConfigService | FileSystem.FileSystem;

const exec = (executor: CommandExecutor.CommandExecutor, cmd: string): Effect.Effect<string, UploadFailedError> =>
    Command.make("sh", "-c", cmd).pipe(
        Command.string,
        Effect.mapError(() => new UploadFailedError({attempts: 0})),
        Effect.map((s) => s.trim()),
        Effect.provideService(CommandExecutor.CommandExecutor, executor),
    );

/** Public download URL for a release asset. */
export const assetUrl = (repo: string, memeId: string): string =>
    `https://github.com/${repo}/releases/download/${RELEASE_TAG}/${memeId}.jpg`;

export const AssetStoreLayer: Layer.Layer<AssetStoreTag, never, AssetDeps> =
    Layer.effect(
        AssetStoreTag,
        Effect.gen(function* () {
            // Capture dependencies once, at layer construction, so the service
            // methods themselves require nothing from context (R = never).
            const executor = yield* CommandExecutor.CommandExecutor;
            const config   = yield* AppConfigService;
            const fs       = yield* FileSystem.FileSystem;
            const run      = (cmd: string) => exec(executor, cmd);

            return {
                publish: (memeId: string, image: Uint8Array): Effect.Effect<string, UploadFailedError> =>
                    Effect.gen(function* () {
                        // Name the temp file after the memeId so the uploaded
                        // asset (named from the file's basename) matches the URL.
                        const dir  = yield* fs.makeTempDirectoryScoped().pipe(Effect.orDie);
                        const file = `${dir}/${memeId}.jpg`;
                        yield* fs.writeFile(file, image).pipe(Effect.orDie);

                        // Create the release on first use (best-effort; a lost
                        // race just means it already exists), then upload. The
                        // upload's exit code is what determines success.
                        const upload = run(
                            `gh release create ${RELEASE_TAG} --repo ${config.repo} --title "Generated memes" --notes "Automated meme uploads." >/dev/null 2>&1 || true; ` +
                            `gh release upload ${RELEASE_TAG} "${file}" --repo ${config.repo} --clobber`,
                        );

                        yield* Effect.retry(
                            upload.pipe(Effect.tapError(() => Effect.log("Upload failed - retrying..."))),
                            Schedule.recurs(MAX_UPLOAD_RETRIES - 1),
                        ).pipe(Effect.mapError(() => new UploadFailedError({attempts: MAX_UPLOAD_RETRIES})));

                        const url = assetUrl(config.repo, memeId);
                        yield* Effect.log(`Uploaded ${memeId}.jpg -> ${url}`);
                        return url;
                    }).pipe(Effect.scoped),
            } satisfies AssetStore;
        }),
    );
