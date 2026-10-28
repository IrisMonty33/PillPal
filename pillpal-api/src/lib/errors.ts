/**
 * Error type thrown anywhere in the API. The error handler middleware turns it into
 * a JSON response: { error: { code, message, details? } }.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }
  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = 'You do not have access to this resource') {
    return new ApiError(403, 'FORBIDDEN', message);
  }
  static notFound(what = 'Resource') {
    return new ApiError(404, 'NOT_FOUND', `${what} not found`);
  }
  static conflict(message: string) {
    return new ApiError(409, 'CONFLICT', message);
  }
  static unprocessable(message: string, details?: unknown) {
    return new ApiError(422, 'UNPROCESSABLE', message, details);
  }
}
