export const FLAP_START = 0x2a;
export const FLAP_SIGNON = 0x01;
export const FLAP_DATA = 0x02;
export const FLAP_SIGNOFF = 0x04;
export const FLAP_KEEPALIVE = 0x05;
export const FLAP_VERSION = 1;
export const FLAP_HEADER_LENGTH = 6;
export const FLAP_MAX_PAYLOAD = 0xfff9;

export const SNAC_HEADER_LENGTH = 10;
export const SNAC_FLAG_EXTENDED = 0x8000;
export const SERVER_REQUEST_ID = 0x80000000;

export const FAMILY_OSERVICE = 0x0001;
export const FAMILY_LOCATE = 0x0002;
export const FAMILY_BUDDY = 0x0003;
export const FAMILY_ICBM = 0x0004;
export const FAMILY_BUCP = 0x0017;

export const OSERVICE_ERR = 0x0001;
export const OSERVICE_CLIENT_ONLINE = 0x0002;
export const OSERVICE_HOST_ONLINE = 0x0003;
export const OSERVICE_SERVICE_REQUEST = 0x0004;
export const OSERVICE_SERVICE_RESPONSE = 0x0005;
export const OSERVICE_RATE_PARAMS_QUERY = 0x0006;
export const OSERVICE_RATE_PARAMS_REPLY = 0x0007;
export const OSERVICE_RATE_PARAMS_SUB_ADD = 0x0008;
export const OSERVICE_RATE_PARAM_CHANGE = 0x000a;
export const OSERVICE_USER_INFO_QUERY = 0x000e;
export const OSERVICE_USER_INFO_UPDATE = 0x000f;
export const OSERVICE_CLIENT_VERSIONS = 0x0017;
export const OSERVICE_PROBE_REQ = 0x001f;
export const FOOD_GROUP_VERSION = 1;
export const CLIENT_TOOL_ID = 0x0110;
export const CLIENT_TOOL_VERSION = 0x0629;

export const SERVICE_TLV_ROOM_INFO = 0x0001;
export const SERVICE_TLV_RECONNECT_HERE = 0x0005;
export const SERVICE_TLV_COOKIE = 0x0006;
export const SERVICE_TLV_USE_SSL = 0x008c;
export const SERVICE_TLV_SSL_STATE = 0x008e;
export const SERVICE_COOKIE_TTL_MS = 60_000;

export const RATE_CODE_ALERT = 2;
export const RATE_CODE_LIMITED = 3;
export const RATE_CODE_CLEAR = 4;
export const RATE_CLASS_RECORD_LENGTH_V2 = 35;
export const RATE_CLASS_IM = 3;

export const USER_INFO_FLAGS = 0x0001;
export const USER_FLAG_AWAY = 0x0020;
export const USER_FLAG_BOT = 0x0400;

export const LOCATE_SET_INFO = 0x0004;
export const LOCATE_TLV_AWAY_TEXT = 0x0004;
export const LOCATE_TLV_CAPABILITIES = 0x0005;
export const CAPABILITY_LENGTH = 16;
export const CAP_CHAT: Uint8Array = Uint8Array.of(
  0x74, 0x8f, 0x24, 0x20, 0x62, 0x87, 0x11, 0xd1, 0x82, 0x22, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00,
);

export const BUDDY_ADD_BUDDIES = 0x0004;
export const BUDDY_DEL_BUDDIES = 0x0005;
export const BUDDY_ARRIVED = 0x000b;
export const BUDDY_DEPARTED = 0x000c;

export const ICBM_ERR = 0x0001;
export const ICBM_MSG_TO_HOST = 0x0006;
export const ICBM_MSG_TO_CLIENT = 0x0007;
export const ICBM_HOST_ACK = 0x000c;
export const ICBM_OFFLINE_RETRIEVE = 0x0010;
export const ICBM_CLIENT_EVENT = 0x0014;

