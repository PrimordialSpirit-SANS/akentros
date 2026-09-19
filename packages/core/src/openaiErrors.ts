export interface AkentrosErrorOptions {
  status?: number;
  type?: string;
  code?: string;
  param?: string | null;
  retryAfter?: number | null;
  expose?: boolean;
}

export class AkentrosError extends Error {
  status: number;
  type: string;
  code: string;
  param: string | null;
  retryAfter: number | null;
  expose: boolean;
  requestId?: string;

  constructor(
    message: string,
    {
      status = 500,
      type = "server_error",
      code = "internal_error",
      param = null,
      retryAfter = null,
      expose = true,
    }: AkentrosErrorOptions = {},
  ) {
    super(message);
    this.name = "AkentrosError";
    this.status = status;
    this.type = type;
    this.code = code;
    this.param = param;
    this.retryAfter = retryAfter;
    this.expose = expose;
  }
}

export function openAiErrorBody(error: unknown) {
  const safe =
    error instanceof AkentrosError
      ? error
      : new AkentrosError("Akentros could not complete the request.", { expose: false });
  return {
    error: {
      message: safe.expose ? safe.message : "Akentros could not complete the request.",
      type: safe.type,
      param: safe.param ?? null,
      code: safe.code,
    },
  };
}

export function invalidRequest(message: string, param: string | null = null, code = "invalid_request") {
  return new AkentrosError(message, {
    status: 400,
    type: "invalid_request_error",
    code,
    param,
  });
}
