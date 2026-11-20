// One error type for the whole plugin: every failure carries the HTTP status
// and a stable `code` the client (magpie, Read Frog, Cherry Studio) can read.
// Mirrors the Worker's error table so both shapes of this project answer alike.

export class ServiceError extends Error {
  constructor(code, status, message, options = {}) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.status = status;
    this.param = options.param ?? null;
    this.retryable = options.retryable === true;
    this.headers = options.headers ?? null;
  }
}

/** A bad request from the client (400 by default). */
export const invalid = (message, code = "invalid_request", param = null) =>
  new ServiceError(code, 400, message, { param });

/** Input beyond the documented limits (413). */
export const tooLarge = (message, code = "request_too_large") =>
  new ServiceError(code, 413, message);

/** The plugin itself is not set up: no Cookie, unusable options (503). */
export const configError = (message, code = "configuration_error") =>
  new ServiceError(code, 503, message);

/** The Doubao upstream refused, broke or timed out (502/504 by default). */
export const upstreamError = (message, code = "upstream_http_error", status = 502, headers = null) =>
  new ServiceError(code, status, message, { headers });

/** The OpenAI-shaped `type` a status maps to, as the Worker answers it. */
export function errorType(status) {
  if (status === 429) return "rate_limit_error";
  if (status === 401) return "authentication_error";
  if (status < 500) return "invalid_request_error";
  return "api_error";
}

/**
 * Any thrown value as an OpenAI-shaped error body. A non-ServiceError (a bug,
 * a network TypeError) becomes a 500 rather than leaking a stack to the user.
 */
export function errorPayload(error, fallback = "Doubao Translation failed.") {
  const known = error instanceof ServiceError;
  const status = known && Number.isInteger(error.status) ? error.status : 500;
  return {
    status,
    headers: known ? error.headers : null,
    body: {
      error: {
        message: known ? error.message : fallback,
        type: errorType(status),
        code: known ? error.code : "internal_error",
        param: known ? error.param : null,
      },
    },
  };
}

/** A fetch AbortSignal timeout reads as a 504, a client hang-up as a 499. */
export function abortError(error, { timeoutSignal, requestSignal } = {}) {
  if (requestSignal?.aborted) {
    return new ServiceError("request_cancelled", 499, "Request was cancelled.");
  }
  const timedOut =
    error?.name === "TimeoutError" ||
    error?.name === "AbortError" ||
    timeoutSignal?.aborted === true;
  if (timedOut) {
    return upstreamError("Doubao request timed out.", "upstream_timeout", 504);
  }
  return null;
}
