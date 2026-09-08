import { randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');

function getPasswordProblem(value) {
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

const passwordProblem = getPasswordProblem(password);
if (passwordProblem) {
  console.error(`管理员密码${passwordProblem}。`);
  process.exit(1);
}

const salt = randomBytes(18);
const hash = scryptSync(password, salt, 64);
const result = {
  ADMIN_PASSWORD_HASH: `scrypt.${salt.toString('base64url')}.${hash.toString('base64url')}`,
  SESSION_SECRET: randomBytes(48).toString('base64url'),
};

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(result));
} else {
  process.stdout.write(
    `ADMIN_PASSWORD_HASH=${result.ADMIN_PASSWORD_HASH}\nSESSION_SECRET=${result.SESSION_SECRET}\n`,
  );
}
