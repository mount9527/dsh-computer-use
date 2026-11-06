// 浏览器通道的中文化包装。
//
// lib/browser.mjs 直接和 CDP 打交道，抛出的异常与返回的 error 大多是英文（"Target closed"、
// "Execution context was destroyed"…），非技术用户看不懂。这里在**导出边界**统一翻译：
// 异常重新抛出成中文 Error，返回对象里的 error 字段就地改写。
// 已经是中文的信息原样保留，不重复加前缀。
import { describeBrowserError } from './messages.mjs';
import * as raw from './browser.mjs';

const hasChinese = (s) => /[\u4e00-\u9fa5]/.test(String(s ?? ''));

function localizeValue(value) {
  if (value && typeof value === 'object' && value.ok === false && typeof value.error === 'string') {
    if (!hasChinese(value.error)) return { ...value, error: describeBrowserError(value.error) };
  }
  return value;
}

function wrap(fn) {
  return async (...args) => {
    try {
      return localizeValue(await fn(...args));
    } catch (err) {
      if (err && err.localized) throw err;
      const err2 = new Error(describeBrowserError(err));
      err2.localized = true;
      err2.cause = err;
      throw err2;
    }
  };
}

export const ensureSession = wrap(raw.ensureSession);
export const navigate = wrap(raw.navigate);
export const readText = wrap(raw.readText);
export const readElements = wrap(raw.readElements);
export const describeElement = wrap(raw.describeElement);
export const click = wrap(raw.click);
export const typeInto = wrap(raw.typeInto);
export const selectOption = wrap(raw.selectOption);
export const setChecked = wrap(raw.setChecked);
export const pressKey = wrap(raw.pressKey);
export const goBack = wrap(raw.goBack);
export const reload = wrap(raw.reload);
export const scrollPage = wrap(raw.scrollPage);
export const waitFor = wrap(raw.waitFor);
export const screenshot = wrap(raw.screenshot);
export const closeBrowser = wrap(raw.closeBrowser);
export const sessionInfo = wrap(raw.sessionInfo);
export const currentSession = raw.currentSession; // 同步读状态，不涉及 IO
export const evaluate = wrap(raw.evaluate);
