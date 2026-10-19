import postgres from "postgres";
import { makeActions, UserError } from "../lib/core.js";

// DB 연결은 함수가 살아있는 동안 재사용 (Supabase Transaction pooler: 6543 포트 주소를 DATABASE_URL 에 넣기)
let sql;
function db() {
  if (!sql) {
    sql = postgres(process.env.DATABASE_URL, {
      prepare: false, // Transaction pooler 필수 설정
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
      ssl: process.env.DB_SSL === "off" ? false : "require",
    });
  }
  return sql;
}

// 지금 옮겨진 기능 목록 (나머지는 아직 구글 Apps Script 쪽에서 처리)
const ALLOWED = ["version", "login", "get_rooms", "get_room_detail", "get_my_week_count", "ticket", "register_link", "update_link", "land"];

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
  if (!b || typeof b !== "object") b = {};
  return { ...(req.query || {}), ...b };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const b = parseBody(req);
  const action = b.action;
  try {
    if (!ALLOWED.includes(action)) return res.status(200).json({ ok: false, error: "unknown_action: " + action });
    const out = await makeActions(db())[action](b);
    return res.status(200).json(out);
  } catch (e) {
    console.error("[요청오류]", action, e?.message);
    const msg = e instanceof UserError ? e.message : "서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.";
    return res.status(200).json({ ok: false, error: msg });
  }
}
