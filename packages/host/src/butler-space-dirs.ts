/**
 * butler-space-dirs.ts — 管家在 `<space>` 里那几个**兄弟目录**的位置算法。
 *
 * 为什么专门开一个叶子:这一族目录(escalate / presence / prefs / longrun)
 * 一直是在各自那一个调用点就地拼出来的——只有一个推导者时那是对的。
 * `longrun` 是第一个**同时有写者与读者**的:驱动器往里写、/me 面板的投影
 * 往外读。两边各拼一次的后果不是报错是**一张永远空着的卡**——那种 bug
 * 没有任何人会被通知。所以算法只能有一份。
 *
 * 落位理由(与 escalate/presence/prefs 同款):它们是 `butler/memory` 的**兄弟**
 * 而不是它的孩子——不进记忆树,MU-M5 的 git 快照就不会被它们搅动。
 */
import { dirname, join } from 'node:path'

/** `<space>/butler/longrun` — 每成员一个子目录(由 `ownerDir` 再分)。 */
export function butlerLongRunRoot(memoryRoot: string): string {
  return join(dirname(memoryRoot), 'longrun')
}
