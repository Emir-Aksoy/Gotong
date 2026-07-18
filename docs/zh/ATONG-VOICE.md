# 阿同语音回复 track(VOICE)— 飞书 TTS 语音条

> 状态:M0 计划(2026-07-17)。用户拍板:语音通道走**飞书**(现成桥),音色选
> **合法授权的温柔知性女声**(MiniMax 系统音色候选,用户试听后定)。
> 姊妹 track:[`ATONG-DUAL-BRAIN.md`](ATONG-DUAL-BRAIN.md)(单管家双脑,同轮拍板)。

---

## 一、诉求与拍板记录

用户原话(2026-07-17):「飞书机器人应该是支持语音的,这是我们现成的通道,使用这个。
先找一个合法的温柔又知性的女声包。」此前一轮用户问「有没有模拟刘亦菲声音的语音包」,
已明确回复**不做**:未经授权克隆特定真人声音在《民法典》第 1023 条下侵犯声音权
(参照肖像权保护),市面「明星语音包」基本都是未授权克隆。**这条钉进本文档:
本 track 只接厂商官方提供的系统合成音色,永不接入任何真人克隆音色。**

目标:阿同在飞书里的回复可以变成语音条(温柔知性女声),opt-in,默认不开 = 行为
逐字节不变;TTS 失败一律退回文本,绝不吞掉回复。

## 二、外部侦察(2026-07-17,WebSearch/WebFetch 核官方)

**飞书语音链路**(官方 API 核实):
1. 音频必须是 **opus**:上传接口强制 `file_type=opus`(哪怕内容是 mp3 也过不了),
   官方社区通行转码 `ffmpeg -i in.mp3 -acodec libopus -ac 1 -ar 16000 out.opus`;
2. `POST /open-apis/im/v1/files`(multipart,带 `duration` 毫秒)→ 得 `file_key`;
3. 发送 `msg_type: 'audio'`,content 携 `file_key`;
4. 权限:bot 需 **`im:resource`**(现有消息权限之外,飞书后台加,不换凭证);
5. 文件上限 30MB;时长上限未在代码侧强制 → 本 track 自建长度阈值(见边界⑤)。

**TTS 厂商 = MiniMax**(用户去注册拿 key):
- **OpenAI 兼容 `/audio/speech`** 接口 —— 与我们 `openai-compatible` LLM 同款接入
  形状(baseURL + key + JSON body),`{model, input, voice, response_format}`;
- 「温柔知性」系统音色候选(官方音色表核实,用户试听后定一个):
  `Chinese (Mandarin)_Gentle_Senior` 温柔学姐 / `Chinese (Mandarin)_Wise_Women`
  阅历姐姐 / `female-yujie-jingpin` 御姐精品 / `Chinese (Mandarin)_Warm_Bestie`
  温暖闺蜜。系统音色是平台官方合成音色,非真人克隆;
- 备选厂商:阿里云 CosyVoice / 火山引擎(MiniMax 试听不满意再核)。

**TTS 厂商变更 = 小米 MiMo(M3b,2026-07-17 用户拍板「tts 用小米的 mimo」)**:
- 官方文档站是 SPA 抓不到正文,wire 形状按仓库既定手法从两个真实客户端源码
  交叉核准(`gh api` 逐字读 jarodise/MimoTTS 的 `api_client.py`+`config.py`,
  对照 yanzaiyun43/mimo-tts-web 的 `index.html`):
  - **不是 `/audio/speech`** —— 是 **OpenAI chat wire**:`POST
    <base>/chat/completions`,base = `https://api.xiaomimimo.com/v1`;
  - body = `{model, messages: [{role:'user', content: <风格指令,可空>},
    {role:'assistant', content: <要朗读的文本>}], audio: {format:'wav'|'pcm16',
    voice: <音色 id>}}` —— **要读的文本放 assistant 消息**是这个 wire 最反直觉
    的一点,两源一致;
  - 响应 = JSON,音频在 `choices[0].message.audio.data`(base64),24 kHz 输出;
    无 mp3 档,wav 即可(ffmpeg 对 stdin 自动嗅探格式,转码腿零改动);
  - 模型:`mimo-v2.5-tts`(预置系统音色)/`-voicedesign`(文字描述设计音色)/
    `-voiceclone`(参考音频克隆——**红线拒绝**,构造层当场抛错);
  - 音色选定 **`茉莉` = 温柔知性的成熟女声**(官方预置系统音色,音色 id 就是
    中文名字符串,正中用户「温柔知性女声」诉求)。

## 三、仓库侦察(2026-07-17,file:line 一手核实)

