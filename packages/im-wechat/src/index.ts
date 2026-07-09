/**
 * @gotong/im-wechat — public surface (WX-M1: protocol core only; the
 * ImBridge implementation lands in WX-M2).
 */

export {
  createWechatIlinkClient,
  buildIlinkClientVersion,
  randomWechatUin,
  WechatIlinkError,
  WECHAT_ILINK_BASE_URL,
  STALE_TOKEN_ERRCODE,
  STALE_SESSION_PAUSE_MS,
  type WechatIlinkClient,
  type WechatIlinkClientOptions,
  type WechatGetUpdatesParams,
  type WechatSendTextParams,
} from './client.js'
export {
  wechatToImMessage,
  wechatContextToken,
  WECHAT_MEDIA_URI_PREFIX,
} from './message.js'
export {
  WechatMessageType,
  WechatMessageItemType,
  WechatMessageState,
  WechatTypingStatus,
  type WechatBaseInfo,
  type WechatCdnMedia,
  type WechatFileItem,
  type WechatGetConfigResp,
  type WechatGetUpdatesResp,
  type WechatImageItem,
  type WechatMessage,
  type WechatMessageItem,
  type WechatQrcodeResp,
  type WechatQrStatus,
  type WechatQrStatusResp,
  type WechatRefMessage,
  type WechatSendMessageResp,
  type WechatTextItem,
  type WechatVideoItem,
  type WechatVoiceItem,
} from './types.js'
