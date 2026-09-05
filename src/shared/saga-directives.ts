// Matches inline saga directives like "read:heist", "write:my-saga_2" or the
// combined "saga:heist" (read + write the same saga). The name is restricted to
// a filename-safe slug; a space after the colon (e.g. "read: the news") does
// not match, avoiding false positives.
const SAGA_DIRECTIVE = /\b(read|write|saga):([A-Za-z0-9_-]+)/gi;

const hasRead = (kind: string): boolean => kind === "read" || kind === "saga";

const hasWrite = (kind: string): boolean => kind === "write" || kind === "saga";

/**
 * Pull the first `read:` and `write:` saga directives out of a message and
 * return the cleaned prompt with all such tokens removed. The combined
 * `saga:<name>` shorthand counts as both a read and a write of that saga. Saga
 * names are lower-cased. If stripping would empty the prompt, the original is
 * kept.
 */
export function parseSagaDirectives(message: string) {
  const sagas = Array.from(message.matchAll(SAGA_DIRECTIVE)).reduce<{
    readonly readSaga: string | null;
    readonly writeSaga: string | null;
  }>(
    (state, match) => {
      const kind = match[1].toLowerCase();
      const name = match[2].toLowerCase();

      return {
        readSaga: state.readSaga ?? (hasRead(kind) ? name : null),
        writeSaga: state.writeSaga ?? (hasWrite(kind) ? name : null),
      };
    },
    {
      readSaga: null,
      writeSaga: null,
    },
  );
  const stripped = message
    .replace(SAGA_DIRECTIVE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  return {
    ...sagas,
    prompt: stripped === "" ? message.trim() : stripped,
  };
}
