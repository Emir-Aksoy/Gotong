/**
 * 原子写 — 「写临时文件再 rename」这一个动作的唯一实现。
 *
 * ## 为什么要收敛
 *
 * v3.3 审计的 H6 发现过一个具体 bug：临时文件名固定成 `${path}.tmp`，两个并发
 * 写同一个文件的人会撞在同一个临时名上——后一个 `writeFile` 在前一个 rename
 * 到一半时把它盖了，原子性就没了，偶尔在盘上留下半截 JSON。修法是给临时名加
 * pid + 纳秒 + 随机字节，rename 本身在 POSIX 上仍是原子的，所以「后写者赢」
 * 的语义不变。
 *
 * 问题是这个修复**只落在了 `space.ts` 一处**。同一个 bug 后来被另外两个包各自
 * 独立重新发现、各自本地打了一遍补丁，而仓库里还有十来处照旧写着 `${path}.tmp`
 * ——包括 core 自己的 `storage/file.ts`。三份补丁、一份原始 bug、零处共享代码。
 *
 * 所以这个模块存在的意义不是「少写三行」，是**让这个 bug 只有一个地方可以修**。
 * 新写落盘代码时用这里的函数，别再手搓 tmp+rename。
 *
 * ## 命名约定（改之前先读）
 *
 * 临时名**必须仍以 `.tmp` 结尾**。目录列举的地方靠后缀把半成品挡在外面，形如
 * `f.endsWith('.json') && !f.endsWith('.tmp')`（run-store / lifecycle-store /
 * revision-store / file-inbox-store 都是这个形状）。两个子句各自都能挡住
 * `x.json.<唯一段>.tmp`，但换个不以 `.tmp` 收尾的方案就会让第二道闸失效。
 *
 * ## 失败清理是唯一名字的代价，不是附赠品
 *
 * 名字固定成 `${path}.tmp` 时，rename 失败留下的半成品会被**下一次写覆盖**，
 * 盘上永远最多一个。名字唯一之后这条自愈没了：每失败一次就永久多一个孤儿。
 * 所以这里在失败路径上 best-effort 删掉临时文件——换成唯一名就必须连这个
 * 一起换，两者是一件事。
 *
 * ## 边界
 *
 * - 只保证「读到的要么是旧的完整内容，要么是新的完整内容」，**不保证掉电后
 *   新内容一定在**（没有 fsync）。要那种保证的地方得自己加，并想清楚代价。
 * - `rename` 跨文件系统会 EXDEV。临时文件与目标同目录，所以正常情况下不会碰上。
 * - 目录不存在不归它管（ENOENT 照抛）——调用方自己 mkdir，因为「该建在哪、要不要
 *   递归」是调用方的事。
 */

import { randomBytes } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'

/**
 * 0o600 — 只有属主可读写，组和其他人什么都没有。凡是装 token 哈希、密文、
 * 会话 id 的文件都该用它。
 *
 * 3.4 之前这些文件按进程 umask 落盘（Linux/macOS 上通常 0o644），共享主机上
 * 任何本地用户都能同时读到 `secrets.enc.json` 和它旁边的
 * `runtime/secret.key`——「静态加密」的前提（主钥不可能仅靠读盘拿到）当场作废。
 * 见 `.github/AUDIT-v3.3.md` 的 C4。
 *
 * 权限位走 `writeFile` 的 mode 选项在 POSIX 上创建时即生效；老工作区的补救是
 * `Space.open` 时一轮 best-effort chmod。Windows 上是 no-op（chmod 会被接受，
 * 但 POSIX 位在那儿不构成安全边界，那边靠 BitLocker/ACL）。
 */
export const SECURE_FILE_MODE = 0o600

/**
 * 与 `target` 同目录的唯一临时路径。pid 防跨进程撞名，纳秒计数防同进程内撞名，
 * 随机字节防前两者在极端情况下仍然相等。结尾保持 `.tmp`（见文件头注）。
 */
export function uniqueTmpPath(target: string): string {
  const uniq = `${process.pid}.${process.hrtime.bigint().toString(36)}.${randomBytes(3).toString('hex')}`
  return `${target}.${uniq}.tmp`
}

/** `writeFile` 的 options 形状：给了 mode 就在**创建时**带上权限位。 */
function writeOptions(mode?: number): { encoding: 'utf8'; mode?: number } {
  // 权限位必须在 writeFile 时给，不能写完再 chmod —— 那中间的窗口正是 v3.3
  // 审计 H6 的另一半（文件已存在、权限还没收紧）。
  return mode !== undefined ? { encoding: 'utf8', mode } : { encoding: 'utf8' }
}

/** 原子写文本。写唯一临时文件 → rename 覆盖目标。 */
export async function writeFileAtomic(
  target: string,
  text: string,
  mode?: number,
): Promise<void> {
  const tmp = uniqueTmpPath(target)
  try {
    await writeFile(tmp, text, writeOptions(mode))
    await rename(tmp, target)
  } catch (err) {
    // 清不掉就算了：原始失败才是要报的那个，别拿清理的错把它盖掉。
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/** {@link writeFileAtomic} 的同步版，给不能 await 的路径（如进程退出钩子）。 */
export function writeFileAtomicSync(target: string, text: string, mode?: number): void {
  const tmp = uniqueTmpPath(target)
  try {
    writeFileSync(tmp, text, writeOptions(mode))
    renameSync(tmp, target)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 同上 */
    }
    throw err
  }
}

/**
 * 原子写 JSON，2 空格缩进 + 结尾换行——这是本仓库落盘 JSON 的既有格式，
 * 改它会让所有状态文件产生一次无意义的全量 diff。
 */
export async function writeJsonAtomic(
  target: string,
  value: unknown,
  mode?: number,
): Promise<void> {
  await writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`, mode)
}

/** {@link writeJsonAtomic} 的同步版。 */
export function writeJsonAtomicSync(target: string, value: unknown, mode?: number): void {
  writeFileAtomicSync(target, `${JSON.stringify(value, null, 2)}\n`, mode)
}
