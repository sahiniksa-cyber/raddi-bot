/**
 * lib/constants.js — ثوابت المشروع
 */
'use strict';

/** مدة إيقاف البوت عند رد المالك يدوياً (30 دقيقة) */
const OWNER_PAUSE_MS = 30 * 60 * 1000;

/**
 * نص افتراضي لرسالة "توقف الردّ الآلي" التي تُرسل للعميل مرة واحدة عند نفاد رصيد
 * الرسائل. يُستخدم كقيمة افتراضية/placeholder في الداشبورد فقط — النص الفعلي
 * المُرسَل يأتي دائماً من إعداد المنصّة platform_settings.quotaStopMessage.text،
 * ولا يُكتب داخل الـ worker إطلاقاً.
 */
const DEFAULT_QUOTA_STOP_MESSAGE = 'نعتذر، خدمة الردّ الآلي متوقفة مؤقتاً. سيتم الرد عليك في أقرب وقت 🙏';

/** أسعار الموديلات لكل مليون توكن */
const MODEL_PRICES = {
  'gpt-4o-mini':   { in: 0.15,  out: 0.60  },
  'gpt-4o':        { in: 2.50,  out: 10.00 },
  'gpt-4-turbo':   { in: 10.00, out: 30.00 },
  'gpt-3.5-turbo': { in: 0.50,  out: 1.50  },
  'o3-mini':       { in: 1.10,  out: 4.40  },
  'o1-mini':       { in: 3.00,  out: 12.00 },
  'anthropic/claude-opus-4':                        { in: 15.00, out: 75.00 },
  'anthropic/claude-sonnet-4-5':                    { in: 3.00,  out: 15.00 },
  'anthropic/claude-3-5-haiku':                     { in: 0.80,  out: 4.00  },
  'anthropic/claude-3-5-sonnet':                    { in: 3.00,  out: 15.00 },
  'anthropic/claude-3-opus':                        { in: 15.00, out: 75.00 },
  'anthropic/claude-3-haiku':                       { in: 0.25,  out: 1.25  },
  'google/gemini-2.5-pro':                          { in: 1.25,  out: 5.00  },
  'google/gemini-2.0-flash':                        { in: 0.10,  out: 0.40  },
  'google/gemini-2.0-flash:free':                   { in: 0,     out: 0     },
  'google/gemini-1.5-pro':                          { in: 1.25,  out: 5.00  },
  'google/gemini-1.5-flash':                        { in: 0.075, out: 0.30  },
  'google/gemini-1.5-flash:free':                   { in: 0,     out: 0     },
  'meta-llama/llama-3.3-70b-instruct':              { in: 0.12,  out: 0.30  },
  'meta-llama/llama-3.3-70b-instruct:free':         { in: 0,     out: 0     },
  'meta-llama/llama-4-maverick':                    { in: 0.18,  out: 0.60  },
  'meta-llama/llama-3.1-405b-instruct':             { in: 0.80,  out: 0.80  },
  'meta-llama/llama-3.1-8b-instruct:free':          { in: 0,     out: 0     },
  'deepseek/deepseek-chat':                         { in: 0.27,  out: 1.10  },
  'deepseek/deepseek-chat:free':                    { in: 0,     out: 0     },
  'deepseek/deepseek-r1':                           { in: 0.55,  out: 2.19  },
  'deepseek/deepseek-r1:free':                      { in: 0,     out: 0     },
  'mistralai/mistral-large-2411':                   { in: 2.00,  out: 6.00  },
  'mistralai/mistral-nemo:free':                    { in: 0,     out: 0     },
  'mistralai/mistral-small-3.1-24b-instruct:free':  { in: 0,     out: 0     },
  'qwen/qwen3-235b-a22b':                           { in: 0.14,  out: 0.60  },
  'qwen/qwen3-235b-a22b:free':                      { in: 0,     out: 0     },
  'qwen/qwen-2.5-72b-instruct':                     { in: 0.35,  out: 0.40  },
  'x-ai/grok-3-mini':                               { in: 0.30,  out: 0.50  },
  'x-ai/grok-3':                                    { in: 3.00,  out: 15.00 },
  'cohere/command-r-plus-08-2024':                  { in: 2.50,  out: 10.00 },
};

/** الإعدادات الافتراضية لمستخدم جديد */
const DEFAULT_CONFIG = {
  storeName: '', storeDescription: '', workingHours: '', welcomeMessage: '',
  botInstructions: '', welcomeMode: 'inline', model: 'gpt-4o',
  openaiApiKey: '', openrouterApiKey: '', replyDelayPreset: '1min',
  autoReplyEnabled: true,
  memoryMessages: 50, maxResponseLength: 300,
  products: [], autoReplyKeywords: {},
  escalationContacts: [],
  // Escalation behavior (per-merchant, all optional with safe defaults)
  escalationConditions: '',            // extra merchant-defined "when to escalate" rules (injected into the prompt)
  maxEscalationsPerConversation: 5,    // re-escalation cap per conversation / 24h (0 = unlimited)
  escalationPausesBot: false,          // after an escalation: false = bot keeps helping; true = pause it
  escalationPauseMinutes: 5,           // how long to pause after escalation when escalationPausesBot is on
  // Owner-pause: when the owner replies from their phone
  ownerPausePhraseMode: false,         // false = ANY owner reply pauses; true = only replies containing a trigger phrase pause
  ownerPausePhrases: [],               // trigger phrases for ownerPausePhraseMode
  messageGroupingSeconds: 30,          // AI-reply debounce window: groups consecutive customer messages into one reply (5–60s)
  doNotReplyList: [],                  // per-merchant block list: [{ number, name }] — bot stays silent for these customers (matched by number)
  replyStyle: {
    tone: 'ودي ومحترم', useDialect: true, dialect: 'السعودية الخفيفة',
    emojiLevel: 'none', useShortReplies: false,
    multilineFormat: false,
    avoidPhrases: [],
  },
};

/** معلمات إعادة المحاولة (Exponential Backoff) */
const RETRY = {
  MAX_ATTEMPTS: Infinity,
  DELAYS_MS: [3000, 6000, 12000, 20000, 30000, 45000, 60000],
  JITTER_MAX_MS: 1500,
};

/** فترات المراقبة */
const TIMERS = {
  HEARTBEAT_INTERVAL_MS: 30000,
  HEARTBEAT_FAIL_THRESHOLD: 2,
  WATCHDOG_TIMEOUT_MS: 90000,
  HEALTH_PROBE_DELAY_MS: 8000,
  SEND_MESSAGE_TIMEOUT_MS: 30000,
  PROCESSING_LOCK_EXPIRE_MS: 180000,
  MESSAGE_RETRY_DELAY_MS: 15000,
  MESSAGE_MAX_ATTEMPTS: 3,
  AUTO_FIX_INTERVAL_MS: 4000,
  AI_MIN_CALL_INTERVAL_MS: 4000,
};

/** Presets التأخير */
const DELAY_PRESETS = {
  '30s':    [22, 40],
  '1min':   [50, 75],
  '1.5min': [75, 105],
  // Legacy
  instant:  [22, 40],
  '15s':    [22, 40],
  '2min':   [75, 105],
  '3min':   [75, 105],
  random:   [50, 75],
};

module.exports = {
  OWNER_PAUSE_MS,
  DEFAULT_QUOTA_STOP_MESSAGE,
  MODEL_PRICES,
  DEFAULT_CONFIG,
  RETRY,
  TIMERS,
  DELAY_PRESETS,
};
