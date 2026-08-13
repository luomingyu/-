import * as XLSX from 'xlsx';

/**
 * 导出排课结果为 Excel 文件
 * 格式：班级 | 课程名称 | 日期 | 授课时间（开始-结束） | 授课师资
 */
export function exportScheduledToExcel(courses, fileName = '排课结果.xlsx') {
  if (!courses || courses.length === 0) {
    alert('暂无排课数据可导出');
    return;
  }

  const aoa = [
    ['班级', '课程名称', '日期', '授课时间', '授课师资'],
    ...courses.map(c => [
      c.classType || '',
      c.name || '',
      c.date || '',
      `${c.startTime || ''} - ${c.endTime || ''}`,
      c.teacher || ''
    ])
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // 设置列宽
  ws['!cols'] = [
    { wch: 12 },
    { wch: 14 },
    { wch: 14 },
    { wch: 18 },
    { wch: 12 }
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '排课结果');
  XLSX.writeFile(wb, fileName);
}