- **`ImAttachment{kind:'audio', bytes}` 契约已存在**(`im-adapter/src/types.ts:63-69`)
  —— 跨桥传输载体现成,im-adapter 本 track **零改动**(它是刻意的零依赖纯类型包);
- **host 回复汇聚点唯二**:对话回复 `im-bridge.ts:1237 reply()`、主动推送
  `butler-reachable.ts:190`,都走 `bridge.sendMessage(to, text, {attachments})`;
- **LarkBridge 现状**:只发 `msg_type:'text'`(`im-lark/src/bridge.ts:268-281`),
  带附件时显式拒绝只发文本(bridge.ts:250-258)—— 这个分支就是 audio 腿的接入点;
  `LarkClient.call()` 已有 tenant_access_token 缓存+单飞刷新骨架(client.ts:149-211),
  fetch 全程可注入(client.ts:46);
- **全仓无出站媒体上传先例**:`im/v1/files`/`im/v1/images` 只活在注释里,multipart
  上传是全新代码;
- **ffmpeg 先例** = `butler-memory-git.ts` 姿态:`execFile` + **可注入 runner**(测试
  免真二进制)+ `maxBuffer` + **仅 ENOENT 重抛→上层软跳过**(:31-71);
- **opt-in 装配先例** = M-EMB1 `butler-embedder.ts`:`fromEnv()` 缺关键 env 即
  `undefined`,未配=字节不变;main.ts:948 构造 + disclosure 日志;
- **回复无任何后处理**:`summariseResult()` ok 分支原样返回 `output.text`
  (im-bridge.ts:1311-1319),A4「别甩 Markdown 墙」是 prompt 软引导非剥离 ——
  TTS 入参清洗(剥 markdown 记号)要自建。

## 四、不可破边界

1. **opt-in,未配字节不变** —— `GOTONG_BUTLER_VOICE_URL/_KEY/_MODEL/_VOICE` 四旋钮
   (115→119,登记),**四者任一缺** = `fromEnv()` 返回 `undefined` = 全链路
   与今天逐字节一致(附件恒为空;OpenAI 兼容 `/audio/speech` 的 model 与 voice
   都是必填参数,不设默认——静默猜模型名会把失败推迟到运行时);
2. **fail-soft,语音绝不吞回复** —— TTS 超时/失败/ffmpeg 缺失/上传失败,任何一环
   坏都退回纯文本发送并 warn 一次;语音是增强不是依赖;
3. **数据离盒披露** —— 开了语音 = 阿同的回复文本逐条发给 TTS 厂商,启动日志必须
   印 disclosure(M-EMB1 同款),文档明说;
4. **合法音色红线** —— 只接厂商系统音色;音色 id 是配置,但**永不**提供、引导或
   文档化任何真人声音克隆路径;
5. **长度自建阈值** —— 超过阈值字数的回复直接跳过 TTS 退文本(飞书语音条本就不
   适合长内容),阈值走常量不加旋钮;
6. **内核零改动** —— core/protocol/workflow/im-adapter 零触碰;改动面 =
   host 新叶子 + im-lark 扩两文件 + 装配三缝。

## 五、里程碑

- **M1 TTS 纯核 ✅(2026-07-17 落地,host `butler-voice.ts`,镜像 butler-embedder.ts)**
  —— `ttsSpeech`(OpenAI 兼容 `/audio/speech`,fetch 注入,AbortController 30s 超时,
  key 只进 Authorization 头)+ `toOpusVoice` 转码(spawn ffmpeg `libopus -ac 1
  -ar 16000 -f ogg`,`FfmpegRunner` 注入镜像 butler-memory-git 的 GitRunner——非零
  exit 是**结果**不是异常,只有 spawn 本身失败(ENOENT)才 reject → 映射成诚实的
  「未装 ffmpeg」)+ `butlerVoiceFromEnv()`(四 env 全设才开,任缺=undefined)+
  `prepareSpeechText` markdown 剥离清洗(代码块=拒读;下划线保留护 snake_case)+
  `VOICE_MAX_CHARS=240` 常量阈值 + `buildButlerVoice().synthesize` **永不抛**三态
  合同(`clip`/`skipped` 设计内静音/`failed` 基建故障值得 warn)。20 单测全绿,
  含凭证纪律逐字断言(key 不进 URL/argv/disclosure)。
