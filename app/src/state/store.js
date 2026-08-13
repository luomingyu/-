// 集中状态管理：pub/sub + 细粒度 action
// 数据模型：真实存储为「按文件分组」，派生扁平缓存供 scheduler/calendar/selectors 使用
// 联动删除改用稳定 itemId（替代 index/id-100）
import { generateSchedule } from '../scheduler/index.js';

let _fileIdCounter = 0;
let _itemIdCounter = 0;
const nextFileId = () => `file-${++_fileIdCounter}`;
const nextItemId = () => `item-${++_itemIdCounter}`;

const initialState = {
  currentDate: new Date(),
  selectedDate: new Date(),
  selectedClass: '',          // 班级筛选：空字符串=全部班级
  // 真实存储：按文件分组
  availabilityFiles: [],      // { id, fileName, uploadedAt, items: [{ itemId, teacher, date, startTime, endTime }] }
  courseSystemFiles: [],      // { id, fileName, uploadedAt, items: [{ itemId, classType, courseName, teacher, duration, scheduled }] }
  // 派生缓存（= flatMap files → items），供 scheduler/calendar/selectors 使用
  availabilityData: [],
  courseSystemData: [],
  courses: [],                // { id, name, date, startTime, endTime, teacher, type, sourceItemId }
  // UI 折叠状态
  ui: {
    sectionCollapsed: { availability: false, courseSystem: false, scheduled: false },
    fileCollapsed: {}         // { [fileId]: true=折叠 }
  },
  uploadStatus: {
    availability: { text: '等待上传', kind: 'info' },
    courseSystem: { text: '等待上传', kind: 'info' }
  },
  scheduleStatus: { text: '', kind: '' }
};

const listeners = new Set();
let state = { ...initialState };

/** 获取当前状态（只读约定） */
export function getState() {
  return state;
}

/** 浅合并并通知订阅者 */
export function setState(patch) {
  state = { ...state, ...patch };
  notify();
}

/** 订阅状态变更，返回取消订阅函数 */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  listeners.forEach(fn => fn(state));
}

function setStatus(key, text, kind) {
  if (key === 'schedule') {
    setState({ scheduleStatus: { text, kind } });
    return;
  }
  setState({
    uploadStatus: { ...state.uploadStatus, [key]: { text, kind } }
  });
}

// ============ 派生辅助 ============
const rederiveAvailability = (files) => files.flatMap(f => f.items);
const rederiveCourseSystem = (files) => files.flatMap(f => f.items);

/** 给解析出的条目附加唯一 itemId */
function withItemIds(items) {
  return items.map(it => ({ ...it, itemId: nextItemId() }));
}

// ============ 通用 Actions ============
export function setCurrentDate(date) { setState({ currentDate: date }); }
export function setSelectedDate(date) { setState({ selectedDate: date }); }
export function setSelectedClass(cls) { setState({ selectedClass: cls || '' }); }
export function setUploadStatus(key, text, kind) { setStatus(key, text, kind); }

// ============ 文件累积 Actions ============

/** 累积添加师资空闲时间文件 */
export function addAvailabilityFile(fileName, parsedItems) {
  const fileId = nextFileId();
  const file = { id: fileId, fileName, uploadedAt: Date.now(), items: withItemIds(parsedItems) };
  const availabilityFiles = [...state.availabilityFiles, file];
  const availabilityData = rederiveAvailability(availabilityFiles);
  const fileCollapsed = { ...state.ui.fileCollapsed, [fileId]: true };
  setState({
    availabilityFiles,
    availabilityData,
    ui: { ...state.ui, fileCollapsed }
  });
}

/** 累积添加课程体系文件（不清空已有排课结果，提示用户可重新排课） */
export function addCourseSystemFile(fileName, parsedItems) {
  const fileId = nextFileId();
  const file = { id: fileId, fileName, uploadedAt: Date.now(), items: withItemIds(parsedItems) };
  const courseSystemFiles = [...state.courseSystemFiles, file];
  const courseSystemData = rederiveCourseSystem(courseSystemFiles);
  const fileCollapsed = { ...state.ui.fileCollapsed, [fileId]: true };
  setState({
    courseSystemFiles,
    courseSystemData,
    ui: { ...state.ui, fileCollapsed }
  });
}

// ============ 删除联动 Actions ============

/** 删除整个空闲时间文件 */
export function deleteAvailabilityFile(fileId) {
  const availabilityFiles = state.availabilityFiles.filter(f => f.id !== fileId);
  const availabilityData = rederiveAvailability(availabilityFiles);
  const fileCollapsed = { ...state.ui.fileCollapsed };
  delete fileCollapsed[fileId];
  setState({
    availabilityFiles,
    availabilityData,
    ui: { ...state.ui, fileCollapsed }
  });
}

/** 删除整个课程体系文件（同步删除其条目对应的排课结果） */
export function deleteCourseSystemFile(fileId) {
  const file = state.courseSystemFiles.find(f => f.id === fileId);
  if (!file) return;
  const itemIdsToRemove = new Set(file.items.map(i => i.itemId));
  const courseSystemFiles = state.courseSystemFiles.filter(f => f.id !== fileId);
  const courseSystemData = rederiveCourseSystem(courseSystemFiles);
  const courses = state.courses.filter(c => !itemIdsToRemove.has(c.sourceItemId));
  const fileCollapsed = { ...state.ui.fileCollapsed };
  delete fileCollapsed[fileId];
  setState({
    courseSystemFiles,
    courseSystemData,
    courses,
    ui: { ...state.ui, fileCollapsed }
  });
}

