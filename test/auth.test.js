import assert from 'node:assert/strict';
import { createAuth, hashPassword, verifyPassword } from '../src/auth.js';

const password = 'correct horse battery staple';
const passwordHash = hashPassword(password);
assert.doesNotMatch(passwordHash, /correct|battery|staple/);
assert.equal(verifyPassword(password, passwordHash), true);
assert.equal(verifyPassword('wrong password', passwordHash), false);

const secureRequest = (cookie = '') => ({
  headers: { 'x-forwarded-proto': 'https', cookie },
  socket: { remoteAddress: '127.0.0.1' },
});

const auth = createAuth({
  email: 'jaychougo@gmail.com',
  passwordHash,
  requireHttps: true,
  trustProxy: true,
});

const login = auth.login(secureRequest(), { email: 'jaychougo@gmail.com', password });
assert.equal(login.status, 200);
assert.match(login.headers['Set-Cookie'], /^grid_session=.+HttpOnly/);
const cookie = login.headers['Set-Cookie'].split(';', 1)[0];
assert.equal(auth.status(secureRequest(cookie)).authenticated, true);
assert.equal(auth.status(secureRequest(cookie)).email, 'jaychougo@gmail.com');
assert.match(login.headers['Set-Cookie'], /Secure/);
assert.match(login.headers['Set-Cookie'], /SameSite=Strict/);
assert.equal(auth.login(secureRequest(), { email: 'other@example.com', password }).status, 401);
assert.equal(auth.login({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }, { email: 'jaychougo@gmail.com', password }).status, 400);
assert.doesNotThrow(() => auth.status({ headers: { cookie: 'grid_session=%E0%A4%A' }, socket: {} }));
assert.equal(auth.logout(secureRequest(cookie)).status, 200);
assert.equal(auth.status(secureRequest(cookie)).authenticated, false);
assert.equal(createAuth({ passwordHash: '' }).login(secureRequest(), { email: 'jaychougo@gmail.com', password }).status, 503);

console.log('auth tests passed');
