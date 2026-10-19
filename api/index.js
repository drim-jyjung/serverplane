import postgres from "postgres";
import { makeActions, UserError } from "../lib/core.js";
import { makeAdminActions } from "../lib/admin.js";
import { makeSettleActions } from "../lib/settle.js";
import { signAdminToken, verifyAdminToken } from "../lib/auth.js";

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
const ALLOWED = [
  // 크루 화면
  "version", "login", "get_rooms", "get_room_detail", "get_my_week_count", "ticket", "register_link", "update_link", "land",
  // 관리자 화면 (읽기 + 방 관리)
  "admin_login", "get_presets", "get_all_rooms", "get_room_details_batch", "get_members", "get_warnings", "get_parts", "get_logs", "get_daily", "get_last_week_result",
  "create_room", "create_preset", "update_room", "delete_room", "admin_update_link", "admin_land", "admin_delete_part",
  // 정산 · 경고 · 회원 · 주간현황
  "run_daily", "run_weekly", "get_week_sheet", "init_week_sheet", "manual_warn", "resolve_warning", "adjust_warn",
  "adjust_excellent", "adjust_honorary", "toggle_lock", "add_member", "update_member",
  // 자동 실행 (CRON_SECRET 필요)
  "auto_lock_expired", "auto_daily_job",
];

// 로그인한 관리자만 쓸 수 있는 기능 (관리자 로그인 확인표 필요)
const ADMIN_ONLY = new Set([
  "get_all_rooms", "get_room_details_batch", "get_members", "get_warnings", "get_parts", "get_logs", "get_daily", "get_last_week_result",
  "create_room", "create_preset", "update_room", "delete_room", "admin_update_link", "admin_land", "admin_delete_part",
  "run_daily", "run_weekly", "get_week_sheet", "init_week_sheet", "manual_warn", "resolve_warning", "adjust_warn",
  "adjust_excellent", "adjust_honorary", "toggle_lock", "add_member", "update_member",
]);
const AUTH_FAIL = { ok: false, error: "관리자 로그인이 필요합니다. 다시 로그인해주세요", auth_required: true };

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
  const t0 = Date.now();
  // 어떤 요청이 몇 ms 걸렸는지 Vercel Logs 에 남김 (느린 기능 찾기용). 비밀번호·개인정보는 남기지 않음
  res.on?.("finish", () => console.log(`[요청] action=${action} ${Date.now() - t0}ms region=${process.env.VERCEL_REGION || "?"}`));
  try {
    if (!ALLOWED.includes(action)) return res.status(200).json({ ok: false, error: "unknown_action: " + action });
    if (ADMIN_ONLY.has(action)) {
      const who = verifyAdminToken(process.env.ADMIN_SECRET, b.admin_token);
      if (!who) return res.status(200).json(AUTH_FAIL);
      // 퇴사 처리(비활성)된 관리자는 표가 남아 있어도 즉시 차단
      const [a] = await db()`select 1 as x from admins where admin_id = ${who.admin_id} and status = 'active'`;
      if (!a) return res.status(200).json(AUTH_FAIL);
      b.admin_id = who.admin_id; b.admin_nickname = who.nickname; // 요청 내용이 아니라 표에 적힌 관리자로 기록
    }
    const actions = { ...makeActions(db()), ...makeAdminActions(db()), ...makeSettleActions(db(), { cronSecret: process.env.CRON_SECRET }) };
    const out = await actions[action](b);
    if (action === "admin_login" && out?.ok) {
      if (!process.env.ADMIN_SECRET) return res.status(200).json({ ok: false, error: "서버 설정(ADMIN_SECRET)이 필요합니다" });
      out.admin.token = signAdminToken(process.env.ADMIN_SECRET, out.admin);
    }
    return res.status(200).json(out);
  } catch (e) {
    console.error("[요청오류]", action, e?.message);
    const msg = e instanceof UserError ? e.message : "서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.";
    return res.status(200).json({ ok: false, error: msg });
  }
}
