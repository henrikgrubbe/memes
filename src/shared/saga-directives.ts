// Matches inline saga directives like "read:heist", "write:my-saga_2",
// "print:heist", "print:all", "list:sagas", or the combined "saga:heist"
// (read + write the same saga). The name is restricted to a filename-safe
// slug; a space after the colon (e.g. "read: the news") does not match,
// avoiding false positives.
const SAGA_DIRECTIVE = /\b(read|write|print|saga):([A-Za-z0-9_-]+)|\blist:sagas\b/gi;

const hasRead = (kind: string): boolean => kind === "read" || kind === "saga";

const hasWrite = (kind: string): boolean => kind === "write" || kind === "saga";

/**
 * Pull saga directives out of a message and return the cleaned prompt with all
 * such tokens removed. Every distinct `read:` target is kept in order; the
 * first `write:` and `print:` target win. `print:all` and `list:sagas` list
 * every current saga. The combined `saga:<name>` shorthand reads and writes
 * that saga. Saga names are lower-cased. If stripping would empty a generation
 * request, its original prompt is kept; an inspection request intentionally
 * keeps an empty prompt.
 */
export function parseSagaDirectives(message: string) {
  const sagas = Array.from(message.matchAll(SAGA_DIRECTIVE)).reduce<{
    readonly listSagas: boolean;
    readonly printSaga: string | null;
    readonly readSagas: ReadonlyArray<string>;
    readonly writeSaga: string | null;
  }>(
    (state, match) => {
      if (match[0].toLowerCase() === "list:sagas") {
        return { ...state, listSagas: true };
      }
      const kind = match[1].toLowerCase();
      const name = match[2].toLowerCase();
      if (kind === "print" && name === "all") {
        return { ...state, listSagas: true };
      }

      return {
        listSagas: state.listSagas,
        printSaga: state.printSaga ?? (kind === "print" ? name : null),
        readSagas:
          hasRead(kind) && !state.readSagas.includes(name)
            ? [...state.readSagas, name]
            : state.readSagas,
        writeSaga: state.writeSaga ?? (hasWrite(kind) ? name : null),
      };
    },
    {
      listSagas: false,
      printSaga: null,
      readSagas: [],
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
    prompt:
      stripped === "" && sagas.printSaga == null && !sagas.listSagas ? message.trim() : stripped,
  };
}
