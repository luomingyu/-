// 空闲时间列表 + 排课结果列表渲染（树形折叠 + 事件委托删除）
import { getScheduledCourses } from '../state/selectors.js';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 根据 section 折叠状态同步父 .tree-section 的 class */
function syncSectionCollapsed(content, key, state) {
  const sectionEl = content?.closest('.tree-section');
  if (sectionEl) {
    sectionEl.classList.toggle('collapsed', !!state.ui?.sectionCollapsed?.[key]);
  }
}

/** 渲染师资空闲时间（多文件树形折叠） */
export function renderAvailabilityList(state) {
  const content = document.getElementById('availabilityTreeContent');
  const count = document.getElementById('availabilityListCount');
  if (!content) return;

  const files = state.availabilityFiles || [];
  const total = (state.availabilityData || []).length;
  if (count) count.textContent = `${total} 条`;

  syncSectionCollapsed(content, 'availability', state);

  if (files.length === 0) {
    content.innerHTML = '<div class="data-list-empty">暂无空闲时间数据</div>';
    return;
  }

  let html = '';
  files.forEach(file => {
    const collapsed = state.ui.fileCollapsed[file.id];
    const itemCount = file.items.length;
    html += `
      <div class="file-node ${collapsed ? 'collapsed' : ''}">
        <div class="file-node__header" data-action="toggle-file" data-file-id="${file.id}">
          <span class="file-node__toggle">▼</span>
          <span class="file-node__icon">📁</span>
          <span class="file-node__name">${escapeHtml(file.fileName)}</span>
          <span class="file-node__count">${itemCount}</span>
          <button class="delete-btn" data-action="delete-availability-file" data-file-id="${file.id}">删除</button>
        </div>
        <div class="file-node__body">
    `;
    if (itemCount === 0) {
      html += '<div class="file-node__empty">该文件无条目</div>';
    } else {
      file.items.forEach(item => {
        html += `
          <div class="data-list-item">
            <div class="data-list-info">
              <div class="data-list-text">${escapeHtml(item.teacher)}</div>
              <div class="data-list-subtext">${item.date} · ${item.startTime} - ${item.endTime}</div>
            </div>
            <button class="delete-btn" data-action="delete-availability-item" data-item-id="${item.itemId}">删除</button>
          </div>
        `;
      });
    }
    html += `</div></div>`;
  });

  content.innerHTML = html;
}

/** 渲染排课结果（扁平列表） */
export function renderScheduledList(state) {
  const content = document.getElementById('scheduledTreeContent');
  const count = document.getElementById('scheduledListCount');
  if (!content) return;

  const filteredList = getScheduledCourses(state);
  if (count) count.textContent = `${filteredList.length} 条`;

  syncSectionCollapsed(content, 'scheduled', state);

  if (filteredList.length === 0) {
    content.innerHTML = '<div class="data-list-empty">暂无排课数据</div>';
    return;
  }

  let html = '';
  filteredList.forEach(course => {
    const originalIndex = state.courses.indexOf(course);
    const displayName = course.name || '未命名课程';
    const displayTeacher = (course.teacher || '').replace('老师', '');
    const displayClass = course.classType || '';
    const classTag = displayClass ? `<span class="scheduled-class-tag">${escapeHtml(displayClass)}</span>` : '';
    html += `
      <div class="data-list-item scheduled-list-item">
        <div class="data-list-info">
          <div class="data-list-text">${classTag} ${escapeHtml(displayName)}</div>
          <div class="data-list-subtext">${course.date} · ${course.startTime} - ${course.endTime} · ${escapeHtml(displayTeacher)}</div>
        </div>
        <button class="delete-btn" data-action="delete-scheduled" data-index="${originalIndex}">删除</button>
      </div>
    `;
  });

  content.innerHTML = html;
}

/** 渲染上传/排课状态文本 */
export function renderStatus(state) {
  const updateStatusEl = (id, status) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `upload-status ${status.kind || 'info'}`;
    el.textContent = status.text;
  };

  updateStatusEl('uploadStatus', state.uploadStatus.availability);
  updateStatusEl('courseSystemStatus', state.uploadStatus.courseSystem);

  // 排课状态显示在师资上传状态位置（与原系统一致）
  const scheduleStatus = state.scheduleStatus;
  if (scheduleStatus && scheduleStatus.text) {
    const el = document.getElementById('uploadStatus');
    if (el) {
      el.className = `upload-status ${scheduleStatus.kind || 'info'}`;
      el.textContent = scheduleStatus.text;
    }
  }
}
