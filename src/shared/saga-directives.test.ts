import { describe, expect, it } from "vitest";
import { parseSagaDirectives } from "./saga-directives.js";

describe("parseSagaDirectives", () => {
  it("returns no sagas and the untouched prompt when there are no directives", () => {
    const r = parseSagaDirectives("a cat riding a bike");
    expect(r).toEqual({
      listSagas: false,
      printSaga: null,
      readSagas: [],
      writeSaga: null,
      prompt: "a cat riding a bike",
    });
  });

  it("extracts read and write sagas and strips the tokens from the prompt", () => {
    const r = parseSagaDirectives("read:heist a cat cracks a safe write:heist");
    expect(r.readSagas).toEqual(["heist"]);
    expect(r.writeSaga).toBe("heist");
    expect(r.prompt).toBe("a cat cracks a safe");
  });

  it("lower-cases saga names and is case-insensitive on the keyword", () => {
    const r = parseSagaDirectives("READ:StarWars luke as a cat");
    expect(r.readSagas).toEqual(["starwars"]);
    expect(r.writeSaga).toBeNull();
    expect(r.prompt).toBe("luke as a cat");
  });

  it("allows reading one saga while contributing to another", () => {
    const r = parseSagaDirectives("write:sequel read:origin a plot twist");
    expect(r.readSagas).toEqual(["origin"]);
    expect(r.writeSaga).toBe("sequel");
    expect(r.prompt).toBe("a plot twist");
  });

  it("keeps every distinct read target while using the first write target", () => {
    const r = parseSagaDirectives("read:one read:two write:a write:b hello");
    expect(r.readSagas).toEqual(["one", "two"]);
    expect(r.writeSaga).toBe("a");
    expect(r.prompt).toBe("hello");
  });

  it("does not treat 'read: the news' (space after colon) as a directive", () => {
    const r = parseSagaDirectives("read: the news headline");
    expect(r.readSagas).toEqual([]);
    expect(r.prompt).toBe("read: the news headline");
  });

  it("accepts slug names with digits, dashes and underscores", () => {
    const r = parseSagaDirectives("write:saga_2-b something");
    expect(r.writeSaga).toBe("saga_2-b");
    expect(r.prompt).toBe("something");
  });

  it("treats saga:<name> as both a read and a write of that saga", () => {
    const r = parseSagaDirectives("saga:mar rune paints a cup");
    expect(r.readSagas).toEqual(["mar"]);
    expect(r.writeSaga).toBe("mar");
    expect(r.prompt).toBe("rune paints a cup");
  });

  it("is case-insensitive on the saga: shorthand and lower-cases the name", () => {
    const r = parseSagaDirectives("SAGA:StarWars luke as a cat");
    expect(r.readSagas).toEqual(["starwars"]);
    expect(r.writeSaga).toBe("starwars");
    expect(r.prompt).toBe("luke as a cat");
  });

  it("lets an explicit read/write override the saga: shorthand target", () => {
    const r = parseSagaDirectives("read:origin saga:mar a plot twist");
    expect(r.readSagas).toEqual(["origin", "mar"]);
    expect(r.writeSaga).toBe("mar");
    expect(r.prompt).toBe("a plot twist");
  });

  it("does not treat 'saga: the epic' (space after colon) as a directive", () => {
    const r = parseSagaDirectives("saga: the epic tale");
    expect(r.readSagas).toEqual([]);
    expect(r.writeSaga).toBeNull();
    expect(r.prompt).toBe("saga: the epic tale");
  });

  it("de-duplicates repeated read targets without changing their order", () => {
    const r = parseSagaDirectives(
      "read:one read:two read:one draw a crossover",
    );
    expect(r.readSagas).toEqual(["one", "two"]);
    expect(r.prompt).toBe("draw a crossover");
  });

  it("parses a print directive as a standalone context-inspection command", () => {
    const r = parseSagaDirectives("PRINT:Heist");
    expect(r.printSaga).toBe("heist");
    expect(r.readSagas).toEqual([]);
    expect(r.writeSaga).toBeNull();
    expect(r.prompt).toBe("");
  });

  it("parses list:sagas as a standalone Saga-inspection command", () => {
    const r = parseSagaDirectives("LIST:SAGAS");
    expect(r.listSagas).toBe(true);
    expect(r.printSaga).toBeNull();
    expect(r.readSagas).toEqual([]);
    expect(r.writeSaga).toBeNull();
    expect(r.prompt).toBe("");
  });

  it("parses print:all as a list command without a separate Slack keyword", () => {
    const r = parseSagaDirectives("PRINT:ALL");
    expect(r.listSagas).toBe(true);
    expect(r.printSaga).toBeNull();
    expect(r.readSagas).toEqual([]);
    expect(r.writeSaga).toBeNull();
    expect(r.prompt).toBe("");
  });

  it("does not treat a different list target as a Saga directive", () => {
    const r = parseSagaDirectives("list:stories");
    expect(r.listSagas).toBe(false);
    expect(r.prompt).toBe("list:stories");
  });
});
