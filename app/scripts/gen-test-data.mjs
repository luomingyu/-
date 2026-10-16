// 生成测试用 Excel 文件（8月数据，用于端到端验证）
import * as XLSX from 'xlsx';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'test-data');
mkdirSync(outDir, { recursive: true });

function writeXlsx(fileName, aoa) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  writeFileSync(join(outDir, fileName), buf);
  console.log('  ✓', fileName);
}

console.log('生成测试数据到:', outDir);

// 空闲时间文件 1：窦峥（4 个晚上）
writeXlsx('空闲时间1-窦峥.xlsx', [
  ['师资名称', '日期', '开始时间', '结束时间'],
  ['窦峥', '2026-08-05', '19:00', '21:00'],
  ['窦峥', '2026-08-12', '19:00', '21:00'],
  ['窦峥', '2026-08-19', '19:00', '21:00'],
  ['窦峥', '2026-08-26', '19:00', '21:00'],
]);

// 空闲时间文件 2：方浩（4 个晚上）—— 用于验证多文件累积
writeXlsx('空闲时间2-方浩.xlsx', [
  ['师资名称', '日期', '开始时间', '结束时间'],
  ['方浩', '2026-08-06', '19:00', '21:00'],
  ['方浩', '2026-08-13', '19:00', '21:00'],
  ['方浩', '2026-08-20', '19:00', '21:00'],
  ['方浩', '2026-08-27', '19:00', '21:00'],
]);

// 课程体系表（v5.74 班级归类验证：精确标准名 / 别名最长优先 / 合班课 / 区间写法 / 28 考研班 / 未识别保留原值）
writeXlsx('课程体系.xlsx', [
  ['班级', '课程名称', '师资名称', '时长'],
  ['27早鸟', '考研英语阅读', '窦峥', '90'],                    // 精确标准名
  ['27早鸟暑期强基班', '考研英语写作', '窦峥', '90'],           // 别名 → 最长优先归类 27早鸟暑期强基
  ['27全程2期', '考研政治精讲', '方浩', '60'],                  // 精确标准名
  ['27全程第2期,27早鸟班', '考研数学合班', '方浩', '120'],      // 特征匹配 + 别名合班 → 27全程2期,27早鸟
  ['27全程1-4期', '考研英语区间合班', '窦峥', '90'],            // 区间写法 → 展开 4 个标准班级
  ['28早鸟3期', '考研数学冲刺', '方浩', '90'],                  // 28 早鸟精确标准名
  ['28早鸟1-5期', '28考研合班课', '窦峥', '120'],               // 28 区间写法 → 展开 5 个标准班级
  ['一年级数学班', '未识别班级课程', '窦峥', '60'],
]);

console.log('完成。');
