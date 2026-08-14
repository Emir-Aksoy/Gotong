---
description: 生成一份 gotong.envelope/v1 交付物信封(任务请求或答复),写入 gotong-out/ 等用户经 IM 发给对方
argument-hint: <要发给对方的任务,或要答复哪份 request>
---

用户想生成一份 Gotong 交付物信封:$@

按 gotong-envelope 技能操作:
1. 判断这是发新任务(request)还是答复收到的请求(result;需要原 request 的 id)。信息不够就先问清。
2. 问用户署名(from_name,建议「真名 (pi @ 设备)」),没答复就用合理默认。
3. 调 `gotong_emit` 生成信封。校验报错就按错误清单修正参数重试。
4. 告诉用户文件在 `gotong-out/` 的确切文件名,提醒 TA 在 IM 里发给对方。