/** 删除单个空闲时间条目 */
export function deleteAvailabilityItem(itemId) {
  const availabilityFiles = state.availabilityFiles.map(f => ({
    ...f,
    items: f.items.filter(it => it.itemId !== itemId)
  }));
  const availabilityData = rederiveAvailability(availabilityFiles);
  setState({ availabilityFiles, availabilityData });
}

/** 删除单个课程体系条目（若已排课则同步删除对应排课结果） */
export function deleteCourseSystemItem(itemId) {
  const targetItem = state.courseSystemData.find(it => it.itemId === itemId);
  let courses = state.courses;
  if (targetItem && targetItem.scheduled === true) {
    courses = state.courses.filter(c => c.sourceItemId !== itemId);
  }
  const courseSystemFiles = state.courseSystemFiles.map(f => ({
    ...f,
    items: f.items.filter(it => it.itemId !== itemId)
  }));
  const courseSystemData = rederiveCourseSystem(courseSystemFiles);
  setState({ courseSystemFiles, courseSystemData, courses });
}

/**
 * 删除排课结果项（联动：课程体系对应条目 scheduled 置 null）
 */
export function deleteScheduledCourse(index) {
  const deletedCourse = state.courses[index];
  if (!deletedCourse) return;

  const courses = state.courses.filter((_, i) => i !== index);
  const sourceItemId = deletedCourse.sourceItemId;

  let courseSystemFiles = state.courseSystemFiles;
  let courseSystemData = state.courseSystemData;
  if (sourceItemId) {
    courseSystemFiles = state.courseSystemFiles.map(f => ({
      ...f,
      items: f.items.map(it =>
        it.itemId === sourceItemId ? { ...it, scheduled: null } : it
      )
    }));
    courseSystemData = rederiveCourseSystem(courseSystemFiles);
  }

  setState({ courses, courseSystemFiles, courseSystemData });
}

// ============ 排课 ============

/** 执行智能排课 */
export function runSchedule() {
  const result = generateSchedule(state);
  if (!result.ok) {
    setStatus('schedule', result.error, 'error');
    return;
  }

  // result.courseSystemData 是扁平数组（含 itemId + scheduled），按 itemId 回写到文件 items
  const scheduledMap = new Map(result.courseSystemData.map(it => [it.itemId, it.scheduled]));
  const courseSystemFiles = state.courseSystemFiles.map(f => ({
    ...f,
    items: f.items.map(it => ({
      ...it,
      scheduled: scheduledMap.has(it.itemId) ? scheduledMap.get(it.itemId) : it.scheduled
    }))
  }));
  const courseSystemData = rederiveCourseSystem(courseSystemFiles);

  setState({
    courses: result.courses,
    courseSystemFiles,
    courseSystemData
  });

  // 输出诊断信息
  const diag = result.diagnostics;
  if (diag) {
    console.group('📊 排课诊断报告');
    if (diag.sheetStats && diag.sheetStats.length > 0) {
      console.log('子表统计:');
      diag.sheetStats.forEach(s => {
        console.log(`  ${s.sheetName}: ${s.scheduled}/${s.totalCourses} 成功 (师资: ${s.teachers.join(', ')})`);
      });
    }
    console.log('排课顺序:', diag.schedulingOrder.join(' → '));
    console.log('师资排课情况（按难易程度降序）:');
    diag.teacherStats.forEach(s => {
      const diffStr = s.difficultyPercent === null
        ? '∞ (无空闲时间)'
        : s.difficultyPercent + '%';
      console.log(`  ${s.teacher}: ${s.scheduled}/${s.totalCourses} 成功 (可用天数: ${s.availableDates}, 难易程度: ${diffStr}, 课程需求: ${s.courseDemandMinutes}分钟 / 空闲: ${s.availabilityMinutes}分钟)`);
    });
    console.log('班级分布:');
    diag.classStats.forEach(s => {
      console.log(`  ${s.classType}: ${s.count}节课, 由 ${s.teachers.join(', ')} 授课, 日期: ${s.dates.join(', ')}`);
    });
    console.groupEnd();
  }

  if (result.failedCount === 0) {
    setStatus('schedule', `排课成功！共安排 ${result.successCount} 门课程`, 'success');
  } else {
    setStatus('schedule', `排课完成！成功 ${result.successCount} 门，失败 ${result.failedCount} 门`, 'error');
  }
}

// ============ 折叠 UI ============

export function toggleSection(key) {
  const sectionCollapsed = {
    ...state.ui.sectionCollapsed,
    [key]: !state.ui.sectionCollapsed[key]
  };
  setState({ ui: { ...state.ui, sectionCollapsed } });
}

export function toggleFile(fileId) {
  const fileCollapsed = {
    ...state.ui.fileCollapsed,
    [fileId]: !state.ui.fileCollapsed[fileId]
  };
  setState({ ui: { ...state.ui, fileCollapsed } });
}
