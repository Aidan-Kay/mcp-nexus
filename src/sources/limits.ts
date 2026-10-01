/**
 * The cap on how much of one upstream response either transport will buffer.
 *
 * Both transports used to read a response to the end before looking at it, so one
 * runaway upstream — a feed with no page size, a server echoing a file — could hold
 * the whole of it in memory, and then again as a string, and again re-serialised.
 * The cap is checked as bytes arrive, so the response is abandoned at the limit
 * rather than after it has all been read.
 */

let maxResponseBytes = 32 * 1024 * 1024;

/** Set from `connectors.maxResponseBytes` at startup. */
export function configureResponseLimit(bytes: number): void {
  maxResponseBytes = bytes;
}

export function responseLimit(): number {
  return maxResponseBytes;
}

/**
 * Raised when an upstream response passes the cap. A distinct class because it must
 * not be retried: the same request would return the same response.
 */
export class ResponseTooLarge extends Error {
  constructor(limit: number) {
    super(
      `upstream response exceeded ${limit} bytes and was abandoned - ask for less (a smaller page or limit), ` +
        "or raise connectors.maxResponseBytes",
    );
    this.name = "ResponseTooLarge";
  }
}
