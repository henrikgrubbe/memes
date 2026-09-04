import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  type GitHubApi,
  type GitHubApiRequest,
  HostedGitHubError,
  makeGitHubApi,
  makeHostedGitHubRepository,
} from "./hosted-github.js";

const task = {
  deliveryId: "delivery-1",
  issueBody: "unused",
  issueNumber: "42",
  repo: "owner/repo",
};

const outcome = {
  history: [{ provider: "OpenAI", status: "success" as const }],
  kind: "success" as const,
  memeId: "meme-id",
  prompt: "prompt",
  provider: "OpenAI",
};

type Handler = (
  request: GitHubApiRequest,
) => Effect.Effect<unknown, HostedGitHubError>;

const makeApi = (handler: Handler): GitHubApi => ({
  request: <T>(request: GitHubApiRequest) =>
    handler(request).pipe(Effect.map((value) => value as T)),
});

const notFound = (operation: string) =>
  new HostedGitHubError({
    detail: "not found",
    operation,
    status: 404,
  });

const gitDataHandler = (
  onRequest?: (request: GitHubApiRequest) => void,
): Handler => {
  let blob = 0;
  return (request) => {
    onRequest?.(request);
    if (request.method === "GET" && request.path.includes("/git/ref/heads/")) {
      return Effect.succeed({ object: { sha: "head-1" } });
    }
    if (request.method === "GET" && request.path.includes("/contents/")) {
      if (request.path.includes("/contents/context/")) {
        return Effect.succeed({
          content: Buffer.from("Old canon").toString("base64"),
          encoding: "base64",
        });
      }
      return Effect.fail(notFound(request.path));
    }
    if (request.method === "GET" && request.path.includes("/git/commits/")) {
      return Effect.succeed({
        sha: "head-1",
        tree: { sha: "tree-1" },
      });
    }
    if (request.method === "POST" && request.path.endsWith("/git/blobs")) {
      blob += 1;
      return Effect.succeed({ sha: `blob-${blob}` });
    }
    if (request.method === "POST" && request.path.endsWith("/git/trees")) {
      return Effect.succeed({ sha: "tree-2" });
    }
    if (request.method === "POST" && request.path.endsWith("/git/commits")) {
      return Effect.succeed({ sha: "commit-2" });
    }
    if (request.method === "PATCH" && request.path.includes("/git/refs/")) {
      return Effect.succeed({});
    }
    return Effect.fail(
      new HostedGitHubError({
        detail: `Unexpected ${request.method} ${request.path}`,
        operation: "test",
      }),
    );
  };
};

