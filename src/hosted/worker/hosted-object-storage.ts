import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Data, Effect, Predicate, Schema } from "effect";
import type { GenerationMetadata } from "../../shared/providers.js";
import type {
  FailureDeliveryOutcome,
  SuccessDeliveryOutcome,
} from "./hosted-delivery.js";

const CACHE_CONTROL = "public, max-age=31536000, immutable";
const FAILURE_PREFIX = "terminal-outcomes";
const IMAGE_PREFIX = "memes";
const METADATA_VERSION = "1";

const HistoryEntrySchema = Schema.Struct({
  message: Schema.optional(Schema.String),
  provider: Schema.String,
  status: Schema.Literal("success", "rate-limited", "failed"),
});

const FailureDeliveryOutcomeSchema = Schema.Struct({
  closeNotPlanned: Schema.Boolean,
  history: Schema.optional(Schema.Array(HistoryEntrySchema)),
  kind: Schema.Literal("failure"),
  message: Schema.String,
});

const TerminalOutcomeRecordSchema = Schema.Struct({
  deliveryId: Schema.String,
  memeId: Schema.String,
  outcome: FailureDeliveryOutcomeSchema,
});

const encodeJson = Schema.encodeSync(Schema.parseJson(Schema.Unknown));

export class HostedObjectStorageError extends Data.TaggedError(
  "HostedObjectStorageError",
)<{
  readonly detail: string;
  readonly operation: string;
  readonly status?: number;
}> {
  public get message(): string {
    return this.detail;
  }
}

interface HeadObjectInput {
  readonly bucket: string;
  readonly key: string;
}

interface PutObjectInput extends HeadObjectInput {
  readonly body: string | Uint8Array;
  readonly cacheControl: string;
  readonly contentType: string;
  readonly ifNoneMatch: "*";
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface ObjectStorageApi {
  readonly getObject: (input: HeadObjectInput) => Promise<string>;
  readonly headObject: (
    input: HeadObjectInput,
  ) => Promise<{ readonly metadata?: Readonly<Record<string, string>> }>;
  readonly putObject: (input: PutObjectInput) => Promise<void>;
}

interface S3ObjectStorageApiOptions {
  readonly accessKeyId: string;
  readonly endpoint: string;
  readonly region: string;
  readonly secretAccessKey: string;
}

export const makeS3ObjectStorageApi = ({
  accessKeyId,
  endpoint,
  region,
  secretAccessKey,
}: S3ObjectStorageApiOptions): ObjectStorageApi => {
  const client = new S3Client({
    credentials: { accessKeyId, secretAccessKey },
    endpoint,
    forcePathStyle: true,
    region,
  });

  return {
    getObject: ({ bucket, key }) =>
      client
        .send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        .then((response) => {
          if (response.Body == null) {
            throw new HostedObjectStorageError({
              detail: `Object Storage returned an empty body for ${key}`,
              operation: `get ${key}`,
            });
          }
          return response.Body.transformToString();
        }),
    headObject: ({ bucket, key }) =>
      client
        .send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
        .then((response) => ({ metadata: response.Metadata })),
    putObject: ({
      body,
      bucket,
      cacheControl,
      contentType,
      ifNoneMatch,
      key,
      metadata,
    }) =>
      client
        .send(
          new PutObjectCommand({
            Body: body,
            Bucket: bucket,
            CacheControl: cacheControl,
            ContentType: contentType,
            IfNoneMatch: ifNoneMatch,
            Key: key,
            Metadata: metadata,
          }),
        )
        .then(() => undefined),
  };
};

interface HostedObjectStorageOptions {
  readonly api: ObjectStorageApi;
  readonly bucket: string;
  readonly deliveryId: string;
  readonly memeId: string;
  readonly publicBaseUrl: string;
}

interface PublishImagePlan {
  readonly image: Uint8Array;
  readonly outcome: Omit<SuccessDeliveryOutcome, "imageUrl">;
}

export interface HostedObjectStorage {
  readonly getOutcome: (
    prompt: string,
  ) => Effect.Effect<StoredDeliveryOutcome | null, HostedObjectStorageError>;
  readonly publishImage: (
    plan: PublishImagePlan,
  ) => Effect.Effect<SuccessDeliveryOutcome, HostedObjectStorageError>;
  readonly recordTerminalFailure: (
    prompt: string,
    outcome: FailureDeliveryOutcome,
  ) => Effect.Effect<
    SuccessDeliveryOutcome | FailureDeliveryOutcome,
    HostedObjectStorageError
  >;
}

type StoredDeliveryOutcome = SuccessDeliveryOutcome | FailureDeliveryOutcome;

const errorStatus = (error: unknown): number | undefined => {
  if (!Predicate.isRecord(error)) {
    return undefined;
  }
  if (
    "$metadata" in error &&
    Predicate.isRecord(error.$metadata) &&
    "httpStatusCode" in error.$metadata &&
    typeof error.$metadata.httpStatusCode === "number"
  ) {
    return error.$metadata.httpStatusCode;
  }
  return undefined;
};

const errorName = (error: unknown): string | undefined =>
  Predicate.isRecord(error) && "name" in error && typeof error.name === "string"
    ? error.name
    : undefined;

const storageError = (
  operation: string,
  error: unknown,
): HostedObjectStorageError =>
  error instanceof HostedObjectStorageError
    ? error
    : new HostedObjectStorageError({
        detail: `Object Storage ${operation} failed${
          errorStatus(error) == null ? "" : ` with HTTP ${errorStatus(error)}`
        }`,
        operation,
        ...(errorStatus(error) == null ? {} : { status: errorStatus(error) }),
      });

const isMissing = (error: HostedObjectStorageError): boolean =>
  error.status === 404;

const isPreconditionFailed = (error: HostedObjectStorageError): boolean =>
  error.status === 412;

const request = <A>(
  operation: string,
  run: () => Promise<A>,
): Effect.Effect<A, HostedObjectStorageError> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => {
      const status =
        errorStatus(error) ??
        (errorName(error) === "NotFound" || errorName(error) === "NoSuchKey"
          ? 404
          : errorName(error) === "PreconditionFailed"
            ? 412
            : undefined);
      return storageError(
        operation,
        status == null
          ? error
          : {
              $metadata: { httpStatusCode: status },
            },
      );
    },
  });

