export class PermissionDeniedError extends Error {
  public readonly code = "FORBIDDEN";
  public readonly status = 403;
  public readonly reason: string;

  constructor(reason: string = "permission_denied") {
    super("Access denied");
    this.name = "PermissionDeniedError";
    this.reason = reason;
  }
}
