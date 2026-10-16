// 课程体系表渲染（多文件树形折叠 + 紧凑表格 + 状态列，事件委托删除）
import { getCourseSystemStats } from '../state/selectors.js';
import { analyzeSheetForms, sheetKeyOf } from '../utils/sheetForm.js';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderCourseSystem(state) {
  const content = document.getElementById('courseSystemTreeContent');
  const countEl = document.getElementById('courseSystemCount');
  if (!content) return;

  const files = state.courseSystemFiles || [];
  const data = state.courseSystemData || [];
  if (countEl) countEl.textContent = `${data.length} 条`;

  // section 折叠态
  const sectionEl = content.closest('.tree-section');
  if (sectionEl) {
    sectionEl.classList.toggle('collapsed', !!state.ui?.sectionCollapsed?.courseSystem);
  }

  if (files.length === 0) {
    content.innerHTML = '<div class="course-system-empty">请上传课程体系表 Excel 文件</div>';
    return;
  }

  const stats = getCourseSystemStats(state);
  const showStatusCol = data.some(i => i.scheduled !== null);

  // 顶部紧凑统计
  let html = `
    <div class="course-system-stats">
      <div class="course-system-stat-item">
        <div class="course-system-stat-value">${stats.uniqueClasses}</div>
        <div class="course-system-stat-label">班型</div>
      </div>
      <div class="course-system-stat-item">
        <div class="course-system-stat-value">${stats.uniqueTeachers}</div>
        <div class="course-system-stat-label">师资</div>
      </div>
      ${stats.unscheduledCount > 0 ? `
      <div class="course-system-stat-item unscheduled-stat">
        <div class="course-system-stat-value">${stats.unscheduledCount}</div>
        <div class="course-system-stat-label">未排</div>
      </div>` : ''}
    </div>
  `;

  // 文件节点列表
  files.forEach(file => {
    const collapsed = state.ui.fileCollapsed[file.id];
    const itemCount = file.items.length;
    // v5.83：混合形态子表（既有合班课之前的普通课、又有合班课之后的普通课）暂不做排课处理——
    // 整表跳过排课，此处红标高亮并标记「混」状态，明确报错提示
    const { mixedSheets } = analyzeSheetForms(file.items || []);
    const mixedKeys = new Set((mixedSheets || []).map(m => m.sheetKey));
    html += `
      <div class="file-node ${collapsed ? 'collapsed' : ''}">
        <div class="file-node__header" data-action="toggle-file" data-file-id="${file.id}">
          <span class="file-node__toggle">▼</span>
          <span class="file-node__icon">📁</span>
          <span class="file-node__name">${escapeHtml(file.fileName)}</span>
          <span class="file-node__count">${itemCount}</span>
          <button class="delete-btn" data-action="delete-course-file" data-file-id="${file.id}">删除</button>
        </div>
        <div class="file-node__body">
    `;
    if (itemCount === 0) {
      html += '<div class="file-node__empty">该文件无条目</div>';
    } else {
      // 紧凑表格（横向滚动容器包裹）
      html += `<div class="course-system-table-wrap"><table class="course-system-table">
        <thead><tr>
          <th>班型</th>
          <th>课程</th>
          <th>师资</th>
          <th>时长</th>
          <th>起始</th>
          <th>终止</th>
          <th>合班备注</th>
          ${showStatusCol ? '<th>状态</th>' : ''}
          <th>操作</th>
        </tr></thead>
        <tbody>
      `;
      file.items.forEach(item => {
        const isMixed = mixedKeys.has(sheetKeyOf(item));
        const rowClass = isMixed ? ' class="row-mixed"' : (item.scheduled === false ? ' class="row-unscheduled"' : '');
        const startCell = item.startDate ? escapeHtml(item.startDate.slice(5)) : '<span class="cell-muted">—</span>';
        const endCell = item.endDate ? escapeHtml(item.endDate.slice(5)) : '<span class="cell-muted">—</span>';
        let statusCell = '';
        if (showStatusCol) {
          if (item.scheduled === true) {
            statusCell = '<td><span class="status-tag success">✓</span></td>';
          } else if (isMixed) {
            // v5.83：混合形态子表整表跳过排课，红色「混」标签明确报错
            statusCell = '<td><span class="status-tag error">混</span></td>';
          } else if (item.scheduled === false) {
            statusCell = '<td><span class="status-tag error">✗</span></td>';
          } else {
            statusCell = '<td></td>';
          }
        }
        html += `
          <tr${rowClass}>
            <td>${escapeHtml(item.classType)}</td>
            <td>${escapeHtml(item.courseName)}</td>
            <td>${escapeHtml(item.teacher)}</td>
            <td>${escapeHtml(String(item.duration))}</td>
            <td>${startCell}</td>
            <td>${endCell}</td>
            <td>${item.mergeNote ? escapeHtml(item.mergeNote) : ''}</td>
            ${statusCell}
            <td><button class="delete-btn" data-action="delete-course-item" data-item-id="${item.itemId}">删除</button></td>
          </tr>
        `;
      });
      html += `</tbody></table></div>`;
    }
    html += `</div></div>`;
  });

  content.innerHTML = html;
}
