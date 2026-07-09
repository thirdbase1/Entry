export class InternalServerError extends Error {
  readonly status = 500;
  constructor(message: string) {
    super(message);
    this.name = 'InternalServerError';
  }
}
