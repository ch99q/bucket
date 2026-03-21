/**
 * Bucket-specific error type reused by drivers and the core runtime.
 */
export class BucketError extends Error {
  /**
   * @param {"NO_PROVIDER" | "UNSUPPORTED" | "BAD_REQUEST" | "PROVIDER_FAILED" | "ABORTED"} code
   * @param {string} msg
   * @param {unknown} [cause]
   */
  constructor(code, msg, cause) {
    super(msg);
    this.name = "BucketError";
    this.code = code;
    this.cause = cause;
  }
}
