// 集中状态管理：pub/sub + 细粒度 action
// 数据模型：真实存储为「按文件分组」，派生扁平缓存供 scheduler/calendar/selectors 使用
// 联动删除改用稳定 itemId（替代 index/id-100）
// v5.20：业务数据（空闲表/课程表/排课结果）通过本机服务器持久化到磁盘，
//        局域网内其他人通过链接访问时，看到的是同一份数据（见 persist.js）
import { runSchedulePipeline } from '../scheduler/pipeline.js';
import { APP_VERSION } from '../config/constants.js';
import { loadFromServer, schedulePersist } from './persist.js';

let _fileIdCounter = 0;
let _itemIdCounter = 0;
const nextFileId = () => `file-${++_fileIdCounter}`;
const nextItemId = () => `item-${++_itemIdCounter}`;

const initialState = {
  currentDate: new Date(),
  selectedDate: new Date(),
  selectedClasses: [],        // 班级筛选（多选）：空数组=全部班级（v6.0.13）
  selectedTeachers: [],       // 师资筛选（多选）：空数组=全部师资（v6.0.13）
  showAvailability: false,    // 日历是否显示空闲时间（默认隐藏，查看区按钮切换；v6.0.11 默认改为关）
  abbreviateClass: true,      // 班级是否缩写显示（默认缩写，查看区按钮切换；v6.0.8）
  // 真实存储：按文件分组
  availabilityFiles: [],      // { id, fileName, uploadedAt, items: [{ itemId, teacher, date, startTime, endTime }] }
  courseSystemFiles: [],      // { id, fileName, uploadedAt, items: [{ itemId, classType, courseName, teacher, duration, scheduled }] }
  presetFiles: [],            // 已排课表（v5.90）：跨科目班级占用约束 { id, fileName, uploadedAt, items: [{ itemId, classType, courseName, teacher, date, startTime, endTime }] }（teacher 仅展示）
  // 派生缓存（= flatMap files → items），供 scheduler/calendar/selectors 使用
  availabilityData: [],
  courseSystemData: [],
  presetData: [],             // 已排课表条目（v5.90，排课引擎预注册占用域）
  courses: [],                // { id, name, date, startTime, endTime, teacher, type, sourceItemId }
  scheduleReports: [],        // 每次排课生成的 Markdown 报告快照（含师资-班级空闲时间表）
  // UI 折叠状态
  ui: {
    sectionCollapsed: { availability: false, courseSystem: false, preset: false, scheduled: false },
    fileCollapsed: {}         // { [fileId]: true=折叠 }
  },
  uploadStatus: {
    availability: { text: '等待上传', kind: 'info' },
    courseSystem: { text: '等待上传', kind: 'info' },
    preset: { text: '等待上传', kind: 'info' }
  },
  scheduleStatus: { text: '', kind: '' }
};

const listeners = new Set();
let state = { ...initialState };

/** 获取当前状态（只读约定） */
export function getState() {
  return state;
}

/** 浅合并并通知订阅者；业务数据有变化时自动持久化到服务器磁盘 */
export function setState(patch, opts = {}) {
  const next = { ...state, ...patch };
  // 检测业务数据（空闲表/课程表/排课结果）是否变化，变化则交给服务器落盘
  // UI 状态（折叠、选中日期等）不属于业务数据，不触发写入
  const bizChanged = opts.persist !== false && isBizDataChanged(state, next);
  state = next;
  notify();
  if (bizChanged) {
    schedulePersist(state.availabilityFiles, state.courseSystemFiles, state.presetFiles, state.courses, state.scheduleReports);
  }
}

/** 订阅状态变更，返回取消订阅函数 */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  listeners.forEach(fn => fn(state));
}

