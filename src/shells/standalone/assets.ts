import { MEDIA_ASSETS } from './mediaAssets';

/** 版本号与资源表同在一个生成文件里，编译时写死（见 scripts/embed-media.js）。 */
export { PRODUCT_VERSION } from './mediaAssets';

/**
 * `/media/*` 路由的字节来源：全部取自内嵌资源表，不读磁盘——`bun build --compile`
 * 出来的单文件可执行没有外部资源可读。
 *
 * 与 [page.ts](page.ts) 分开是有意的：页面拼装不该因为要渲染一段 HTML 就依赖
 * 这个几十 MB 的生成文件（`mediaAssets.ts` 由 scripts/embed-media.js 生成）。
 */
export function assetBytes(name: string): { mime: string; bytes: Uint8Array } | undefined {
  const asset = MEDIA_ASSETS[name];
  if (!asset) {
    return undefined;
  }
  return { mime: asset.mime, bytes: Uint8Array.from(Buffer.from(asset.base64, 'base64')) };
}
