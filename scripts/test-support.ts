import { Cause, Exit } from "effect";

export const failureOrThrow = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) {
    throw new Error("Expected the effect to fail");
  }

  if (!Cause.isFailType(exit.cause)) {
    throw new Error("Expected a single typed failure");
  }

  return exit.cause.error;
};

type ErrorConstructor<E extends Error> = abstract new (
  ...args: ReadonlyArray<never>
) => E;

export const failureOfType = <A, E, Expected extends Error>(
  exit: Exit.Exit<A, E>,
  constructor: ErrorConstructor<Expected>,
): Expected => {
  const error: unknown = failureOrThrow(exit);
  if (!(error instanceof constructor)) {
    throw new Error(`Expected ${constructor.name}`);
  }

  return error;
};
