export interface SagaDirectives {
    readSaga:  string | null;
    writeSaga: string | null;
    // The message with any read:/write:/saga: tokens removed.
    prompt:    string;
}

// Matches inline saga directives like "read:heist", "write:my-saga_2" or the
// combined "saga:heist" (read + write the same saga). The name is restricted to
// a filename-safe slug; a space after the colon (e.g. "read: the news") does
// not match, avoiding false positives.
const SAGA_DIRECTIVE = /\b(read|write|saga):([A-Za-z0-9_-]+)/gi;

/**
 * Pull the first `read:` and `write:` saga directives out of a message and
 * return the cleaned prompt with all such tokens removed. The combined
 * `saga:<name>` shorthand counts as both a read and a write of that saga. Saga
 * names are lower-cased. If stripping would empty the prompt, the original is
 * kept.
 */
export function parseSagaDirectives(message: string): SagaDirectives {
    let readSaga:  string | null = null;
    let writeSaga: string | null = null;
    for (const match of message.matchAll(SAGA_DIRECTIVE)) {
        const kind = match[1].toLowerCase();
        const name = match[2].toLowerCase();
        const isRead  = kind === "read"  || kind === "saga";
        const isWrite = kind === "write" || kind === "saga";
        if (isRead  && readSaga  == null) { readSaga  = name; }
        if (isWrite && writeSaga == null) { writeSaga = name; }
    }
    const stripped = message.replace(SAGA_DIRECTIVE, "").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim();
    const prompt = stripped === "" ? message.trim() : stripped;
    return {readSaga, writeSaga, prompt};
}
