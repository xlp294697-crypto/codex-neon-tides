import { safeEqual } from './auth.mjs';
import { getText } from '../validation/common.mjs';
import { HttpError } from '../http/errors.mjs';

export function requireCsrf(req, session) {
  if (
    !safeEqual(getText(req.headers['x-csrf-token'], 200), session.csrfToken)
  ) {
    throw new HttpError(403, '安全校验失败，请刷新后台后重试。');
  }
}
