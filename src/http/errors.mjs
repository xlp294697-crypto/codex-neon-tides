const statusCodes = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

export class HttpError extends Error {
  constructor(status, message, code = statusCodes[status] || 'INTERNAL_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function safeApiError(error, requestId) {
  const expected = error instanceof HttpError && error.status < 500;
  // 503 messages below are application-authored availability notices.
  const unavailable = error instanceof HttpError && error.status === 503;
  return {
    status: error instanceof HttpError ? error.status : 500,
    body: {
      error: {
        code: expected || unavailable ? error.code : 'INTERNAL_ERROR',
        message:
          expected || unavailable ? error.message : '服务器暂时无法处理请求。',
        requestId,
      },
    },
  };
}
