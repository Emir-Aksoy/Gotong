#!/usr/bin/env node
// pypi-pack-gate — PUB-M2 的 PyPI 侧打包体检(`pnpm check:pypi-pack`)。
// 不真上传:python -m build 出 sdist+wheel,twine check 验元数据。
// 首跑会往 python-sdk/.venv 里装 build/twine(网络,一次性)。
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SDK = join(ROOT, 'python-sdk')
const PY = join(SDK, '.venv', 'bin', 'python')

if (!existsSync(PY)) {
  console.error('✖ pypi-pack: python-sdk/.venv 不存在——先建 venv(python3 -m venv .venv && pip install -e .)')
  process.exit(1)
}
const run = (cmd, args) => execFileSync(cmd, args, { cwd: SDK, stdio: 'inherit' })

run(PY, ['-m', 'pip', 'install', '-q', 'build', 'twine'])
rmSync(join(SDK, 'dist'), { recursive: true, force: true })
run(PY, ['-m', 'build'])
// execFileSync 无 shell,dist/* 不会展开——显式列出产物(应恰为 sdist+wheel 两件)。
const artifacts = readdirSync(join(SDK, 'dist')).map((f) => join(SDK, 'dist', f))
if (artifacts.length < 2) {
  console.error(`✖ pypi-pack: dist 里只有 ${artifacts.length} 件产物,期望 sdist+wheel 两件`)
  process.exit(1)
}
run(join(SDK, '.venv', 'bin', 'twine'), ['check', ...artifacts])
console.log('✓ pypi-pack: sdist+wheel 构建通过,twine check 元数据合格(未上传)')
