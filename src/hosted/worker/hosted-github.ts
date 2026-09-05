import { createHash } from "node:crypto";
import { Data, Effect, Schema } from "effect";
import type { MemeRequestTask } from "../task.js";

const FILE_MODE = "100644";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_COMMIT_ATTEMPTS = 5;
const encodeJson = Schema.encodeSync(Schema.parseJson(Schema.Unknown));

export class HostedGitHubError extends Data.TaggedError("HostedGitHubError")<{
  readonly detail: string;
  readonly operation: string;
  readonly status?: number;
}> {
  public get message(): string {
    return this.detail;
  }
}

export interface GitHubApiRequest {
  readonly body?: unknown;
  readonly method: "GET" | "POST" | "PATCH";
  readonly path: string;
}

export interface GitHubApi {
  readonly request: <T>(
    request: GitHubApiRequest,
  ) => Effect.Effect<T, HostedGitHubError>;
}

interface GitHubApiOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly token: string;
}

const responseError = (operation: string, status: number): HostedGitHubError =>
  new HostedGitHubError({
    detail: `GitHub ${operation} failed with HTTP ${status}`,
    operation,
    status,
  });

export const makeGitHubApi = ({
  baseUrl = "https://api.github.com",
  fetch: fetchRequest = fetch,
  token,
}: GitHubApiOptions): GitHubApi => ({
  request: <T>({ body, method, path }: GitHubApiRequest) =>
    Effect.tryPromise({
      try: () =>
        fetchRequest(`${baseUrl.replace(/\/$/, "")}${path}`, {
          method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "memes-hosted-worker",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
          },
          ...(body == null ? {} : { body: encodeJson(body) }),
        }).then((response) =>
          response.text().then((responseBody) => {
            if (!response.ok) {
              throw responseError(`${method} ${path}`, response.status);
            }
            return (
              responseBody === ""
                ? undefined
                : Schema.decodeUnknownSync(Schema.parseJson(Schema.Unknown))(
                    responseBody,
                  )
            ) as T;
          }),
        ),
      catch: (error) =>
        error instanceof HostedGitHubError
          ? error
          : new HostedGitHubError({
              detail: `GitHub ${method} ${path} failed: ${String(error)}`,
              operation: `${method} ${path}`,
            }),
    }),
});

export interface SagaCommit {
  readonly derive: (canon: string) => Effect.Effect<string>;
  readonly name: string;
  readonly path: string;
}

export interface HostedGitHubRepository {
  readonly branch: string;
  readonly closeIssue: (
    reason?: "not_planned",
  ) => Effect.Effect<void, HostedGitHubError>;
  readonly commentOnce: (
    body: string,
  ) => Effect.Effect<void, HostedGitHubError>;
  readonly foldSaga: (
    saga: SagaCommit,
  ) => Effect.Effect<boolean, HostedGitHubError>;
  readonly memeId: string;
  readonly readText: (
    path: string,
  ) => Effect.Effect<string | null, HostedGitHubError>;
}

interface HostedRepositoryOptions {
  readonly api: GitHubApi;
  readonly branch: string;
  readonly maxCommitAttempts?: number;
  readonly task: MemeRequestTask;
}

interface GitRef {
  readonly object: { readonly sha: string };
}

interface GitCommit {
  readonly tree: { readonly sha: string };
}

interface GitObject {
  readonly sha: string;
}

interface ContentResponse {
  readonly content: string;
  readonly encoding: string;
}

interface IssueComment {
  readonly body: string | null;
  readonly id: number;
}

interface RepositoryFile {
  readonly content: string;
  readonly path: string;
}

const SagaFoldReceiptSchema = Schema.Struct({
  deliveryId: Schema.String,
  folded: Schema.Literal(true),
  saga: Schema.String,
});

type SagaFoldReceipt = Schema.Schema.Type<typeof SagaFoldReceiptSchema>;

