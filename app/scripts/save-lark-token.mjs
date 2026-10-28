// 把当前终端里的飞书凭证保存到本机，供后台服务（开机自启的 node 进程）调用 lark-cli 使用
// 用法：在已登录飞书的 Trae 终端执行 npm run lark:token
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const token = process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN;
if (!token) {
  console.error('未检测到 LARKSUITE_CLI_USER_ACCESS_TOKEN，请在已登录飞书的 Trae 终端中运行本命令');
  process.exit(1);
}

const dir = path.join(os.homedir(), '.lark-cli');
const file = path.join(dir, 'trae-credentials.json');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file, JSON.stringify({
  userAccessToken: token,
  appId: process.env.LARKSUITE_CLI_APP_ID || '',
  brand: process.env.LARKSUITE_CLI_BRAND || 'feishu',
  savedAt: new Date().toISOString()
}, null, 2), 'utf8');

console.log(`已保存飞书凭证：${file}`);