describe("hosted GitHub persistence", () => {
  it("authenticates REST requests and decodes successful responses", async () => {
    let authorization = "";
    const api = makeGitHubApi({
      baseUrl: "https://github.example/api",
      fetch: (_input, init) => {
        authorization = new Headers(init?.headers).get("Authorization") ?? "";
        return Promise.resolve(
          new Response('{"object":{"sha":"head"}}', { status: 200 }),
        );
      },
      token: "test-token",
    });

    const response = await Effect.runPromise(
      api.request<{ readonly object: { readonly sha: string } }>({
        method: "GET",
        path: "/repos/owner/repo/git/ref/heads/main",
      }),
    );

    expect(response.object.sha).toBe("head");
    expect(authorization).toBe("Bearer test-token");
  });

  it("reports GitHub status without exposing response contents", async () => {
    const api = makeGitHubApi({
      fetch: () =>
        Promise.resolve(new Response('{"message":"private"}', { status: 500 })),
      token: "test-token",
    });

    const exit = await Effect.runPromise(
      api
        .request({
          body: { value: "request" },
          method: "POST",
          path: "/test",
        })
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("HTTP 500");
      expect(String(exit.cause)).not.toContain("private");
    }
  });

  it("commits image, re-derived saga, and delivery marker in one tree", async () => {
    let treeBody: unknown;
    const api = makeApi(
      gitDataHandler((request) => {
        if (request.method === "POST" && request.path.endsWith("/git/trees")) {
          treeBody = request.body;
        }
      }),
    );
    const repository = makeHostedGitHubRepository({
      api,
      branch: "main",
      task,
    });

    const completed = await Effect.runPromise(
      repository.complete({
        files: [
          {
            content: Buffer.from("image"),
            path: `memes/${repository.memeId}.jpg`,
          },
        ],
        outcome: { ...outcome, memeId: repository.memeId },
        saga: {
          derive: (canon) => Effect.succeed(`${canon}\n- New event`),
          path: "context/story.md",
        },
      }),
    );

    expect(completed.status).toBe("completed");
    expect(treeBody).toMatchObject({
      base_tree: "tree-1",
      tree: [
        { path: `memes/${repository.memeId}.jpg` },
        { path: "context/story.md" },
        { path: expect.stringContaining(".github/meme-worker/deliveries/") },
      ],
    });
  });

  it("re-reads and re-derives saga content after a ref conflict", async () => {
    let headReads = 0;
    let patchAttempts = 0;
    let blob = 0;
    const canons: ReadonlyArray<string> = [];
    let observedCanons = canons;
    const api = makeApi((request) => {
      if (
        request.method === "GET" &&
        request.path.includes("/git/ref/heads/")
      ) {
        headReads += 1;
        return Effect.succeed({ object: { sha: `head-${headReads}` } });
      }
      if (request.method === "GET" && request.path.includes("/contents/")) {
        if (request.path.includes("/contents/context/")) {
          const ref = request.path.includes("head-2") ? "two" : "one";
          return Effect.succeed({
            content: Buffer.from(`Canon ${ref}`).toString("base64"),
            encoding: "base64",
          });
        }
        return Effect.fail(notFound(request.path));
      }
      if (request.method === "GET" && request.path.includes("/git/commits/")) {
        return Effect.succeed({
          sha: `head-${headReads}`,
          tree: { sha: `tree-${headReads}` },
        });
      }
      if (request.method === "POST" && request.path.endsWith("/git/blobs")) {
        blob += 1;
        return Effect.succeed({ sha: `blob-${blob}` });
      }
      if (request.method === "POST" && request.path.endsWith("/git/trees")) {
        return Effect.succeed({ sha: `new-tree-${headReads}` });
      }
      if (request.method === "POST" && request.path.endsWith("/git/commits")) {
        return Effect.succeed({ sha: `new-commit-${headReads}` });
      }
      if (request.method === "PATCH" && request.path.includes("/git/refs/")) {
        patchAttempts += 1;
        return patchAttempts === 1
          ? Effect.fail(
              new HostedGitHubError({
                detail: "ref conflict",
                operation: "update ref",
                status: 422,
              }),
            )
          : Effect.succeed({});
      }
      return Effect.fail(notFound(request.path));
    });
    const repository = makeHostedGitHubRepository({
      api,
      branch: "main",
      task,
    });

    await Effect.runPromise(
      repository.complete({
        outcome: { ...outcome, memeId: repository.memeId },
        saga: {
          derive: (canon) =>
            Effect.sync(() => {
              observedCanons = [...observedCanons, canon];
              return `${canon}\nupdated`;
            }),
          path: "context/story.md",
        },
      }),
    );

    expect(observedCanons).toEqual(["Canon one", "Canon two"]);
    expect(patchAttempts).toBe(2);
  });

  it("does not duplicate a completion comment or a claimed Slack send", async () => {
    const encode = Schema.encodeSync(Schema.parseJson(Schema.Unknown));
    const completed = {
      deliveryId: task.deliveryId,
      issueNumber: task.issueNumber,
      memeId: "meme-id",
      outcome,
      repo: task.repo,
      slack: "claimed",
      status: "completed",
      version: 1,
    };
    let comments: ReadonlyArray<{
      readonly body: string;
      readonly id: number;
    }> = [];
    let posts = 0;
    const api = makeApi((request) => {
      if (
        request.method === "GET" &&
        request.path.includes("/git/ref/heads/")
      ) {
        return Effect.succeed({ object: { sha: "head" } });
      }
      if (
        request.method === "GET" &&
        request.path.includes("/contents/.github")
      ) {
        return Effect.succeed({
          content: Buffer.from(encode(completed)).toString("base64"),
          encoding: "base64",
        });
      }
      if (
        request.method === "GET" &&
        request.path.includes("/issues/42/comments")
      ) {
        return Effect.succeed(comments);
      }
      if (
        request.method === "POST" &&
        request.path.includes("/issues/42/comments")
      ) {
        posts += 1;
        const body = (request.body as { readonly body: string }).body;
        comments = [{ body, id: 1 }];
        return Effect.succeed({});
      }
      return Effect.fail(notFound(request.path));
    });
    const repository = makeHostedGitHubRepository({
      api,
      branch: "main",
      task,
    });

    expect(await Effect.runPromise(repository.claimSlack())).toBe(false);
    await Effect.runPromise(repository.commentOnce("Done"));
    await Effect.runPromise(repository.commentOnce("Done"));

    expect(posts).toBe(1);
  });
});