export function setStatus(key, text, kind) {
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
const rederivePreset = (files) => files.flatMap(f => f.items);

// 持久化范围：只有这几块属于需要落盘的"业务数据"
const BIZ_KEYS = ['availabilityFiles', 'courseSystemFiles', 'presetFiles', 'courses', 'scheduleReports'];

/** 前后两份状态中，业务数据是否发生了变化（序列化比对，数据量小足够快） */
function isBizDataChanged(prev, next) {
  return BIZ_KEYS.some(k => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
}

/** 给解析出的条目附加唯一 itemId */
function withItemIds(items) {
  return items.map(it => ({ ...it, itemId: nextItemId() }));
}

// ============ 通用 Actions ============
export function setCurrentDate(date) { setState({ currentDate: date }); }
export function setSelectedDate(date) { setState({ selectedDate: date }); }
/** 设置选中的班级（多选数组；空数组=全部班级；纯 UI 状态，不触发持久化） */
export function setSelectedClasses(classes) {
  setState({ selectedClasses: Array.isArray(classes) ? [...classes] : [] });
}

/** 设置选中的师资（多选数组；空数组=全部师资；纯 UI 状态，不触发持久化） */
export function setSelectedTeachers(teachers) {
  setState({ selectedTeachers: Array.isArray(teachers) ? [...teachers] : [] });
}

/** 切换日历是否显示空闲时间（默认隐藏；纯 UI 状态，不触发持久化） */
export function toggleShowAvailability() {
  setState({ showAvailability: !state.showAvailability });
}

/** 切换班级是否缩写显示（默认缩写；纯 UI 状态，不触发持久化；v6.0.8） */
export function toggleAbbreviateClass() {
  setState({ abbreviateClass: !state.abbreviateClass });
}
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

/** 累积添加已排课表文件（v5.90：跨科目班级占用约束，重新排课后生效） */
export function addPresetFile(fileName, parsedItems) {
  const fileId = nextFileId();
  const file = { id: fileId, fileName, uploadedAt: Date.now(), items: withItemIds(parsedItems) };
  const presetFiles = [...state.presetFiles, file];
  const presetData = rederivePreset(presetFiles);
  const fileCollapsed = { ...state.ui.fileCollapsed, [fileId]: true };
  setState({
    presetFiles,
    presetData,
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

/** 删除整个已排课表文件（v5.90：仅移除班级占用约束，无需联动排课结果） */
export function deletePresetFile(fileId) {
  const presetFiles = state.presetFiles.filter(f => f.id !== fileId);
  const presetData = rederivePreset(presetFiles);
  const fileCollapsed = { ...state.ui.fileCollapsed };
  delete fileCollapsed[fileId];
  setState({
    presetFiles,
    presetData,
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

/** 删除单个已排课表条目（v5.90：仅移除班级占用约束，无需联动排课结果） */
export function deletePresetItem(itemId) {
  const presetFiles = state.presetFiles.map(f => ({
    ...f,
    items: f.items.filter(it => it.itemId !== itemId)
  }));
  const presetData = rederivePreset(presetFiles);
  setState({ presetFiles, presetData });
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

/**
 * 执行智能排课（方案 B：排课以服务器执行为准，服务器不可用时本地兜底）。
 * 前后端共用同一排课管线（runSchedulePipeline），保证结果一致。
 * @returns {Promise<boolean>} 是否排课成功
 */
export async function runSchedule() {
  // 1. 优先请求服务器执行排课（POST /api/schedule）
  let result = null;
  try {
    const res = await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        availabilityFiles: state.availabilityFiles,
        courseSystemFiles: state.courseSystemFiles,
        presetFiles: state.presetFiles,
        currentDate: state.currentDate,
        abbreviateClass: state.abbreviateClass
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    if (payload && typeof payload.ok === 'boolean') {
      result = payload; // 服务器为准：排课成功或失败都采用其结论
    } else {
      throw new Error('服务器返回格式异常');
    }
  } catch (err) {
    console.warn('[排课] 服务器执行不可用，回退本地执行:', err.message);
  }

  // 2. 服务器不可用时本地兜底（同一管线，结果一致）
  if (!result) {
    result = runSchedulePipeline({
      availabilityFiles: state.availabilityFiles,
      courseSystemFiles: state.courseSystemFiles,
      presetFiles: state.presetFiles,
      currentDate: state.currentDate,
      abbreviateClass: state.abbreviateClass
    });
  }

  if (!result.ok) {
    setStatus('schedule', result.error, 'error');
    return false;
  }

  setState({
    courses: result.courses,
    courseSystemFiles: result.courseSystemFiles,
    courseSystemData: rederiveCourseSystem(result.courseSystemFiles),
    scheduleReports: result.scheduleReports
  });

  // 输出诊断信息
  const diag = result.diagnostics;
  if (diag) {
    console.group('📊 排课诊断报告');
    if (diag.sheetStats && diag.sheetStats.length > 0) {
      console.log('子表统计（按课程数量降序排课）:');
      diag.sheetStats.forEach(s => {
        console.log(`  ${s.sheetName}: ${s.scheduled}/${s.totalCourses} 成功 (对齐 ${s.aligned}, 失败 ${s.failed}, 师资: ${s.teachers.join(', ')})`);
      });
    }
    console.log('排课顺序:', diag.schedulingOrder.join(' → '));
    console.log('师资排课情况:');
    diag.teacherStats.forEach(s => {
      console.log(`  ${s.teacher}: ${s.scheduled}/${s.totalCourses} 成功 (可用天数: ${s.availableDates})`);
    });
    console.log('班级分布:');
    diag.classStats.forEach(s => {
      console.log(`  ${s.classType}: ${s.count}节课, 由 ${s.teachers.join(', ')} 授课, 日期: ${s.dates.join(', ')}`);
    });
    console.groupEnd();
  }

  // v5.83：混合形态子表（先分后合与先合后分并存）整表跳过排课，消息提示并标 error 报错
  const mixedSheets = diag?.mixedSheets || [];
  const mixedMsg = mixedSheets.length > 0
    ? `；🔴 混合形态子表未排课：${mixedSheets.map(m => m.sheetName).join('、')}（先分后合与先合后分并存，请拆分后重新排课）`
    : '';
  if (result.failedCount === 0) {
    setStatus('schedule', `排课成功！共安排 ${result.successCount} 门课程${mixedMsg}`, mixedSheets.length > 0 ? 'error' : 'success');
  } else {
    setStatus('schedule', `排课完成！成功 ${result.successCount} 门，失败 ${result.failedCount} 门${mixedMsg}`, 'error');
  }
  return true;
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

// ============ 启动时从服务器加载历史数据 ============

/**
 * 应用启动时调用：若本机服务器可用，把磁盘上保存的业务数据恢复到内存。
 * @returns {Promise<{loaded: boolean, upgraded: string|null, stale?: string}>}
 *   loaded   是否成功从服务器加载到数据
 *   upgraded 若后端数据版本落后于当前应用版本，自动重排后返回最新应用版本；否则为 null
 *   stale    若后端数据版本落后且无课程体系数据、无法自动重排时，返回落后版本号（供显式提示）
 */
export async function hydrateFromServer() {
  const data = await loadFromServer();
  if (!data) return { loaded: false, upgraded: null };

  const availabilityFiles = Array.isArray(data.availabilityFiles) ? data.availabilityFiles : [];
  const courseSystemFiles = Array.isArray(data.courseSystemFiles) ? data.courseSystemFiles : [];
  const presetFiles = Array.isArray(data.presetFiles) ? data.presetFiles : [];

  // 推进 id 计数器，防止新追加的记录与历史数据的 itemId/fileId 重复
  const maxFileNum = [...availabilityFiles, ...courseSystemFiles, ...presetFiles].reduce(
    (m, f) => Math.max(m, Number(String(f.id).replace('file-', '')) || 0), 0);
  const maxItemNum = [
    ...availabilityFiles.flatMap(f => f.items),
    ...courseSystemFiles.flatMap(f => f.items),
    ...presetFiles.flatMap(f => f.items)
  ].reduce((m, it) => Math.max(m, Number(String(it.itemId).replace('item-', '')) || 0), 0);
  _fileIdCounter = Math.max(_fileIdCounter, maxFileNum);
  _itemIdCounter = Math.max(_itemIdCounter, maxItemNum);

  setState({
    availabilityFiles,
    availabilityData: rederiveAvailability(availabilityFiles),
    courseSystemFiles,
    courseSystemData: rederiveCourseSystem(courseSystemFiles),
    presetFiles,
    presetData: rederivePreset(presetFiles),
    courses: Array.isArray(data.courses) ? data.courses : [],
    scheduleReports: Array.isArray(data.scheduleReports) ? data.scheduleReports : []
  }, { persist: false });

  // 常态化解法：版本更新时后端数据自动升级。
  // 后端数据中的排课报告版本若落后于当前应用版本（版本更新后常忘记手动重排/回写），
  // 打开页面即自动用当前版本重新排课并落盘，保证后端数据版本始终跟随代码。
  const reports = data.scheduleReports;
  const storedVersion = reports?.[0]?.appVersion;
  if (Array.isArray(reports) && reports.length > 0 && storedVersion !== APP_VERSION) {
    if (courseSystemFiles.length > 0) {
      console.log(`[版本] 后端数据版本 ${storedVersion || '无'} ≠ 当前代码 ${APP_VERSION}，自动重新排课升级数据...`);
      const ok = await runSchedule();
      if (ok) {
        return { loaded: true, upgraded: APP_VERSION };
      }
    }
    // 无课程体系数据（仅有历史报告）无法自动重排：显式暴露，避免徽标版本与报告版本长期静默不一致
    return { loaded: true, upgraded: null, stale: storedVersion || '无版本字段' };
  }

  return { loaded: true, upgraded: null };
}