- **M2 im-lark audio 腿 ✅(2026-07-17 落地)** —— `LarkClient.uploadFile()`
  (multipart `im/v1/files`,原生 FormData 免手拼 boundary,file_type=opus+duration)
  + `sendMessage` 附件分支:`kind:'audio'` 附件 → 上传 → `msg_type:'audio'` 发送;
  任一环失败 onError + 回落文本(现有姿态)。**落地偏差(比计划更稳)**:语音条
  时长不走边信道——`audio.ts` 的 `opusDurationMs()` 直接从 Ogg 容器末页
  granulepos/48 推出毫秒数,`ImAttachment` 契约零改动、im-adapter 零触碰;非 ogg
  字节=null=拒绝按 opus 上传(诚实拒不撒谎);granule 读不出退字节数估算。
  im-lark 73 测试全绿(audio 4 + client 4 + bridge 4 新增)。
- **M3 装配 ✅(2026-07-17 落地)** —— main.ts 构造 `butlerVoiceFromEnv()` +
  disclosure 日志(M-EMB1 同款,报模型/音色/主机+数据离盒真相,永不报 key)→
  `im-bridge-wiring` 窄鸭子 `ImBridgeVoiceSynth` 透传 → `startImBridges.voice` →
  自由文本 OK 回复合成附件;旋钮登记 115→119;6 例路由防腐测试(无 voice ⇒
  sendMessage options **结构性无 attachments 键** = 字节不变;synth 抛异常绝不吞
  回复;failed warn 一次 skipped 静音)。**落地收窄(设计决定)**:语音只上
  **对话式 OK 回复**(`result.kind==='ok'` 的自由文本分支)——命令输出与失败/挂起
  播报携带可复制短码(`/approve <id>`),语音条在平台腿**替换**文本,读出来短码就
  没了,故它们刻意保持纯文本;M0 计划的第二汇聚点(butler-reachable push 腿)同理
  **推迟**——push 内容多为提醒/播报类,常含短码与指路命令,等真实使用信号再定
  「哪些 push 适合朗读」的白名单,不预造。
- **M3b 小米 MiMo chat wire 变体 ✅(2026-07-17 落地)** —— `ttsSpeech` 双 wire:
  `isMimoTtsWire(model)`(`mimo-*tts*` 形状)命中时改走 `POST <base>/chat/completions`
  (文本进 assistant 消息、`audio:{format:'wav', voice}`、响应取
  `choices[0].message.audio.data` base64 解码),否则照走 `/audio/speech` 老 wire
  ——**零新旋钮**,同四旋钮 URL+MODEL 决定 wire;user 消息风格槽固定空串(人设是
  音色 id 的事,不是旋钮)。缺/空 `audio.data` 响亮抛 → synthesize 折 `failed`;
  解码后字节走同一 ffmpeg 腿(wav 自动嗅探)与 30MB 顶。**红线结构性落地**:
  `buildButlerVoice` 对 `voiceclone` 模型族构造时当场拒(民法典 1023,签名钥
  「坏钥当场拒」同姿态),装配路径配不出克隆腿。butler-voice 20→26 单测
  (mimo wire 逐字节体断言/无 audio.data 四变体 failed 零 ffmpeg/内容闸先于
  网络/HTTP 500 fail-soft/非 mimo 模型照走老 wire/克隆模型双路径拒)。
- **M4 生产真机(需用户 key,当前唯一未落)** —— 服务器 ffmpeg **已装**(6.1.1,
  2026-07-17);剩:飞书后台开 `im:resource`(用户自办)、gotong.env 加四值
  (备份先行;`GOTONG_BUTLER_VOICE_URL=https://api.xiaomimimo.com/v1` +
  `_MODEL=mimo-v2.5-tts` + `_VOICE=茉莉` + `_KEY=<小米 key>`),真机
  round-trip:发消息→收到语音条→关掉开关→回文本。**开放疑问(配置时现场探)**:
  用户手上的小米 key 若是 token-plan 域(`token-plan-cn.xiaomimimo.com`)签发,
  对 `api.xiaomimimo.com` 的 TTS 面是否通用,配置时真探针一发定论。M4 前
  M1-M3b 全程不依赖 key,已全绿。

## 六、显式不做(本 track)

- 其他五桥的语音出站(契约已留 `ImAttachment` 缝,谁需要谁接);
- 飞书**入站**语音的下载+转写(入站音频现在只到 `lark-audio:<file_key>` URI,
  下载端点未实现 —— 独立票,与微信服务端转写不同,飞书要自己请 STT);
- 语音/文本的智能选择(「什么时候用语音回」v1 走简单规则:开了就短回复出语音,
  超阈值出文本;更细的策略等真实使用信号);
- butler-reachable push 腿的语音(M3 收窄推迟——push 常含短码/指路命令,语音条
  替换文本会毁掉可复制性;等真实信号再定朗读白名单);
- 真人克隆音色(永不,见边界④)。
