/**
 * 新建一本书时文件夹叫什么（独立版欢迎页「新建一本书」「导入写好的书」，2026-10-24）。**纯函数、零 import**：表单上
 * 预览的路径（经 `media/src/protocol.ts` 打进浏览器产物）与后端真建的（`core/actions.ts` 的 `createBookAt`）是同一个名字。
 *
 * 只删各平台文件名里不许出现的字符，空格留着（书名里的空格是作者的）；开头的点（会变成隐藏文件夹）与结尾的点、空格
 * （Windows 不认）一并去掉。删完什么都不剩时是空串——调用方据此说「书名里的字都不能当文件夹名」。
 */
export function bookDirName(title: string): string {
  return title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 80);
}
