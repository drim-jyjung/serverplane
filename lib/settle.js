// 정산 · 경고 · 회원 관리 · 주간현황 · 자동 실행
// (Apps Script plane_api_v2.gs 의 같은 이름 함수들을 DB로 옮긴 것)
// 지켜야 할 규칙:
//  - 잠금(locked) 상태는 정산·경고로 절대 warned 로 낮추지 않는다 (inactive 도 그대로 둔다)
//  - 필참 = 서로 다른 날 착륙 2일, 일반 티켓만, 6번 프리셋(무한공유) 제외
//  - 경고는 다음 날 10:00 에 만료되며 만료되면 잠금 (autoLockExpired)
import { randomUUID } from "node:crypto";
import { UserError, kstDate, kstStr, addDaysStr, weekRange, weekKeyOfDate, weekDatesOfKey, weekdayOf } from "./core.js";
import { kstTime, createPresetRoom, PRESETS } from "./admin.js";

const nextDayAt10 = (d) => kstTime(`${addDaysStr(kstDate(d), 1)} 10:00`);

async function addLog(tx, type, roomId, roomDate, roomNum, mid, nick, insta, detail) {
  await tx`
    insert into logs (log_id, log_type, log_date, room_id, room_date, room_number, member_id, nickname, insta_id, detail, created_at)
    values (${randomUUID()}, ${type}, ${roomDate || kstDate()}, ${roomId || null}, ${roomDate || null}, ${roomNum ?? null},
            ${mid || null}, ${nick || null}, ${insta || null}, ${detail || ""}, now())`;
}

// 경고 부여 + 멤버 상태/횟수 반영 (잠금·비활성은 상태 유지, 횟수만 +1)
async function giveWarning(tx, m, { reason, expires, roomId }) {
  await tx`
    insert into warnings (warn_id, member_id, nickname, insta_id, reason, warned_at, expires_at, status, room_id)
    values (${randomUUID()}, ${m.member_id}, ${m.nickname}, ${m.insta_id}, ${reason}, now(), ${expires}, 'active', ${roomId || null})`;
  await tx`
    update members set
      status = case when status in ('locked', 'inactive') then status else 'warned' end,
      warning_count = coalesce(warning_count, 0) + 1
    where member_id = ${m.member_id}`;
}

// ───────── 일간 정산: 착륙 마감된 방의 미착륙자에게 경고 ─────────
export async function runDailySettle(sql, now = new Date()) {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('plane-settle'))`; // 정산이 동시에 두 번 돌지 않게
    const today = kstDate(now), yesterday = addDaysStr(today, -1);
    const rooms = await tx`
      select *, room_date::text as rd from rooms
      where room_date in (${today}::date, ${yesterday}::date) and land_end <= ${now} and status <> 'closed'
      order by room_date, room_number`;
    const warned = [], skipped = [];
    const exp = nextDayAt10(now);
    for (const r of rooms) {
      if (Number(r.preset_num) === 6) {
        await tx`update rooms set status = 'closed' where room_id = ${r.room_id}`;
        await addLog(tx, "daily_settle_skip", r.room_id, r.rd, r.room_number, "", "", "", "무한공유 룸 — 경고 없이 closed");
        continue;
      }
      const ps = await tx`select * from participations where room_id = ${r.room_id} order by ticket_at`;
      const active = new Set((await tx`select member_id from warnings where status = 'active' and room_id = ${r.room_id}`).map((w) => w.member_id));
      const roomWarned = []; let landed = 0;
      for (const p of ps) {
        if (p.status === "landed") { landed++; continue; }
        if (active.has(p.member_id)) { skipped.push(p.nickname); continue; }
        const [m] = await tx`select member_id, nickname, insta_id from members where member_id = ${p.member_id}`;
        await giveWarning(tx, m || { member_id: p.member_id, nickname: p.nickname, insta_id: p.insta_id }, {
          reason: `착륙 미완료 — ${r.rd} #${r.room_number}`, expires: exp, roomId: r.room_id,
        });
        active.add(p.member_id);
        warned.push(p.nickname); roomWarned.push(p.nickname);
        await addLog(tx, "daily_warn", r.room_id, r.rd, r.room_number, p.member_id, p.nickname, p.insta_id, "미착륙 경고 부여");
      }
      await addLog(tx, "daily_settle", r.room_id, r.rd, r.room_number, "", "", "",
        `총 ${ps.length}명 | 착륙 ${landed}명 | 경고 ${roomWarned.length}명${roomWarned.length ? " | 대상: " + roomWarned.join(",") : ""}`);
      await tx`update rooms set status = 'closed' where room_id = ${r.room_id}`;
    }
    return { ok: true, warned: warned.length, warned_list: warned, skipped: skipped.length };
  });
}

