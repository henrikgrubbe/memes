import { createHmac, timingSafeEqual } from "node:crypto";
import { Context, Data, Effect, Layer, Schema } from "effect";

const SUPPORTED_ACTIONS = new Set(["opened", "reopened"]);

export class WebhookRequestError extends Data.TaggedError(
  "WebhookRequestError",
)<{
  readonly status: 400 | 401;
  readonly detail: string;
}> {
  public get message(): string {
    return this.detail;
  }
}

export class WebhookQueueError extends Data.TaggedError("WebhookQueueError")<{
  readonly detail: string;
}> {
  public get message(): string {
    return this.detail;
  }
}

export const MemeRequestTask = Schema.Struct({
  deliveryId: Schema.String,
  issueNumber: Schema.String,
  issueBody: Schema.String,
  repo: Schema.String,
});

export type MemeRequestTask = Schema.Schema.Type<typeof MemeRequestTask>;

export interface WebhookQueue {
  readonly enqueue: (
    task: MemeRequestTask,
  ) => Effect.Effect<void, WebhookQueueError>;
}

export class WebhookQueueTag extends Context.Tag("WebhookQueue")<
  WebhookQueueTag,
  WebhookQueue
>() {}

export const makeWebhookQueueLayer = (
  queue: WebhookQueue,
): Layer.Layer<WebhookQueueTag> => Layer.succeed(WebhookQueueTag, queue);

export interface GitHubWebhookRequest {
  readonly body: string;
  readonly deliveryId: string | undefined;
  readonly event: string | undefined;
  readonly signature: string | undefined;
}

export interface GitHubWebhookResult {
  readonly status: 202;
  readonly disposition: "ignored" | "queued";
}

const IssueWebhook = Schema.Struct({
  action: Schema.String,
  issue: Schema.Struct({
    number: Schema.Number,
    body: Schema.NullOr(Schema.String),
  }),
  repository: Schema.Struct({
    full_name: Schema.NonEmptyTrimmedString,
  }),
});

const decodeIssueWebhook = Schema.decodeUnknown(Schema.parseJson(IssueWebhook));

const invalid = (
  status: 400 | 401,
  detail: string,
): Effect.Effect<never, WebhookRequestError> =>
  Effect.fail(new WebhookRequestError({ status, detail }));

export function verifyGitHubSignature(
  secret: string,
  body: string,
  signature: string | undefined,
): boolean {
  if (signature == null || !signature.startsWith("sha256=")) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(body).digest();
  const suppliedHex = signature.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(suppliedHex)) {
    return false;
  }

  const supplied = Buffer.from(suppliedHex, "hex");
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

export const handleGitHubWebhook = (
  secret: string,
  request: GitHubWebhookRequest,
): Effect.Effect<
  GitHubWebhookResult,
  WebhookRequestError | WebhookQueueError,
  WebhookQueueTag
> =>
  Effect.gen(function* () {
    if (!verifyGitHubSignature(secret, request.body, request.signature)) {
      return yield* invalid(401, "Invalid GitHub webhook signature");
    }

    if (request.event !== "issues") {
      return { status: 202, disposition: "ignored" };
    }

    if (request.deliveryId == null || request.deliveryId.trim() === "") {
      return yield* invalid(400, "Missing X-GitHub-Delivery header");
    }

    const payload = yield* decodeIssueWebhook(request.body).pipe(
      Effect.mapError(
        () =>
          new WebhookRequestError({
            status: 400,
            detail: "Invalid issue webhook payload",
          }),
      ),
    );

    if (!SUPPORTED_ACTIONS.has(payload.action)) {
      return { status: 202, disposition: "ignored" };
    }
    if (payload.issue.body == null || payload.issue.body.trim() === "") {
      return yield* invalid(400, "Issue body is required");
    }

    const queue = yield* WebhookQueueTag;
    yield* queue.enqueue({
      deliveryId: request.deliveryId,
      issueNumber: String(payload.issue.number),
      issueBody: payload.issue.body,
      repo: payload.repository.full_name,
    });

    return { status: 202, disposition: "queued" };
  });
