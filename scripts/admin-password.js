const readline = require('node:readline');
const { Writable } = require('node:stream');
const { hashPassword } = require('../src/services/auth');

async function main() {
  let password;
  if (process.stdin.isTTY) {
    const hiddenOutput = new Writable({ write(chunk, encoding, callback) { callback(); } });
    const rl = readline.createInterface({ input: process.stdin, output: hiddenOutput, terminal: true });
    const ask = prompt => new Promise(resolve => {
      process.stdout.write(prompt);
      rl.question('', answer => { process.stdout.write('\n'); resolve(answer); });
    });
    rl.on('SIGINT', () => { rl.close(); process.exit(1); });
    password = await ask('設定後台密碼（至少 16 字元，輸入不顯示）：');
    const confirmation = await ask('再次輸入密碼：');
    rl.close();
    if (password !== confirmation) throw new Error('兩次密碼不一致。');
  } else {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  const hash = await hashPassword(password);
  password = '';
  // 僅輸出雜湊；密碼不經命令列參數、檔案或紀錄傳遞。
  process.stdout.write(`ADMIN_PASSWORD_HASH=${hash}\n`);
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });
