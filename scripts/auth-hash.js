import { hashPassword } from '../src/auth.js';

function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      reject(new Error('请在交互式终端中运行 npm run auth:hash。'));
      return;
    }

    let value = '';
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') {
          cleanup();
          stdout.write('\n');
          reject(new Error('已取消。'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0008' || char === '\u007f') {
          if (value) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        if (char >= ' ' && char !== '\u007f') {
          value += char;
          stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

try {
  const password = await readSecret('新密码（至少 12 个字符）：');
  const confirm = await readSecret('再次输入密码：');
  if (password !== confirm) throw new Error('两次输入的密码不一致。');
  console.log(`AUTH_PASSWORD_HASH=${hashPassword(password)}`);
} catch (error) {
  console.error(error?.message || String(error));
  process.exitCode = 1;
}
