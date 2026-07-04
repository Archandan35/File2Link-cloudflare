import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";

export interface Env {
  BOT_TOKEN: string;
  CHANNEL_ID: string;
  MY_USER_ID: string;
  SECRET_KEY: string;
  BASE_URL: string;
  DB: D1Database;
}

const LINK_EXPIRE_SECONDS = 3600;

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
  let fileId: string;
  let fileName: string;
  let fileSize: number;

  if (msg.video) {
    fileId = msg.video.file_id;
    fileName = msg.video.file_name || "video.mp4";
    fileSize = msg.video.file_size || 0;
  } else if (msg.document) {
    fileId = msg.document.file_id;
    fileName = msg.document.file_name || "file.bin";
    fileSize = msg.document.file_size || 0;
  } else {
    return;
  }

  await ctx.telegram.forwardMessage(
    env.CHANNEL_ID,
    msg.chat.id,
    msg.message_id,
  );

  const token = crypto.randomUUID();
  const expires = Date.now() / 1000 + LINK_EXPIRE_SECONDS;

  await saveFileRecord(env.DB, token, fileId, fileName, fileSize, expires);

  const link = `${env.BASE_URL}/stream/${token}?key=${env.SECRET_KEY}&download=1`;

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
  const key = url.searchParams.get("key");

  if (key !== env.SECRET_KEY) {
    return new Response("Unauthorized", { status: 403 });
  }

  const record = await getFileRecord(env.DB, token);
  if (!record) {
    return new Response("Link not found", { status: 404 });
  }

  if (record.expires_at && Date.now() / 1000 > record.expires_at) {
    return new Response("Link expired", { status: 403 });
  }

  await incrementDownload(env.DB, record.token);

  const fileInfoUrl = `https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${record.file_id}`;
  const fileInfoRes = await fetch(fileInfoUrl);
  const fileInfo: any = await fileInfoRes.json();

  if (!fileInfo.ok) {
    return new Response("File not available", { status: 500 });
  }

  const tgUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileInfo.result.file_path}`;

  const rangeHeader = request.headers.get("Range");
  const upstreamHeaders: Record<string, string> = {};
  if (rangeHeader) upstreamHeaders["Range"] = rangeHeader;

  const tgRes = await fetch(tgUrl, { headers: upstreamHeaders });

  const responseHeaders = new Headers(tgRes.headers);
  responseHeaders.set(
    "Content-Disposition",
    `attachment; filename="${record.file_name}"`,
  );
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
};
