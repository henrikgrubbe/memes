import { Effect, Exit } from "effect";
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
      return Effect.succeed({ tree: { sha: "tree-1" } });
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

  it("commits the Saga canon and minimal fold receipt atomically", async () => {
    let treeBody: unknown;
    let blobs: ReadonlyArray<string> = [];
    const api = makeApi(
      gitDataHandler((request) => {
        if (request.method === "POST" && request.path.endsWith("/git/blobs")) {
          const body = request.body as { readonly content: string };
          blobs = [...blobs, body.content];
        }
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

    const folded = await Effect.runPromise(
      repository.foldSaga({
        derive: (canon) => Effect.succeed(`${canon}\nNew beat`),
        name: "story",
        path: "context/story.md",
      }),
    );

    expect(folded).toBe(true);
    expect(treeBody).toMatchObject({
      base_tree: "tree-1",
      tree: [
        { path: "context/story.md" },
        { path: expect.stringContaining(".github/meme-worker/saga-folds/") },
      ],
    });
    const receipt = blobs
      .map((content) => {
        try {
          return JSON.parse(content) as unknown;
        } catch {
          return null;
        }
      })
      .find((content) => content != null);
    expect(receipt).toEqual({
      deliveryId: "delivery-1",
      folded: true,
      saga: "story",
    });
    expect(JSON.stringify(treeBody)).not.toContain("deliveries/");
  });

  it("uses an existing Saga fold receipt without reapplying the contribution", async () => {
    let writes = 0;
    const receipt = JSON.stringify({
      deliveryId: task.deliveryId,
      folded: true,
      saga: "story",
    });
    const api = makeApi((request) => {
      if (
        request.method === "GET" &&
        request.path.includes("/git/ref/heads/")
      ) {
        return Effect.succeed({ object: { sha: "head-1" } });
      }
      if (
        request.method === "GET" &&
        request.path.includes("/contents/.github/meme-worker/saga-folds/")
      ) {
        return Effect.succeed({
          content: Buffer.from(receipt).toString("base64"),
          encoding: "base64",
        });
      }
      writes += 1;
      return Effect.fail(notFound(request.path));
    });
    const repository = makeHostedGitHubRepository({
      api,
      branch: "main",
      task,
    });
    let derives = 0;

    const folded = await Effect.runPromise(
      repository.foldSaga({
        derive: () =>
          Effect.sync(() => {
            derives += 1;
            return "duplicate";
          }),
        name: "story",
        path: "context/story.md",
      }),
    );

    expect(folded).toBe(false);
    expect(derives).toBe(0);
    expect(writes).toBe(0);
  });

  it("re-reads and re-derives Saga content after a ref conflict", async () => {
    let headReads = 0;
    let patchAttempts = 0;
    let blob = 0;
    let observedCanons: ReadonlyArray<string> = [];
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
        return Effect.succeed({ tree: { sha: `tree-${headReads}` } });
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
      repository.foldSaga({
        derive: (canon) =>
          Effect.sync(() => {
            observedCanons = [...observedCanons, canon];
            return `${canon}\nupdated`;
          }),
        name: "story",
        path: "context/story.md",
      }),
    );

    expect(observedCanons).toEqual(["Canon one", "Canon two"]);
    expect(patchAttempts).toBe(2);
  });

  it("creates, reuses, and updates the idempotent completion comment", async () => {
    let comments: ReadonlyArray<{
      readonly body: string;
      readonly id: number;
    }> = [];
    let posts = 0;
    let patches = 0;
    const api = makeApi((request) => {
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
      if (
        request.method === "PATCH" &&
        request.path.includes("/issues/comments/1")
      ) {
        patches += 1;
        return Effect.succeed({});
      }
      return Effect.fail(notFound(request.path));
    });
    const repository = makeHostedGitHubRepository({
      api,
      branch: "main",
      task,
    });

    await Effect.runPromise(repository.commentOnce("Done"));
    await Effect.runPromise(repository.commentOnce("Done"));
    await Effect.runPromise(repository.commentOnce("Done with details"));

    expect(posts).toBe(1);
    expect(patches).toBe(1);
  });

  it("closes issues with the requested state reason", async () => {
    let body: unknown;
    const repository = makeHostedGitHubRepository({
      api: makeApi((request) => {
        body = request.body;
        return Effect.succeed({});
      }),
      branch: "main",
      task,
    });

    await Effect.runPromise(repository.closeIssue("not_planned"));

    expect(body).toEqual({ state: "closed", state_reason: "not_planned" });
  });
});
