import { test } from 'node:test';
import assert from 'node:assert';

// dotenv never overrides vars that are already set, so these win over server/.env.
process.env.USE_REDIS = 'false';
process.env.NODE_ENV = 'test';
process.env.DEV_OTP_CODE = '123456';
process.env.DATABASE_URL ||= 'postgres://test';
process.env.APP_JWT_SECRET ||= 'test';

const { issueOtp, consumeOtp } = await import('./otp.js');

const guessWrong = async (userId, times) => {
  for (let i = 0; i < times; i++) {
    assert.strictEqual((await consumeOtp(userId, 'login', '000000')).ok, false);
  }
};

test('issuing a new code does not reset the failed-guess count', async () => {
  await issueOtp('locked-user', 'login');
  await guessWrong('locked-user', 5);
  await issueOtp('locked-user', 'login');
  const result = await consumeOtp('locked-user', 'login', '123456');
  assert.deepStrictEqual(result, { ok: false, error: 'Too many attempts. Try again later.' });
});

test('a correct code still works below the limit, across re-issues', async () => {
  await issueOtp('typo-user', 'login');
  await guessWrong('typo-user', 2);
  await issueOtp('typo-user', 'login');
  await guessWrong('typo-user', 2);
  assert.strictEqual((await consumeOtp('typo-user', 'login', '123456')).ok, true);
});

test('guesses with no outstanding code cannot lock an account', async () => {
  await guessWrong('idle-user', 10);
  await issueOtp('idle-user', 'login');
  assert.strictEqual((await consumeOtp('idle-user', 'login', '123456')).ok, true);
});
