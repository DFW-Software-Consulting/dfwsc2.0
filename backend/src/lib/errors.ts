export class AppError extends Error {
  statusCode: number;
  code?: string;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const errors = {
  notFound: (resource: string) => new AppError(`${resource} not found`, 404, "NOT_FOUND"),
  unauthorized: (msg = "Authentication required") => new AppError(msg, 401, "UNAUTHORIZED"),
  forbidden: (msg = "Insufficient permissions") => new AppError(msg, 403, "FORBIDDEN"),
  badRequest: (msg: string) => new AppError(msg, 400, "BAD_REQUEST"),
  conflict: (msg: string) => new AppError(msg, 409, "CONFLICT"),
  internal: (msg = "Internal server error") => new AppError(msg, 500, "INTERNAL_ERROR"),
  stripeFailed: (msg: string) => new AppError(msg, 502, "STRIPE_FAILED"),
};
