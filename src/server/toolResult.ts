import { AsyncLocalStorage } from "node:async_hooks";

export const RETURNED_COUNT = Symbol("mcp-wordpress.returned-count");

interface ReturnedCountContext {
  [RETURNED_COUNT]: number | null;
  failed: boolean;
}

const returnedCountStorage = new AsyncLocalStorage<ReturnedCountContext>();

function setReturnedCount(returnedCount: number): void {
  if (!Number.isSafeInteger(returnedCount) || returnedCount < 0) return;
  const context = returnedCountStorage.getStore();
  if (context) context[RETURNED_COUNT] = returnedCount;
}

export function countedText(text: string, returnedCount: number): string {
  setReturnedCount(returnedCount);
  return text;
}

export function withReturnedCount<T>(result: T, returnedCount: number): T {
  setReturnedCount(returnedCount);
  return result;
}

/** Marks a text result that reports a failure, so usage records it as one; the client text is unchanged. */
export function failedText(text: string): string {
  const context = returnedCountStorage.getStore();
  if (context) context.failed = true;
  return text;
}

export async function captureReturnedCount<T>(operation: () => Promise<T>): Promise<{
  result: T;
  returnedCount: number | null;
  failed: boolean;
}> {
  const context: ReturnedCountContext = { [RETURNED_COUNT]: null, failed: false };
  const result = await returnedCountStorage.run(context, operation);
  return { result, returnedCount: context[RETURNED_COUNT], failed: context.failed };
}
