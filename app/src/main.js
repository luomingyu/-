// 入口：装配事件、启动首次渲染
import './styles/index.css';
import { subscribe, getState } from './state/store.js';
import { renderAll } from './render/index.js';
import { bindEvents } from './events/bindEvents.js';

// 订阅状态变更 → 全量重绘
subscribe((state) => renderAll(state));

// 绑定所有事件
bindEvents();

// 首屏渲染
renderAll(getState());
