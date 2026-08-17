// 从 lib/index.js 重新生成 lib/plugin-source.txt(自举安装用的原始插件体)。
// 用法:npm run sync-source
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const lib = readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')

const injMatch = /const inject = (\[[^\]]*\])/.exec(lib)
if (!injMatch) throw new Error('cannot find inject declaration in lib/index.js')

const appMatch = /async function apply\(ctx\) \{/.exec(lib)
if (!appMatch) throw new Error('cannot find apply in lib/index.js')
const open = lib.indexOf('{', appMatch.index)
const retEnd = lib.lastIndexOf('}')
const close = lib.lastIndexOf('}', retEnd - 1)
const applyBody = lib.slice(open + 1, close)

const source = `return {\n  inject: ${injMatch[1]},\n  async apply(ctx) {\n${applyBody}\n  }\n}\n`
writeFileSync(path.join(root, 'lib', 'plugin-source.txt'), source)
console.log(`plugin-source.txt regenerated (${source.length} bytes)`)
