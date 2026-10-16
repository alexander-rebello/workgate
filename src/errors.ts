export class WgError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'WgError';
    this.exitCode = exitCode;
  }
}
