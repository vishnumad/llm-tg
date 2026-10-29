import { logger } from "../logger";

export async function logToolCall<T>(
  event: string,
  fields: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  logger.info(event, fields);
  try {
    return await run();
  } catch (error) {
    // The SDK hands a thrown error to the model as the tool result, so it
    // would otherwise never reach the logs.
    logger.error(`${event}.failed`, error, fields);
    throw error;
  }
}
