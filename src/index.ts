import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";

export interface Env {
  BOT_TOKEN: string;
  CHANNEL_ID: string;
  MY_USER_ID: string;
  SECRET_KEY: string;
  BASE_URL: string;
  WEBHOOK_SECRET?: string;
  DB: D1Database;
}

const LINK_EXPIRE_SECONDS = 3600;
const RATE_LIMIT_PER_MINUTE = 30;

// ── HMAC helper ──

let hmacKey: CryptoKey | null = null;

async function getHmacKey(secret: string): Promise<CryptoKey> {
  if (hmacKey) return hmacKey;
  hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hmacKey;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

async function signToken(token: string, secret: string): Promise<string> {
  const key = await getHmacKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── D1 helpers ──

async function getCounter(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT value FROM counter WHERE id = 1")
    .first<{ value: number }>();
  return row?.value ?? 1;
}

async function incrementCounter(db: D1Database): Promise<void> {
  await db.prepare("UPDATE counter SET value = value + 1 WHERE id = 1").run();
}

async function saveFileRecord(
  db: D1Database,
  token: string,
  fileId: string,
  fileName: string,
  fileSize: number,
  expiresAt: number,
) {
  await db
    .prepare(
      "INSERT OR REPLACE INTO files (token, file_id, file_name, file_size, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(token, fileId, fileName, fileSize, Date.now() / 1000, expiresAt)
    .run();
}

async function getFileRecord(db: D1Database, token: string) {
  return db
    .prepare("SELECT * FROM files WHERE token = ?")
    .bind(token)
    .first<{
      token: string;
      file_id: string;
      file_name: string;
      file_size: number;
      created_at: number;
      expires_at: number;
    }>();
}

async function incrementDownload(db: D1Database, token: string) {
  await db
    .prepare("INSERT OR IGNORE INTO stats (token, downloads) VALUES (?, 0)")
    .bind(token)
    .run();
  await db
    .prepare("UPDATE stats SET downloads = downloads + 1 WHERE token = ?")
    .bind(token)
    .run();
}

async function cleanExpiredRecords(db: D1Database) {
  const now = Date.now() / 1000;
  await db.prepare("DELETE FROM files WHERE expires_at < ?").bind(now).run();
}

// ── Rate limiter ──

async function checkRateLimit(
  db: D1Database,
  ip: string,
): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / 60000) * 60;
  await db
    .prepare("DELETE FROM rate_limits WHERE ip = ? AND ts < ?")
    .bind(ip, windowStart)
    .run();
  const row = await db
    .prepare("SELECT COUNT(*) as cnt FROM rate_limits WHERE ip = ?")
    .bind(ip)
    .first<{ cnt: number }>();
  const count = row?.cnt ?? 0;
  if (count >= RATE_LIMIT_PER_MINUTE) return false;
  await db
    .prepare("INSERT INTO rate_limits (ip, ts) VALUES (?, ?)")
    .bind(ip, Date.now() / 1000)
    .run();
  return true;
}

// ── Bot logic ──

function setupBot(bot: Telegraf, env: Env) {
  bot.start(async (ctx) => {
    if (ctx.from?.id.toString() !== env.MY_USER_ID) return;
    await ctx.reply("Send video/file to get download link.");
  });

  bot.on(message("video"), async (ctx) => handleFile(ctx, env));
  bot.on(message("document"), async (ctx) => handleFile(ctx, env));
}

async function handleFile(ctx: any, env: Env) {
  if (ctx.from?.id.toString() !== env.MY_USER_ID) return;

  const msg = ctx.message;
  let fileName: string;
  let fileSize: number;

  if (msg.video) {
    fileName = msg.video.file_name || "video.mp4";
    fileSize = msg.video.file_size || 0;
  } else if (msg.document) {
    fileName = msg.document.file_name || "file.bin";
    fileSize = msg.document.file_size || 0;
  } else {
    return;
  }

  const forwarded = await ctx.telegram.forwardMessage(
    env.CHANNEL_ID,
    msg.chat.id,
    msg.message_id,
  );

  const forwardedFile = forwarded.video || forwarded.document;
  if (!forwardedFile) {
    await ctx.reply("Failed to forward file. Try again.");
    return;
  }
  const fileId = forwardedFile.file_id;

  const token = crypto.randomUUID();
  const expires = Date.now() / 1000 + LINK_EXPIRE_SECONDS;

  await saveFileRecord(env.DB, token, fileId, fileName, fileSize, expires);

  const chatLinkId = env.CHANNEL_ID.replace("-100", "");
  const link = `https://t.me/c/${chatLinkId}/${forwarded.message_id}`;

  const videoNumber = await getCounter(env.DB);
  const sizeMb = (fileSize / (1024 * 1024)).toFixed(2);

  await ctx.reply(
    `📦 File Size : ${sizeMb} MB\n⬇️ Video ${videoNumber} : ${fileName}\n🔗 ${link}`,
  );

  await incrementCounter(env.DB);
}

// ── Stream handler ──

async function handleStream(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.pathname.split("/").pop() || "";
  const sig = url.searchParams.get("s") || "";
  const isDownload = url.searchParams.get("download") === "1";

  const expectedSig = await signToken(token, env.SECRET_KEY);
  if (!timingSafeEqual(sig, expectedSig)) {
    return new Response("Unauthorized", { status: 403 });
  }

  const clientIp =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "unknown";

  const allowed = await checkRateLimit(env.DB, clientIp);
  if (!allowed) {
    return new Response("Rate limit exceeded", { status: 429 });
  }

  const record = await getFileRecord(env.DB, token);
  if (!record) {
    return new Response("Link not found", { status: 404 });
  }

  if (record.expires_at && Date.now() / 1000 > record.expires_at) {
    return new Response("Link expired", { status: 403 });
  }

  await incrementDownload(env.DB, record.token);

  let filePath: string;
  try {
    const fileInfoUrl = `https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(record.file_id)}`;
    const fileInfoRes = await fetch(fileInfoUrl);
    if (!fileInfoRes.ok) {
      const errorText = await fileInfoRes.text();
      return new Response(`Upstream error: ${errorText}`, { status: 502 });
    }
    const fileInfo: any = await fileInfoRes.json();
    if (!fileInfo?.ok || !fileInfo?.result?.file_path) {
      return new Response("File not available", { status: 500 });
    }
    filePath = fileInfo.result.file_path;
  } catch {
    return new Response("Failed to fetch file info", { status: 502 });
  }

  const tgUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;

  const rangeHeader = request.headers.get("Range");
  const upstreamHeaders: Record<string, string> = {};
  if (rangeHeader) upstreamHeaders["Range"] = rangeHeader;

  let tgRes: Response;
  try {
    tgRes = await fetch(tgUrl, { headers: upstreamHeaders });
    if (!tgRes.ok) {
      return new Response("Telegram file unavailable", { status: 502 });
    }
  } catch {
    return new Response("Failed to proxy file", { status: 502 });
  }

  const disposition = isDownload
    ? `attachment; filename="${record.file_name}"`
    : `inline; filename="${record.file_name}"`;

  const responseHeaders = new Headers(tgRes.headers);
  responseHeaders.set("Content-Disposition", disposition);
  responseHeaders.set("Accept-Ranges", "bytes");
  responseHeaders.set("Cache-Control", "no-cache");

  return new Response(tgRes.body, {
    status: tgRes.status,
    headers: responseHeaders,
  });
}

// ── Worker entry ──

let botInstance: Telegraf | null = null;

function getBot(env: Env): Telegraf {
  if (!botInstance) {
    botInstance = new Telegraf(env.BOT_TOKEN);
    setupBot(botInstance, env);
  }
  return botInstance;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/webhook") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      if (
        env.WEBHOOK_SECRET &&
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
          env.WEBHOOK_SECRET
      ) {
        return new Response("Forbidden", { status: 403 });
      }
      const bot = getBot(env);
      const update = await request.json();
      await bot.handleUpdate(update);
      return new Response("OK");
    }

    if (url.pathname.startsWith("/stream/")) {
      return handleStream(request, env);
    }

    if (url.pathname === "/") {
      return new Response("Running");
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await cleanExpiredRecords(env.DB);
  },
};
