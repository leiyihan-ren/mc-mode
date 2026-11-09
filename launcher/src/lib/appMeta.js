/**
 * src/lib/appMeta.js — 应用元数据单一出口
 *
 * 0.7.0 模块一：组件不再跨目录 import ../../package.json。
 * Feature 化重组后目录层级会变，这类「穿透到项目根」的相对引用必然断裂；
 * 统一由 lib 层（不参与移动）读取，UI 只依赖稳定别名 @/lib/appMeta.js。
 */
import pkg from '../../package.json'

export const APP_VERSION = pkg.version
export default pkg