const compactNumber = (value: number | undefined): string | undefined =>
  value == null || !Number.isFinite(value) || value < 0
    ? undefined
    : String(Math.round(value));

const imageMetadata = (
  provider: string,
  metadata?: GenerationMetadata,
): Readonly<Record<string, string>> => {
  const usage = metadata?.usage;
  const costMicrocents =
    metadata?.costCents == null
      ? undefined
      : compactNumber(metadata.costCents * 1_000_000);
  return {
    "meme-result-version": METADATA_VERSION,
    "meme-provider": Buffer.from(provider, "utf8").toString("base64url"),
    ...(costMicrocents == null
      ? {}
      : { "meme-cost-microcents": costMicrocents }),
    ...(usage == null
      ? {}
      : {
          "meme-input-tokens": String(usage.inputTokens),
          "meme-output-tokens": String(usage.outputTokens),
          "meme-total-tokens": String(usage.totalTokens),
        }),
  };
};

const parseNonNegativeInteger = (value: string | undefined): number | null => {
  if (value == null || !/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const decodeProvider = (metadata: Readonly<Record<string, string>>): string => {
  const encoded = metadata["meme-provider"];
  if (
    metadata["meme-result-version"] !== METADATA_VERSION ||
    encoded == null ||
    encoded.length === 0 ||
    encoded.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    return "unknown";
  }
  const decoded = Buffer.from(encoded, "base64url");
  const provider = decoded.toString("utf8").trim();
  return provider === "" ||
    Buffer.from(provider, "utf8").toString("base64url") !== encoded
    ? "unknown"
    : provider;
};

const decodeGenerationMetadata = (
  metadata: Readonly<Record<string, string>>,
): GenerationMetadata | undefined => {
  const inputTokens = parseNonNegativeInteger(metadata["meme-input-tokens"]);
  const outputTokens = parseNonNegativeInteger(metadata["meme-output-tokens"]);
  const totalTokens = parseNonNegativeInteger(metadata["meme-total-tokens"]);
  const costMicrocents = parseNonNegativeInteger(
    metadata["meme-cost-microcents"],
  );
  const usage =
    inputTokens == null || outputTokens == null || totalTokens == null
      ? undefined
      : { inputTokens, outputTokens, totalTokens };
  const costCents =
    costMicrocents == null ? undefined : costMicrocents / 1_000_000;
  return usage == null && costCents == null
    ? undefined
    : {
        ...(usage == null ? {} : { usage }),
        ...(costCents == null ? {} : { costCents }),
      };
};

const publicUrl = (baseUrl: string, key: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/${key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;

export const makeHostedObjectStorage = ({
  api,
  bucket,
  deliveryId,
  memeId,
  publicBaseUrl,
}: HostedObjectStorageOptions): HostedObjectStorage => {
  const imageKey = `${IMAGE_PREFIX}/${memeId}.jpg`;
  const failureKey = `${FAILURE_PREFIX}/${memeId}.json`;
  const imageUrl = publicUrl(publicBaseUrl, imageKey);

  const successFromMetadata = (
    prompt: string,
    metadata: Readonly<Record<string, string>> = {},
  ): SuccessDeliveryOutcome => {
    const provider = decodeProvider(metadata);
    const generationMetadata = decodeGenerationMetadata(metadata);
    return {
      history: [{ provider, status: "success" }],
      imageUrl,
      kind: "success",
      memeId,
      ...(generationMetadata == null ? {} : { metadata: generationMetadata }),
      prompt,
      provider,
    };
  };

  const headImage = (
    prompt: string,
  ): Effect.Effect<SuccessDeliveryOutcome | null, HostedObjectStorageError> =>
    request(`head ${imageKey}`, () =>
      api.headObject({ bucket, key: imageKey }),
    ).pipe(
      Effect.map(({ metadata }) => successFromMetadata(prompt, metadata)),
      Effect.catchIf(isMissing, () => Effect.succeed(null)),
    );

  const readFailure = (): Effect.Effect<
    FailureDeliveryOutcome | null,
    HostedObjectStorageError
  > =>
    request(`get ${failureKey}`, () =>
      api.getObject({ bucket, key: failureKey }),
    ).pipe(
      Effect.catchIf(isMissing, () => Effect.succeed(null)),
      Effect.flatMap((content) =>
        content == null
          ? Effect.succeed(null)
          : Schema.decodeUnknown(Schema.parseJson(TerminalOutcomeRecordSchema))(
              content,
            ).pipe(
              Effect.filterOrFail(
                (record) =>
                  record.deliveryId === deliveryId && record.memeId === memeId,
                () =>
                  new HostedObjectStorageError({
                    detail: `Terminal outcome ${failureKey} has the wrong delivery identity`,
                    operation: `decode ${failureKey}`,
                  }),
              ),
              Effect.map(({ outcome }) => outcome),
              Effect.mapError((error) =>
                error instanceof HostedObjectStorageError
                  ? error
                  : new HostedObjectStorageError({
                      detail: `Terminal outcome ${failureKey} is invalid`,
                      operation: `decode ${failureKey}`,
                    }),
              ),
            ),
      ),
    );

  const getOutcome = (
    prompt: string,
  ): Effect.Effect<StoredDeliveryOutcome | null, HostedObjectStorageError> =>
    headImage(prompt).pipe(
      Effect.flatMap((published) =>
        published == null
          ? readFailure()
          : Effect.succeed<StoredDeliveryOutcome>(published),
      ),
    );

  const loadConcurrentWinner = (
    prompt: string,
  ): Effect.Effect<StoredDeliveryOutcome, HostedObjectStorageError> =>
    getOutcome(prompt).pipe(
      Effect.filterOrFail(
        (outcome): outcome is StoredDeliveryOutcome => outcome != null,
        () =>
          new HostedObjectStorageError({
            detail:
              "Conditional Object Storage write lost without a readable winner",
            operation: "load concurrent winner",
          }),
      ),
    );

  return {
    getOutcome,
    publishImage: ({ image, outcome }) =>
      request(`put ${imageKey}`, () =>
        api.putObject({
          body: image,
          bucket,
          cacheControl: CACHE_CONTROL,
          contentType: "image/jpeg",
          ifNoneMatch: "*",
          key: imageKey,
          metadata: imageMetadata(outcome.provider, outcome.metadata),
        }),
      ).pipe(
        Effect.as({ ...outcome, imageUrl }),
        Effect.catchIf(isPreconditionFailed, () =>
          headImage(outcome.prompt).pipe(
            Effect.filterOrFail(
              (published): published is SuccessDeliveryOutcome =>
                published != null,
              () =>
                new HostedObjectStorageError({
                  detail: `Concurrent image winner ${imageKey} is not readable`,
                  operation: `head ${imageKey}`,
                }),
            ),
          ),
        ),
      ),
    recordTerminalFailure: (prompt, outcome) =>
      headImage(prompt).pipe(
        Effect.flatMap((published) =>
          published == null
            ? request(`put ${failureKey}`, () =>
                api.putObject({
                  body: `${encodeJson({ deliveryId, memeId, outcome })}\n`,
                  bucket,
                  cacheControl: "no-store",
                  contentType: "application/json",
                  ifNoneMatch: "*",
                  key: failureKey,
                }),
              ).pipe(
                Effect.as<SuccessDeliveryOutcome | FailureDeliveryOutcome>(
                  outcome,
                ),
                Effect.catchIf(isPreconditionFailed, () =>
                  loadConcurrentWinner(prompt),
                ),
              )
            : Effect.succeed(published),
        ),
      ),
  };
};
