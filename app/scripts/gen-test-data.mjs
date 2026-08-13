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

// 课程体系表
writeXlsx('课程体系.xlsx', [
  ['班型', '课程名称', '师资名称', '时长'],
  ['一年级数学班', '整数运算', '窦峥', '90'],
  ['一年级数学班', '小数运算', '窦峥', '90'],
  ['一年级英语班', '英语阅读', '方浩', '60'],
  ['一年级英语班', '英语写作', '方浩', '60'],
]);

console.log('完成。');