// ───────── 주간 정산: 주 2일 미달 경고 + 우수/명예 티켓 초기화 + 경고 만료 이월 ─────────
export async function runWeeklySettle(sql, b) {
  if (!b.admin_id) return { ok: false, error: "관리자 권한 필요" };
  const refDate = b.ref_date ? new Date(`${b.ref_date}T12:00:00+09:00`) : new Date();
  if (isNaN(refDate.getTime())) return { ok: false, error: "날짜 형식이 올바르지 않습니다" };
  const wr = weekRange(refDate);
  const wk = weekKeyOfDate(kstDate(refDate));
  const tag = `주간 정산 경고 — ${wk}`;
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('plane-settle'))`;
    const ms = await tx`
      select m.member_id, m.nickname, m.insta_id, m.status, m.excellent_count, m.honorary_count,
             count(distinct case when p.status = 'landed' then p.room_date end)::int as lc
      from members m
      left join participations p on p.member_id = m.member_id
        and coalesce(p.ticket_type, 'normal') not in ('excellent', 'honorary', 'staff')
        and coalesce(p.preset_num, 0) <> 6
        and p.ticket_at >= ${wr.start} and p.ticket_at <= ${wr.end}
      where m.status <> 'inactive' and coalesce(btrim(m.member_id), '') <> ''
      group by m.member_id`;
    const already = new Set((await tx`select member_id from warnings where status = 'active' and position(${tag} in coalesce(reason, '')) > 0`).map((w) => w.member_id));
    const exp = nextDayAt10(wr.end);
    const warned = [], skippedAlready = [];
    let resetE = 0, resetH = 0;
    for (const m of ms) {
      if (m.lc < 2) {
        if (already.has(m.member_id)) skippedAlready.push(m.nickname);
        else { await giveWarning(tx, m, { reason: tag, expires: exp, roomId: null }); warned.push(m.nickname); }
      }
      const ec = Number(m.excellent_count) || 0, hc = Number(m.honorary_count) || 0;
      if (ec > 0) { await tx`update members set excellent_count = 0, excellent_granted_at = null where member_id = ${m.member_id}`; resetE++; }
      if (hc > 0) { await tx`update members set honorary_count = 0, honorary_granted_at = null where member_id = ${m.member_id}`; resetH++; }
    }
    const carry = await tx`update warnings set expires_at = ${exp} where status = 'active'`;
    return {
      ok: true, week_key: wk, total: ms.length, passed: ms.length - warned.length,
      warned: warned.length, warned_list: warned, already_warned: skippedAlready.length, already_warned_list: skippedAlready,
      reset_excellent: resetE, reset_honorary: resetH, carry_over_warns: carry.count,
    };
  });
}

// ───────── 경고 만료 → 잠금 (매시간) ─────────
export async function autoLockExpired(sql) {
  return sql.begin(async (tx) => {
    const ex = await tx`update warnings set status = 'expired' where status = 'active' and expires_at is not null and expires_at <= now() returning member_id`;
    const ids = [...new Set(ex.map((w) => w.member_id))];
    let locked = 0;
    if (ids.length) {
      const r = await tx`update members set status = 'locked', locked_at = now()
                         where member_id in ${tx(ids)} and status not in ('locked', 'inactive')`;
      locked = r.count;
    }
    return { ok: true, expired_warnings: ex.length, locked };
  });
}

// ───────── 매일 아침 작업: 일간 정산 → (월요일이면) 주간 정산 → 오늘 방 자동 생성 ─────────
// 순서는 바꾸면 안 됨 (정산이 끝난 뒤에 새 방이 만들어져야 함)
export async function autoDailyJob(sql, now = new Date()) {
  const out = { ok: true };
  try { out.daily = await runDailySettle(sql, now); } catch (e) { out.daily = { ok: false, error: e.message }; console.error("일간 정산 실패", e.message); }
  const today = kstDate(now);
  if (weekdayOf(today) === 1) {
    try { out.weekly = await runWeeklySettle(sql, { admin_id: "auto", ref_date: addDaysStr(today, -1) }); }
    catch (e) { out.weekly = { ok: false, error: e.message }; console.error("주간 정산 실패", e.message); }
  }
  let created = 0, skipped = 0; const failed = [];
  for (const p of PRESETS) {
    try {
      const r = await createPresetRoom(sql, p.num, today, "auto");
      if (r.ok) created++; else if (String(r.error).includes("이미")) skipped++; else failed.push(`${p.num}번: ${r.error}`);
    } catch (e) { failed.push(`${p.num}번: ${e.message}`); }
  }
  out.presets = { created, skipped, failed };
  return out;
}

// ───────── 주간현황 표: 구글 시트 대신 참여 기록에서 바로 계산 ─────────
// 칸 표시: ✓ 착륙 · ⭐ 우수 · 🏅 명예 · 🎖 운영진 · ⚠ 미착륙 경고 · ● 탑승만(아직 착륙 전)
// 주간합계 = ✓ 와 ⚠ 칸의 개수 (기존 시트와 같은 규칙)
export async function getWeekSheet(sql, b) {
  const wk = b.week_key || weekKeyOfDate(kstDate());
  const w = weekDatesOfKey(wk);
  if (!w) return { ok: true, week_key: wk, headers: [], rows: [] };
  const rooms = await sql`
    select room_id, room_date::text as rd, room_number from rooms
    where room_date >= ${w.mon}::date and room_date <= ${w.sun}::date order by room_date, room_number`;
  if (!rooms.length) return { ok: true, week_key: wk, headers: [], rows: [] };
  const ids = rooms.map((r) => r.room_id);
  const ps = await sql`select * from participations where room_id in ${sql(ids)}`;
  const ws = await sql`select member_id, room_id from warnings where room_id in ${sql(ids)}`;
  const warnSet = new Set(ws.map((x) => `${x.member_id}|${x.room_id}`));
  const partMembers = [...new Set(ps.map((p) => p.member_id))];
  const members = await sql`
    select member_id, nickname, insta_id from members
    where coalesce(btrim(member_id), '') <> '' and (status <> 'inactive' or member_id in ${sql(partMembers.length ? partMembers : [""])})
    order by registered_at nulls last, nickname`;
  const cell = new Map(); // member|room -> 표시
  const landedBy = new Map();
  for (const p of ps) {
    const key = `${p.member_id}|${p.room_id}`;
    if (p.status === "landed") {
      const prev = landedBy.get(key);
      if (!prev || new Date(p.landed_at) >= new Date(prev.landed_at)) landedBy.set(key, p);
    } else if (!cell.has(key)) cell.set(key, warnSet.has(key) ? "⚠" : "●");
  }
  for (const [key, p] of landedBy) {
    const t = p.ticket_type || "normal";
    cell.set(key, t === "excellent" ? "⭐" : t === "honorary" ? "🏅" : t === "staff" ? "🎖" : "✓");
  }
  const headers = ["nickname", "insta_id", ...rooms.map((r) => `${+r.rd.slice(5, 7)}/${+r.rd.slice(8, 10)}_룸${r.room_number}`), "주간합계"];
  const rows = members.map((m) => {
    const marks = rooms.map((r) => cell.get(`${m.member_id}|${r.room_id}`) || "");
    const sum = marks.filter((x) => x === "✓" || x === "⚠").length;
    return [m.nickname, m.insta_id, ...marks, sum];
  });
  return { ok: true, week_key: wk, headers, rows };
}

export function makeSettleActions(sql, env = {}) {
  const A = {};
  const guard = (fn) => async (b) => {
    try { return await fn(b || {}); }
    catch (e) {
      if (e instanceof UserError) return { ok: false, error: e.message };
      throw e;
    }
  };
  const needSecret = (b) => !env.cronSecret || b.secret !== env.cronSecret;

  A.run_daily = guard(async () => runDailySettle(sql));
  A.run_weekly = guard(async (b) => runWeeklySettle(sql, b));
  A.get_week_sheet = guard(async (b) => getWeekSheet(sql, b));
  // 주간현황은 이제 DB에서 바로 계산하므로 "초기화"할 시트가 없음 (기존 화면 버튼 호환용)
  A.init_week_sheet = guard(async (b) => ({ ok: true, week_key: b.week_key || weekKeyOfDate(kstDate()), message: "주간현황은 참여 기록에서 바로 계산되므로 초기화가 필요 없습니다" }));

  // 자동 실행 (구글 Apps Script 타이머가 비밀번호(CRON_SECRET)와 함께 호출)
  A.auto_lock_expired = guard(async (b) => (needSecret(b) ? { ok: false, error: "forbidden" } : autoLockExpired(sql)));
  A.auto_daily_job = guard(async (b) => (needSecret(b) ? { ok: false, error: "forbidden" } : autoDailyJob(sql)));

  // ───────── 경고 ─────────
  A.manual_warn = guard(async (b) => {
    if (!b.member_id) return { ok: false, error: "member_id 누락" };
    return sql.begin(async (tx) => {
      const [m] = await tx`select member_id, nickname, insta_id from members where member_id = ${b.member_id} for update`;
      if (!m) return { ok: false, error: "멤버를 찾을 수 없습니다" };
      if (b.room_id) {
        const [d] = await tx`select 1 as x from warnings where member_id = ${b.member_id} and room_id = ${b.room_id} and status = 'active'`;
        if (d) return { ok: false, duplicate: true, error: "이미 이 방으로 경고를 받았습니다" };
      }
      await giveWarning(tx, m, { reason: b.reason || "관리자 수동 경고", expires: nextDayAt10(new Date()), roomId: b.room_id || null });
      return { ok: true, message: "경고 부여 완료" };
    });
  });

  A.resolve_warning = guard(async (b) => {
    if (!b.warn_id) return { ok: false, error: "필수값 누락" };
    return sql.begin(async (tx) => {
      const [w] = await tx`select member_id from warnings where warn_id = ${b.warn_id} for update`;
      if (!w) return { ok: false, error: "경고 내역을 찾을 수 없습니다" };
      await tx`update warnings set status = 'resolved' where warn_id = ${b.warn_id}`;
      const [rem] = await tx`select count(*)::int as c from warnings where member_id = ${w.member_id} and status = 'active'`;
      if (rem.c === 0)
        await tx`update members set status = 'active', locked_at = null, lock_expires = null,
                   warning_count = greatest(0, coalesce(nullif(warning_count, 0), 1) - 1)
                 where member_id = ${w.member_id}`;
      return { ok: true, message: "경고 해제 완료" };
    });
  });

  A.adjust_warn = guard(async (b) => {
    const delta = Number(b.delta);
    if (!b.member_id) return { ok: false, error: "member_id 누락" };
    if (!Number.isFinite(delta)) return { ok: false, error: "변경값이 올바르지 않습니다" };
    return sql.begin(async (tx) => {
      const [m] = await tx`select * from members where member_id = ${b.member_id} for update`;
      if (!m) return { ok: false, error: "멤버를 찾을 수 없습니다" };
      const cur = Number(m.warning_count) || 0;
      const nv = Math.max(0, cur + delta);
      let remActive;
      if (delta < 0) {
        const actives = await tx`select warn_id from warnings where member_id = ${b.member_id} and status = 'active' order by warned_at`;
        if (actives.length) await tx`update warnings set status = 'resolved' where warn_id = ${actives[0].warn_id}`;
        remActive = actives.length > 1;
      } else remActive = nv > 0;
      const status = nv <= 0 && !remActive ? "active" : "warned";
      if (status === "active") await tx`update members set warning_count = ${nv}, status = 'active', locked_at = null, lock_expires = null where member_id = ${b.member_id}`;
      else await tx`update members set warning_count = ${nv}, status = 'warned' where member_id = ${b.member_id}`;
      return { ok: true, message: `경고 횟수 변경: ${cur} → ${nv}`, member: { member_id: b.member_id, warning_count: nv, status, is_warned: remActive } };
    });
  });

  // ───────── 티켓 / 잠금 / 회원 ─────────
  const adjustTicket = (col, label) => guard(async (b) => {
    if (!b.member_id) return { ok: false, error: "필수값 누락" };
    const delta = Number(b.delta);
    if (!Number.isFinite(delta)) return { ok: false, error: "변경값이 올바르지 않습니다" };
    return sql.begin(async (tx) => {
      const [m] = await tx`select * from members where member_id = ${b.member_id} for update`;
      if (!m) return { ok: false, error: "멤버를 찾을 수 없습니다" };
      const cur = Number(m[`${col}_count`]) || 0, nv = Math.max(0, cur + delta);
      const today = kstDate();
      if (col === "excellent") {
        if (delta > 0) await tx`update members set excellent_count = ${nv}, excellent_granted_at = ${today}::date where member_id = ${b.member_id}`;
        else await tx`update members set excellent_count = ${nv} where member_id = ${b.member_id}`;
      } else {
        if (delta > 0) await tx`update members set honorary_count = ${nv}, honorary_granted_at = ${today}::date where member_id = ${b.member_id}`;
        else await tx`update members set honorary_count = ${nv} where member_id = ${b.member_id}`;
      }
      return { ok: true, message: `${label} 티켓 변경: ${cur} → ${nv}`, member: { member_id: b.member_id, [`${col}_count`]: nv } };
    });
  });
  A.adjust_excellent = adjustTicket("excellent", "우수");
  A.adjust_honorary = adjustTicket("honorary", "명예");

  A.toggle_lock = guard(async (b) => {
    const action = b.lock_action || b.action;
    if (!b.member_id || !action) return { ok: false, error: "필수값 누락" };
    if (!["lock", "unlock"].includes(action)) return { ok: false, error: "잠금 동작이 올바르지 않습니다" };
    const r = action === "lock"
      ? await sql`update members set status = 'locked', locked_at = now() where member_id = ${b.member_id} returning member_id`
      : await sql`update members set status = 'active', locked_at = null, lock_expires = null where member_id = ${b.member_id} returning member_id`;
    if (!r.length) return { ok: false, error: "멤버를 찾을 수 없습니다" };
    return { ok: true, message: action === "lock" ? "잠금 완료" : "잠금 해제 완료" };
  });

  A.add_member = guard(async (b) => {
    const nick = String(b.nickname ?? "").trim(), insta = String(b.insta_id ?? "").trim();
    if (!nick || !insta) return { ok: false, error: "닉네임과 인스타 아이디는 필수입니다" };
    return sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('plane-add-member'))`;
      const [d] = await tx`select 1 as x from members where nickname = ${nick}`;
      if (d) return { ok: false, error: "이미 존재하는 닉네임입니다" };
      await tx`insert into members (member_id, nickname, insta_id, status, warning_count, excellent_count, honorary_count, registered_at, memo)
               values (${randomUUID()}, ${nick}, ${insta}, 'active', 0, 0, 0, now(), ${b.memo || ""})`;
      return { ok: true, message: "멤버 등록 완료" };
    });
  });

  A.update_member = guard(async (b) => {
    if (!b.member_id) return { ok: false, error: "필수값 누락" };
    const patch = {};
    for (const k of ["nickname", "insta_id", "memo", "status"]) if (b[k] !== undefined) patch[k] = b[k];
    if (patch.status !== undefined && !["active", "warned", "locked", "inactive"].includes(patch.status))
      return { ok: false, error: "상태 값이 올바르지 않습니다" };
    if (!Object.keys(patch).length) return { ok: true, message: "수정 완료" };
    const r = await sql`update members set ${sql(patch)} where member_id = ${b.member_id} returning member_id`;
    if (!r.length) return { ok: false, error: "멤버를 찾을 수 없습니다" };
    return { ok: true, message: "수정 완료" };
  });

  return A;
}
