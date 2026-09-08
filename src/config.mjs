import path from 'node:path';

function parseInteger(value, fallback, minimum, maximum, label) {
  const result = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${label} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return result;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error(`无法识别布尔配置值：${value}`);
}

function validateReportTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format();
  } catch {
    throw new Error(`REPORT_TIME_ZONE 不是受支持的 IANA 时区：${timeZone}`);
  }
}

function getPasswordProblem(password) {
  const value = String(password);
  if (value.length < 16 || value.length > 250) return '必须为 16 到 250 位';
  if (value !== value.trim()) return '首尾不能包含空白字符';
  const characterClasses = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9\s]/].filter(
    (pattern) => pattern.test(value),
  ).length;
  if (characterClasses < 3)
    return '必须包含大写字母、小写字母、数字、符号中的至少三类';
  if (/^(.)\1+$/u.test(value) || /^(.{1,8})\1+$/u.test(value))
    return '不能使用重复字符或重复片段';
  if (
    /change[_-]?me|password|passw0rd|admin|administrator|qwerty|letmein|welcome|123456|654321/i.test(
      value,
    )
  ) {
    return '不能包含常见弱口令词或数字序列';
  }
  if (/jiu[._-]?yue|jiuyue|sports?|氿悦|九悦|体育/iu.test(value))
    return '不能包含公司、品牌或体育业务名称';
  if (/1[3-9][0-9]{9}/.test(value.replace(/[^0-9]/g, '')))
    return '不能包含手机号码';
  return '';
}

export function loadConfig(env, root) {
  const publicRoot = path.join(root, 'public');
  const dataPath = path.resolve(
    env.DATA_PATH || path.join(root, 'data', 'site.db'),
  );
  const adminPassword = env.ADMIN_PASSWORD || '';
  const adminPasswordHash = env.ADMIN_PASSWORD_HASH || '';
  const sessionSecret = env.SESSION_SECRET || '';
  const reportTimeZone =
    String(env.REPORT_TIME_ZONE || 'Asia/Shanghai').trim() || 'Asia/Shanghai';

  if (!adminPassword && !adminPasswordHash) {
    throw new Error(
      '缺少 ADMIN_PASSWORD 或 ADMIN_PASSWORD_HASH；正式程序不会使用默认后台密码。',
    );
  }
  if (adminPassword) {
    const problem = getPasswordProblem(adminPassword);
    if (problem) throw new Error(`ADMIN_PASSWORD ${problem}。`);
  }
  if (
    adminPasswordHash &&
    !/^scrypt\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{40,}$/.test(adminPasswordHash)
  ) {
    throw new Error(
      'ADMIN_PASSWORD_HASH 格式无效；请使用工具包中的密码哈希生成器。',
    );
  }
  if (sessionSecret.length < 32 || /change[_-]?me/i.test(sessionSecret)) {
    throw new Error(
      'SESSION_SECRET 必须是至少 32 位的随机值，且不能使用示例占位值。',
    );
  }
  const relativeToPublic = path.relative(publicRoot, dataPath);
  if (
    !relativeToPublic.startsWith('..') &&
    !path.isAbsolute(relativeToPublic)
  ) {
    throw new Error('DATA_PATH 不能位于 public 目录中。');
  }
  validateReportTimeZone(reportTimeZone);

  return Object.freeze({
    root,
    publicRoot,
    mediaRoot: path.join(publicRoot, 'media'),
    dataPath,
    nodeEnv: env.NODE_ENV || '',
    host: env.HOST || '127.0.0.1',
    port: parseInteger(env.PORT, 3002, 1, 65535, 'PORT'),
    maxBodyBytes: parseInteger(
      env.MAX_BODY_BYTES,
      65536,
      1024,
      1048576,
      'MAX_BODY_BYTES',
    ),
    eventRetentionDays: parseInteger(
      env.EVENT_RETENTION_DAYS,
      180,
      7,
      3650,
      'EVENT_RETENTION_DAYS',
    ),
    maxEventRecords: parseInteger(
      env.MAX_EVENT_RECORDS,
      25000,
      1000,
      1000000,
      'MAX_EVENT_RECORDS',
    ),
    maxInquiryRecords: parseInteger(
      env.MAX_INQUIRY_RECORDS,
      10000,
      100,
      100000,
      'MAX_INQUIRY_RECORDS',
    ),
    sessionHours: parseInteger(env.SESSION_HOURS, 8, 1, 72, 'SESSION_HOURS'),
    trustProxy: parseBoolean(env.TRUST_PROXY, false),
    cookieSecure: parseBoolean(
      env.COOKIE_SECURE,
      env.NODE_ENV === 'production',
    ),
    enableHsts: parseBoolean(env.ENABLE_HSTS, false),
    adminPassword,
    adminPasswordHash,
    sessionSecret,
    icpNumber: String(env.ICP_NUMBER || '')
      .trim()
      .slice(0, 80),
    reportTimeZone,
  });
}