const keyForTask = (task: MemeRequestTask): string =>
  createHash("sha256")
    .update(`${task.repo}\0${task.issueNumber}\0${task.deliveryId}`)
    .digest("hex");

const uuidForTask = (task: MemeRequestTask): string => {
  const bytes = createHash("sha256")
    .update(`meme\0${task.repo}\0${task.issueNumber}\0${task.deliveryId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
};

const encodePath = (path: string): string =>
  path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

const isNotFound = (error: HostedGitHubError): boolean => error.status === 404;

const isRefConflict = (error: HostedGitHubError): boolean =>
  error.status === 409 || error.status === 422;

export const makeHostedGitHubRepository = ({
  api,
  branch,
  maxCommitAttempts = MAX_COMMIT_ATTEMPTS,
  task,
}: HostedRepositoryOptions): HostedGitHubRepository => {
  const key = keyForTask(task);
  const sagaReceiptPath = `.github/meme-worker/saga-folds/${key}.json`;
  const memeId = uuidForTask(task);
  const repoPath = `/repos/${task.repo}`;
  const readRefPath = `${repoPath}/git/ref/heads/${encodeURIComponent(branch)}`;
  const updateRefPath = `${repoPath}/git/refs/heads/${encodeURIComponent(branch)}`;

  const readTextAt = (
    path: string,
    ref: string,
  ): Effect.Effect<string | null, HostedGitHubError> =>
    api
      .request<ContentResponse>({
        method: "GET",
        path: `${repoPath}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
      })
      .pipe(
        Effect.flatMap((response) =>
          response.encoding === "base64"
            ? Effect.succeed(
                Buffer.from(
                  response.content.replace(/\s/g, ""),
                  "base64",
                ).toString("utf8"),
              )
            : Effect.fail(
                new HostedGitHubError({
                  detail: `GitHub returned unsupported content encoding "${response.encoding}"`,
                  operation: `read ${path}`,
                }),
              ),
        ),
        Effect.catchIf(isNotFound, () => Effect.succeed(null)),
      );

  const getHead = () =>
    api.request<GitRef>({ method: "GET", path: readRefPath });

  const createBlob = (file: RepositoryFile) =>
    api.request<GitObject>({
      method: "POST",
      path: `${repoPath}/git/blobs`,
      body: { content: file.content, encoding: "utf-8" },
    });

  const commitFiles = (
    parentSha: string,
    message: string,
    files: ReadonlyArray<RepositoryFile>,
  ) =>
    Effect.gen(function* () {
      const parent = yield* api.request<GitCommit>({
        method: "GET",
        path: `${repoPath}/git/commits/${parentSha}`,
      });
      const blobs = yield* Effect.forEach(files, createBlob, {
        concurrency: "unbounded",
      });
      const tree = yield* api.request<GitObject>({
        method: "POST",
        path: `${repoPath}/git/trees`,
        body: {
          base_tree: parent.tree.sha,
          tree: files.map((file, index) => ({
            mode: FILE_MODE,
            path: file.path,
            sha: blobs[index].sha,
            type: "blob",
          })),
        },
      });
      const commit = yield* api.request<GitObject>({
        method: "POST",
        path: `${repoPath}/git/commits`,
        body: {
          message,
          parents: [parentSha],
          tree: tree.sha,
        },
      });
      yield* api.request<unknown>({
        method: "PATCH",
        path: updateRefPath,
        body: { force: false, sha: commit.sha },
      });
    });

  const retryConflict = <A, E>(
    attempt: number,
    operation: (attempt: number) => Effect.Effect<A, E | HostedGitHubError>,
  ): Effect.Effect<A, E | HostedGitHubError> =>
    operation(attempt).pipe(
      Effect.catchIf(
        (error): error is HostedGitHubError =>
          error instanceof HostedGitHubError &&
          isRefConflict(error) &&
          attempt < maxCommitAttempts,
        () => retryConflict(attempt + 1, operation),
      ),
    );

  const readSagaReceiptAt = (
    ref: string,
    saga: string,
  ): Effect.Effect<SagaFoldReceipt | null, HostedGitHubError> =>
    readTextAt(sagaReceiptPath, ref).pipe(
      Effect.flatMap((content) =>
        content == null
          ? Effect.succeed(null)
          : Schema.decodeUnknown(Schema.parseJson(SagaFoldReceiptSchema))(
              content,
            ).pipe(
              Effect.filterOrFail(
                (receipt) =>
                  receipt.deliveryId === task.deliveryId &&
                  receipt.saga === saga,
                () =>
                  new HostedGitHubError({
                    detail: `Saga fold receipt ${sagaReceiptPath} has the wrong delivery identity`,
                    operation: "decode saga fold receipt",
                  }),
              ),
              Effect.mapError((error) =>
                error instanceof HostedGitHubError
                  ? error
                  : new HostedGitHubError({
                      detail: `Saga fold receipt ${sagaReceiptPath} is invalid`,
                      operation: "decode saga fold receipt",
                    }),
              ),
            ),
      ),
    );

  const foldSaga = (
    saga: SagaCommit,
  ): Effect.Effect<boolean, HostedGitHubError> =>
    retryConflict(1, () =>
      Effect.gen(function* () {
        const head = yield* getHead();
        const receipt = yield* readSagaReceiptAt(head.object.sha, saga.name);
        if (receipt != null) {
          return false;
        }
        const canon = (yield* readTextAt(saga.path, head.object.sha)) ?? "";
        const folded = yield* saga.derive(canon);
        const sagaReceipt: SagaFoldReceipt = {
          deliveryId: task.deliveryId,
          folded: true,
          saga: saga.name,
        };
        yield* commitFiles(
          head.object.sha,
          `Update saga for meme request #${task.issueNumber}`,
          [
            { content: `${folded}\n`, path: saga.path },
            {
              content: `${encodeJson(sagaReceipt)}\n`,
              path: sagaReceiptPath,
            },
          ],
        );
        return true;
      }),
    );

  const commentMarker = `<!-- meme-worker:${key}:completion -->`;

  const listComments = (
    page = 1,
  ): Effect.Effect<ReadonlyArray<IssueComment>, HostedGitHubError> =>
    Effect.gen(function* () {
      const comments = yield* api.request<ReadonlyArray<IssueComment>>({
        method: "GET",
        path: `${repoPath}/issues/${task.issueNumber}/comments?per_page=100&page=${page}`,
      });
      if (comments.length < 100) {
        return comments;
      }
      const remaining = yield* listComments(page + 1);
      return [...comments, ...remaining];
    });

  const commentOnce = (body: string): Effect.Effect<void, HostedGitHubError> =>
    listComments().pipe(
      Effect.flatMap((comments) => {
        const markedBody = `${body}\n\n${commentMarker}`;
        const existing = comments.find((comment) =>
          comment.body?.includes(commentMarker),
        );
        if (existing == null) {
          return api
            .request<unknown>({
              method: "POST",
              path: `${repoPath}/issues/${task.issueNumber}/comments`,
              body: { body: markedBody },
            })
            .pipe(Effect.asVoid);
        }
        return existing.body === markedBody
          ? Effect.void
          : api
              .request<unknown>({
                method: "PATCH",
                path: `${repoPath}/issues/comments/${existing.id}`,
                body: { body: markedBody },
              })
              .pipe(Effect.asVoid);
      }),
    );

  const closeIssue = (
    reason?: "not_planned",
  ): Effect.Effect<void, HostedGitHubError> =>
    api
      .request<unknown>({
        method: "PATCH",
        path: `${repoPath}/issues/${task.issueNumber}`,
        body: {
          state: "closed",
          ...(reason == null ? {} : { state_reason: reason }),
        },
      })
      .pipe(Effect.asVoid);

  return {
    branch,
    closeIssue,
    commentOnce,
    foldSaga,
    memeId,
    readText: (path) => readTextAt(path, branch),
  };
};
