// Throw this for expected errors: throw new AppError("Ticket not found", 404)
export class AppError extends Error {
  statusCode: number;
  isOperational = true;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, AppError.prototype);
    Error.captureStackTrace?.(this, this.constructor);
  }
}