export const ICBM_CHANNEL_IM = 1;
export const ICBM_CHANNEL_RENDEZVOUS = 2;
export const ICBM_TLV_IM_DATA = 0x0002;
export const ICBM_TLV_REQUEST_HOST_ACK = 0x0003;
export const ICBM_TLV_AUTO_RESPONSE = 0x0004;
export const ICBM_TLV_STORE = 0x0006;
export const ICBM_TLV_SEND_TIME = 0x0016;
export const ICBM_FRAGMENT_CAPS = 5;
export const ICBM_FRAGMENT_TEXT = 1;
export const ICBM_FRAGMENT_VERSION = 1;
export const ICBM_FRAGMENT_CAPS_TEXT: Uint8Array = Uint8Array.of(0x01, 0x01, 0x02);
export const ICBM_CHARSET_ASCII = 0;
export const ICBM_CHARSET_UNICODE = 2;
export const ICBM_CHARSET_LATIN1 = 3;
export const ICBM_EVENT_NONE = 0;
export const ICBM_EVENT_TYPED = 1;
export const ICBM_EVENT_TYPING = 2;
export const ICBM_ERROR_NOT_LOGGED_ON = 0x0004;

export const BUCP_LOGIN_REQUEST = 0x0002;
export const BUCP_LOGIN_RESPONSE = 0x0003;
export const BUCP_CHALLENGE_REQUEST = 0x0006;
export const BUCP_CHALLENGE_RESPONSE = 0x0007;

export const LOGIN_TLV_SCREEN_NAME = 0x0001;
export const LOGIN_TLV_CLIENT_ID = 0x0003;
export const LOGIN_TLV_RECONNECT_HERE = 0x0005;
export const LOGIN_TLV_COOKIE = 0x0006;
export const LOGIN_TLV_ERROR = 0x0008;
export const LOGIN_TLV_PASSWORD_HASH = 0x0025;
export const LOGIN_TLV_MULTI_CONN = 0x004a;
export const LOGIN_TLV_SSL_STATE = 0x008e;
export const MULTI_CONN_SINGLE = 0x03;
export const LOGIN_HASH_SUFFIX = 'AOL Instant Messenger (SM)';

export const LOGIN_ERR_UNKNOWN_NAME = 0x0001;
export const LOGIN_ERR_BAD_PASSWORD = 0x0005;
export const LOGIN_ERR_INVALID_ACCOUNT = 0x0007;
// wire/snacs.go:123 LoginErrDeletedAccount and wire/snacs.go:131 LoginErrICQUserErr share 0x0008;
// loginErrorReason tells them apart by whether the screen name is a UIN.
export const LOGIN_ERR_DELETED = 0x0008;
export const LOGIN_ERR_EXPIRED = 0x0009;
export const LOGIN_ERR_SUSPENDED = 0x0011;
export const LOGIN_ERR_RATE_LIMITED = 0x001d;
export const LOGIN_ERR_SUSPENDED_AGE = 0x0022;

export const SIGNOFF_TLV_DISCONNECT_REASON = 0x0009;

export const SYSTEM_SENDER = 'oossystemmsg';

export const KEEPALIVE_INTERVAL_MS = 60_000;
export const PROBE_INTERVAL_MS = 90_000;
export const PROBE_TIMEOUT_MS = 20_000;
export const CONNECT_TIMEOUT_MS = 20_000;
export const REQUEST_TIMEOUT_MS = 20_000;
export const RECEIPT_TIMEOUT_MS = 10_000;

export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_FACTOR = 2;
export const BACKOFF_CAP_MS = 120_000;
export const BACKOFF_JITTER = 0.2;
export const BACKOFF_FLOOR_MS = 60_000;
export const BACKOFF_FLOOR_AFTER_FAILURES = 3;
export const SERVER_DISCONNECT_BACKOFF_MS = 60_000;
export const STABLE_ONLINE_MS = 60_000;
export const LOGIN_BUDGET_PER_MINUTE = 8;
export const LOGIN_STAGGER_MS = 2_000;
export const RATE_RECENT_MS = 30_000;
export const PASSWORD_CHECK_CACHE_MS = 24 * 60 * 60 * 1000;
export const TYPING_KEEPALIVE_MS = 8_000;
export const TYPING_MAX_MS = 120_000;
