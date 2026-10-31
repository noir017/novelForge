/**
 * 触屏的能力探测——**不看 UA、不问是哪个壳**（见 [../../src/shells/README.md](../../src/shells/README.md)），只看指针本身：
 *
 * - {@link lastPointerWasTouch}：最近一次指针（按下 / 移进 / 移动）是不是手指。手指点一下之后 Chromium 会补发一串兼容的
 *   鼠标事件（`mouseover` → `mousemove` → `mousedown` → `mouseup` → `click`），悬停浮窗靠它分清「鼠标停在这儿」与「手指点了
 *   一下」——后者不该当成悬停去弹浮窗（弹出来也没有「移开」可收）。长按弹的 `contextmenu` 之前同样有一下手指的 `pointerdown`，
 *   右键菜单靠它认出「这是长按」，在最前面加几项「看一眼」（见 `view/menu.ts` 的 `onTouchPeek`）。
 * - 同一台机器可以既有鼠标又有触屏（触屏笔记本），所以按**这一次**的指针认，不按整台设备的 `(hover: none)` 认。
 *
 * 两个产物（view.js、editor.js）各打包一份、各装一次监听，互不相干：它只是一个记事的变量，不在产物之间传东西。
 */

let lastType = '';
let installed = false;

function note(e: Event): void {
  const type = (e as PointerEvent).pointerType;
  if (typeof type === 'string' && type) {
    lastType = type;
  }
}

/** 装上记事的监听（捕获阶段，谁都拦不住）。重复调用无害。 */
export function trackPointer(): void {
  if (installed) {
    return;
  }
  installed = true;
  for (const type of ['pointerdown', 'pointerover', 'pointermove'] as const) {
    document.addEventListener(type, note, { capture: true, passive: true });
  }
}

/** 最近一次指针是手指。触控笔算不是（笔能悬停）。 */
export function lastPointerWasTouch(): boolean {
  return lastType === 'touch';
}

/** 这个事件是手指发起的：事件自己带 `pointerType` 就看它（Chromium 的 `click` / `contextmenu` 是 PointerEvent），否则看最近一次指针。 */
export function isTouchEvent(e: Event): boolean {
  const type = (e as PointerEvent).pointerType;
  if (typeof type === 'string' && type) {
    return type === 'touch';
  }
  return lastPointerWasTouch();
}

/**
 * 切页、打开文件时**别替用户把焦点放进输入框**：手机上程序一聚焦输入框就顶起软键盘、盖住半屏，想看的东西反倒看不见
 * （Android 实机上一载入就弹——对话页签自动聚焦输入框；点一下编辑器页签也弹）。想打字的人自己会点进去。
 * 这一次是手指点的就算；页面刚载入、还没有指针的时候只能看整台设备的主指针能不能悬停（手机、平板不能）。
 * 只管「顺手放焦点」的那几处；作者明确要打字的（弹窗里的输入框、挑了命令之后的对话输入框、「预览」切回「编辑」）照旧聚焦。
 */
export function avoidSoftKeyboard(): boolean {
  return lastPointerWasTouch() || touchDevice();
}

/**
 * 整台设备的主要指针不能悬停（手机、平板），与样式里的 `(hover: none)` 同一条。只在桌面上管用的入口（「退出」关不掉手机浏览器的
 * 标签页，「打开日志目录」开在服务端那台机器上）在这种设备上不列。
 */
export function touchDevice(): boolean {
  return !!window.matchMedia?.('(hover: none)').matches;
}
