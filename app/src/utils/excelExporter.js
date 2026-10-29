import * as XLSX from 'xlsx';
import { abbreviateClassType } from './classRegistry.js';

/**
 * 导出排课结果为 Excel 文件
 * 格式：班级 | 课程名称 | 日期 | 授课时间（开始-结束） | 授课师资
 * @param {Array} courses 排课结果
 * @param {string} fileName 导出文件名
 * @param {boolean} [abbreviateClass=false] 是否将班级缩写为批量简称（v6.0.8）
 */
export function exportScheduledToExcel(courses, fileName = '排课结果.xlsx', abbreviateClass = false) {
  if (!courses || courses.length === 0) {
    alert('暂无排课数据可导出');
    return;
  }

  const aoa = [
    ['班级', '课程名称', '日期', '授课时间', '授课师资'],
    ...courses.map(c => [
      abbreviateClass ? abbreviateClassType(c.classType || '') : (c.classType || ''),
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

/**
 * 导出原始师资空闲时间表为 Excel 文件
 * 格式：师资名称 | 日期 | 开始时间 | 结束时间（首行可选写入备注说明）
 * @param {Array} availabilityData 原始空闲时间表数据 [{teacher, date, startTime, endTime}]
 * @param {string} fileName 导出文件名
 * @param {string} [note] 备注说明（可选，写入首行）
 */
export function exportAvailabilityToExcel(availabilityData, fileName, note = '') {
  if (!availabilityData || availabilityData.length === 0) {
    alert('暂无空闲时间表数据可导出');
    return;
  }

  const aoa = [];
  if (note) aoa.push(['备注', note], []);
  aoa.push(['师资名称', '日期', '开始时间', '结束时间']);
  availabilityData.forEach(a => {
    aoa.push([a.teacher || '', a.date || '', a.startTime || '', a.endTime || '']);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // 设置列宽
  ws['!cols'] = [
    { wch: 14 },
    { wch: 14 },
    { wch: 12 },
    { wch: 12 }
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '空闲时间表');
  XLSX.writeFile(wb, fileName);
}
