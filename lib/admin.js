// 관리자 기능 (Apps Script plane_api_v2.gs 의 admin 화면용 기능을 DB로 옮긴 것)
import { randomUUID } from "node:crypto";
import {
  UserError, fail, str, trim, kstDate, kstStr, kstParts, fmtDisp, addDaysStr,
  weekRange, weekKeyOfDate, weekDatesOfKey,
} from "./core.js";

// 방 프리셋 (plane_api_v2.gs 의 PRESETS 와 동일 — 4번은 20명)
export const PRESETS = [
  { num: 1, label: "[좋아요+리포스트] 20명", items: "좋아요,리포스트", max: 20, ts: "12:00", te: "15:00", ls: "15:01", le: "18:00", lsNextDay: false, leNextDay: false },
  { num: 2, label: "[좋아요+저장+공유] 20명", items: "좋아요,저장,공유하기", max: 20, ts: "12:00", te: "15:00", ls: "15:01", le: "18:00", lsNextDay: false, leNextDay: false },
  { num: 3, label: "[좋아요] 무제한", items: "좋아요", max: 9999, ts: "11:00", te: "22:00", ls: "22:01", le: "10:00", lsNextDay: false, leNextDay: true },
  { num: 4, label: "[좋+댓] 20명", items: "좋아요,댓글", max: 20, ts: "11:00", te: "22:00", ls: "22:01", le: "10:00", lsNextDay: false, leNextDay: true },
  { num: 5, label: "[좋+댓] 20명", items: "좋아요,댓글", max: 20, ts: "19:00", te: "22:00", ls: "22:01", le: "10:00", lsNextDay: false, leNextDay: true },
  { num: 6, label: "[무한공유] 무제한", items: "공유하기", max: 9999, ts: "11:00", te: "20:00", ls: "20:01", le: "23:00", lsNextDay: false, leNextDay: false },
];

// "2026-10-19 11:00" (한국시간) → Date. 형식이 틀리면 사용자 오류
export function kstTime(s) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/.exec(String(s ?? "").trim());
  if (!m) throw new UserError("시간 형식이 올바르지 않습니다");
  const d = new Date(`${m[1]}T${m[2].padStart(2, "0")}:${m[3]}:00+09:00`);
  if (isNaN(d.getTime())) throw new UserError("시간 형식이 올바르지 않습니다");
  return d;
}
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ""));

// 프리셋으로 방 1개 만들기 (자동생성에서도 재사용). 같은 날짜 동시 생성은 잠금으로 순서대로 처리
export async function createPresetRoom(sql, pn, rd, createdBy) {
  if (!pn || !rd) return { ok: false, error: "필수값 누락" };
  const p = PRESETS.find((x) => x.num === pn);
  if (!p) return { ok: false, error: "존재하지 않는 프리셋" };
  if (!isDate(rd)) return { ok: false, error: "날짜 형식이 올바르지 않습니다" };
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"rooms:" + rd}))`;
    const [dup] = await tx`select 1 as x from rooms where room_date = ${rd} and preset_num = ${pn}`;
    if (dup) return { ok: false, error: `오늘 이미 같은 프리셋(${pn}번)이 있습니다` };
    const [mx] = await tx`select coalesce(max(room_number), 0)::int as m from rooms where room_date = ${rd}`;
    const rn = mx.m + 1;
    const lsDate = p.lsNextDay ? addDaysStr(rd, 1) : rd;
    const leDate = p.leNextDay ? addDaysStr(rd, 1) : rd;
    const rid = randomUUID();
    await tx`
      insert into rooms (room_id, room_date, room_number, items, max_members, ticket_start, ticket_end,
                         land_start, land_end, status, created_by, created_at, memo, preset_num)
      values (${rid}, ${rd}, ${rn}, ${p.items}, ${p.max}, ${kstTime(`${rd} ${p.ts}`)}, ${kstTime(`${rd} ${p.te}`)},
              ${kstTime(`${lsDate} ${p.ls}`)}, ${kstTime(`${leDate} ${p.le}`)}, 'open', ${createdBy || "admin"},
              now(), ${p.label}, ${pn})`;
    return { ok: true, room_id: rid, room_number: rn, preset: p.label };
  });
}

const roomOut = (r) => ({
  room_id: r.room_id, room_date: r.rd, room_number: r.room_number, items: r.items,
  max_members: r.max_members, memo: r.memo || "", status: r.status, preset_num: r.preset_num || "",
});
const partOut = (p) => ({
  part_id: p.part_id, member_id: p.member_id, nickname: p.nickname, insta_id: p.insta_id,
  post_url: p.post_url || "", ticket_at: fmtDisp(p.ticket_at), landed_at: fmtDisp(p.landed_at),
  status: p.status, ticket_type: p.ticket_type || "normal",
});

export function makeAdminActions(sql) {
  const A = {};
  const guard = (fn) => async (b) => {
    try { return await fn(b || {}); }
    catch (e) {
      if (e instanceof UserError) return { ok: false, error: e.message };
      if (e?.code === "23505") return { ok: false, error: "같은 날짜에 같은 번호의 비행기가 이미 있습니다" };
      throw e;
    }
  };

  A.admin_login = guard(async (b) => {
    const nick = trim(b.nickname), insta = trim(b.insta_id);
    if (!nick || !insta) return { ok: false, error: "필수값 누락" };
    const [a] = await sql`
      select admin_id, nickname from admins
      where btrim(nickname) = ${nick} and btrim(insta_id) = ${insta} and status = 'active' limit 1`;
    if (!a) return { ok: false, error: "등록되지 않은 관리자 계정입니다" };
    return { ok: true, admin: { admin_id: a.admin_id, nickname: a.nickname } };
  });

  A.get_presets = async () => ({ ok: true, presets: PRESETS });

  A.get_all_rooms = guard(async (b) => {
    let from = null, to = null;
    if (b.room_date) { from = to = String(b.room_date); }
    else if (b.week_key) {
      const w = weekDatesOfKey(b.week_key);
      if (!w) return { ok: true, rooms: [] };
      from = w.mon; to = w.sun;
    }
    const rows = await sql`
      select r.*, r.room_date::text as rd,
             count(p.part_id)::int as total_joined,
             (count(p.part_id) filter (where coalesce(p.ticket_type,'normal') = 'normal'))::int as normal_joined
      from rooms r left join participations p on p.room_id = r.room_id
      where (${from}::date is null or r.room_date >= ${from}::date)
        and (${to}::date is null or r.room_date <= ${to}::date)
      group by r.room_id
      order by r.room_date desc, r.room_number asc`;
    return {
      ok: true,
      rooms: rows.map((r) => ({
        ...roomOut(r),
        ticket_start: kstStr(r.ticket_start), ticket_end: kstStr(r.ticket_end),
        land_start: kstStr(r.land_start), land_end: kstStr(r.land_end),
        ticket_start_fmt: fmtDisp(r.ticket_start), ticket_end_fmt: fmtDisp(r.ticket_end),
        land_start_fmt: fmtDisp(r.land_start), land_end_fmt: fmtDisp(r.land_end),
        joined: r.normal_joined, total_joined: r.total_joined,
        created_at: kstStr(r.created_at),
      })),
    };
  });

  A.get_room_details_batch = guard(async (b) => {
    const ids = Array.isArray(b.room_ids) ? b.room_ids.map(String) : [];
    if (!ids.length) return { ok: true, rooms: [] };
    const rooms = await sql`select *, room_date::text as rd from rooms where room_id in ${sql(ids)}`;
    const parts = await sql`select * from participations where room_id in ${sql(ids)} order by ticket_at`;
    const by = new Map();
    for (const p of parts) { if (!by.has(p.room_id)) by.set(p.room_id, []); by.get(p.room_id).push(p); }
    return {
      ok: true,
      rooms: rooms.map((r) => ({
        room: {
          ...roomOut(r),
          ticket_start_fmt: fmtDisp(r.ticket_start), ticket_end_fmt: fmtDisp(r.ticket_end),
          land_start_fmt: fmtDisp(r.land_start), land_end_fmt: fmtDisp(r.land_end),
        },
        participants: (by.get(r.room_id) || []).map(partOut),
      })),
    };
  });

  A.get_members = async () => {
    const ms = await sql`select *, excellent_granted_at::text as eg, honorary_granted_at::text as hg
                         from members where coalesce(btrim(member_id), '') <> '' order by registered_at nulls last, nickname`;
    return {
      ok: true,
      members: ms.map((m) => ({
        member_id: m.member_id, nickname: m.nickname, insta_id: m.insta_id, status: m.status, grade: m.grade,
        warning_count: m.warning_count || 0, excellent_count: Number(m.excellent_count) || 0,
        honorary_count: Number(m.honorary_count) || 0, last_login_at: kstStr(m.last_login_at), memo: m.memo || "",
      })),
    };
  };

  A.get_warnings = async () => {
    const ws = await sql`select * from warnings order by warned_at desc nulls last`;
    return {
      ok: true,
      warnings: ws.map((w) => ({
        warn_id: w.warn_id, member_id: w.member_id, nickname: w.nickname, insta_id: w.insta_id, reason: w.reason,
        warned_at: fmtDisp(w.warned_at), expires_at: fmtDisp(w.expires_at), status: w.status,
      })),
    };
  };

  A.get_parts = guard(async (b) => {
    const rows = b.member_id
      ? await sql`select *, room_date::text as rd from participations where member_id = ${String(b.member_id)} order by ticket_at desc nulls last`
      : await sql`select *, room_date::text as rd from participations order by ticket_at desc nulls last`;
    return {
      ok: true,
      parts: rows.map((r) => ({
        part_id: r.part_id, room_date: r.rd, room_number: r.room_number, member_id: r.member_id,
        nickname: r.nickname, insta_id: r.insta_id, post_url: r.post_url || "",
        ticket_at: fmtDisp(r.ticket_at), landed_at: fmtDisp(r.landed_at), link_at: fmtDisp(r.link_at),
        link_history: r.link_history || "", status: r.status, ticket_type: r.ticket_type || "normal",
      })),
    };
  });

  A.get_logs = guard(async (b) => {
    const rows = await sql`
      select *, log_date::text as ld, room_date::text as rd from logs
      where (${b.log_date ?? null}::date is null or log_date = ${b.log_date ?? null}::date)
        and (${b.log_type ?? null}::text is null or log_type = ${b.log_type ?? null})
      order by created_at desc nulls last`;
    return {
      ok: true,
      logs: rows.map((l) => ({
        log_id: l.log_id, log_type: l.log_type, log_date: l.ld, room_date: l.rd || "", room_number: l.room_number ?? "",
        nickname: l.nickname || "", insta_id: l.insta_id || "", detail: l.detail || "", created_at: kstStr(l.created_at),
      })),
    };
  });

  // 오늘(오전 11시 전에는 어제) 방별 현황 + 이번 주 멤버별 출석
  A.get_daily = async () => {
    const now = new Date();
    const today = kstDate(now);
    const baseDate = kstParts(now).h < 11 ? addDaysStr(today, -1) : today;
    const wr = weekRange(now);
    const rooms = await sql`select *, room_date::text as rd from rooms where room_date = ${baseDate}::date order by room_number`;
    const ids = rooms.map((r) => r.room_id);
    const parts = ids.length ? await sql`select * from participations where room_id in ${sql(ids)} order by ticket_at` : [];
    const warns = await sql`select member_id, room_id from warnings where status = 'active'`;
    const warnRoom = new Set(warns.filter((w) => w.room_id).map((w) => `${w.member_id}|${w.room_id}`));
    const warnMember = new Set(warns.map((w) => w.member_id));
    const by = new Map();
    for (const p of parts) { if (!by.has(p.room_id)) by.set(p.room_id, []); by.get(p.room_id).push(p); }

    const roomStats = rooms.map((r) => {
      const ps = by.get(r.room_id) || [];
      const landed = ps.filter((p) => p.status === "landed");
      const ticketed = ps.filter((p) => p.status !== "landed");
      const isLandClosed = !!(r.land_end && now >= r.land_end);
      return {
        room_id: r.room_id, room_date: r.rd, room_number: r.room_number, items: r.items, memo: r.memo || "",
        preset_num: r.preset_num || "",
        ticket_start_fmt: fmtDisp(r.ticket_start), ticket_end_fmt: fmtDisp(r.ticket_end),
        land_start_fmt: fmtDisp(r.land_start), land_end_fmt: fmtDisp(r.land_end),
        status: r.status, is_land_closed: isLandClosed, is_settled: r.status === "closed",
        total: ps.length, landed_count: landed.length, ticketed_count: ticketed.length,
        participants: ps.map((p) => ({
          member_id: p.member_id, nickname: p.nickname, insta_id: p.insta_id, post_url: p.post_url || "",
          status: p.status, ticket_type: p.ticket_type || "normal",
          ticket_at: fmtDisp(p.ticket_at), landed_at: fmtDisp(p.landed_at),
          already_warned: warnRoom.has(`${p.member_id}|${r.room_id}`),
        })),
        no_land_list: isLandClosed
          ? ticketed.map((p) => ({
              member_id: p.member_id, nickname: p.nickname, insta_id: p.insta_id, room_id: r.room_id,
              room_number: r.room_number, room_date: r.rd, already_warned: warnRoom.has(`${p.member_id}|${r.room_id}`),
            }))
          : [],
      };
    });
    const warnTargets = roomStats.filter((r) => r.is_land_closed).flatMap((r) => r.no_land_list);

    const ws = await sql`
      select m.member_id, m.nickname, m.insta_id, m.status, m.grade, m.warning_count,
             m.excellent_count, m.honorary_count,
             count(p.part_id)::int as pc,
             count(distinct case when p.status = 'landed' then p.room_date end)::int as lc
      from members m
      left join participations p on p.member_id = m.member_id
        and coalesce(p.ticket_type, 'normal') not in ('excellent', 'honorary', 'staff')
        and coalesce(p.preset_num, 0) <> 6
        and p.ticket_at >= ${wr.start} and p.ticket_at <= ${wr.end}
      where m.status <> 'inactive' and coalesce(btrim(m.member_id), '') <> ''
      group by m.member_id
      order by lc desc, m.nickname`;
    const weekStats = ws.map((m) => ({
      member_id: m.member_id, nickname: m.nickname, insta_id: m.insta_id, status: m.status, grade: m.grade,
      warning_count: m.warning_count, week_participate: m.pc, week_land: m.lc, is_pass: m.lc >= 2,
      is_warned: warnMember.has(m.member_id),
      excellent_count: Number(m.excellent_count) || 0, honorary_count: Number(m.honorary_count) || 0,
    }));
    return {
      ok: true, date: baseDate,
      week_range: `${fmtDisp(wr.start)} ~ ${fmtDisp(wr.end)}`,
      week_key: weekKeyOfDate(today),
      room_stats: roomStats, warn_targets: warnTargets, week_stats: weekStats,
    };
  };

  // 지난주 주간 정산 결과 (월요일 아침 공지용)
  // 경고 기록(사유 "주간 정산 경고 — YYYY_Wnn")에서 바로 만들기 때문에 이미 지난 정산도 조회됨.
  A.get_last_week_result = async () => {
    const now = new Date();
    const ref = new Date(now.getTime() - 7 * 86400000);
    const wr = weekRange(ref);
    const wk = weekKeyOfDate(kstDate(ref));
    const tag = `주간 정산 경고 — ${wk}`;
    const ws = await sql`
      select member_id, min(warned_at) as wa from warnings
      where position(${tag} in coalesce(reason, '')) > 0 group by member_id`;
    const [lg] = await sql`
      select created_at from logs where log_type = 'weekly_settle' and left(detail, ${wk.length}) = ${wk}
      order by created_at desc limit 1`;
    const ids = ws.map((w) => w.member_id);
    const rows = ids.length ? await sql`
      select m.member_id, m.nickname, m.insta_id, m.status, m.locked_at,
             count(p.part_id)::int as pc,
             count(distinct case when p.status = 'landed' then p.room_date end)::int as lc
      from members m
      left join participations p on p.member_id = m.member_id
        and coalesce(p.ticket_type, 'normal') not in ('excellent', 'honorary', 'staff')
        and coalesce(p.preset_num, 0) <> 6
        and p.ticket_at >= ${wr.start} and p.ticket_at <= ${wr.end}
      where m.member_id in ${sql(ids)}
      group by m.member_id` : [];
    // 이미 잠겨 있던 계정은 제외: 경고가 부여되기 "전에" 잠긴 사람(잠금 시각이 경고 시각보다 앞서거나 없음).
    // 이번 정산 때문에 잠긴 사람(잠금 시각이 경고 시각 이후)은 공지 대상이라 남긴다.
    const warnAt = new Map(ws.map((w) => [w.member_id, w.wa]));
    const wasLocked = (m) => m.status === "locked" && (!m.locked_at || (warnAt.get(m.member_id) && m.locked_at < warnAt.get(m.member_id)));
    const excludedLocked = rows.filter(wasLocked).length;
    const list = rows
      .filter((m) => !wasLocked(m))
      .map((m) => ({ member_id: m.member_id, nickname: m.nickname, insta_id: m.insta_id, status: m.status, week_participate: m.pc, week_land: m.lc }))
      .sort((a, b) => b.week_land - a.week_land || b.week_participate - a.week_participate || String(a.nickname).localeCompare(String(b.nickname), "ko"));
    // 풀참(주 7회 전부 착륙) 명단: 지난주 7일 모두 착륙한 사람 (필참 집계와 같은 기준: 일반 티켓, 6번 방 제외)
    const fullRows = await sql`
      select m.member_id, m.nickname, m.insta_id, m.status,
             count(distinct p.room_date)::int as lc
      from participations p
      join members m on m.member_id = p.member_id
      where p.status = 'landed'
        and coalesce(p.ticket_type, 'normal') not in ('excellent', 'honorary', 'staff')
        and coalesce(p.preset_num, 0) <> 6
        and p.ticket_at >= ${wr.start} and p.ticket_at <= ${wr.end}
      group by m.member_id, m.nickname, m.insta_id, m.status
      having count(distinct p.room_date) >= 7
      order by m.nickname`;
    const fullList = fullRows
      .map((m) => ({ member_id: m.member_id, nickname: m.nickname, insta_id: m.insta_id, status: m.status, week_land: m.lc }))
      .sort((a, b) => String(a.nickname).localeCompare(String(b.nickname), "ko"));
    const firstWarn = ws.reduce((mn, w) => (w.wa && (!mn || w.wa < mn) ? w.wa : mn), null);
    return {
      ok: true, week_key: wk,
      week_range: `${fmtDisp(wr.start)} ~ ${fmtDisp(wr.end)}`,
      settled: !!lg || list.length > 0,
      settled_at: lg ? fmtDisp(lg.created_at) : (firstWarn ? fmtDisp(firstWarn) : ""),
      warned_count: list.length, excluded_locked: excludedLocked, list,
      full_count: fullList.length, full_list: fullList,
    };
  };

  // ───────── 방 관리 ─────────
  A.create_room = guard(async (b) => {
    if (!b.room_date || !b.items || !b.ticket_start || !b.ticket_end || !b.land_start || !b.land_end)
      return { ok: false, error: "필수값 누락" };
    if (!isDate(b.room_date)) return { ok: false, error: "날짜 형식이 올바르지 않습니다" };
    const times = [kstTime(b.ticket_start), kstTime(b.ticket_end), kstTime(b.land_start), kstTime(b.land_end)];
    const rn = Number(b.room_number);
    if (!rn) return { ok: false, error: "필수값 누락" };
    const rid = randomUUID();
    try {
      await sql`
        insert into rooms (room_id, room_date, room_number, items, max_members, ticket_start, ticket_end,
                           land_start, land_end, status, created_by, created_at, memo, preset_num)
        values (${rid}, ${b.room_date}, ${rn}, ${b.items}, ${Number(b.max_members) || 20},
                ${times[0]}, ${times[1]}, ${times[2]}, ${times[3]}, 'open', ${b.admin_id || "admin"}, now(),
                ${b.memo || ""}, null)`;
    } catch (e) {
      if (e?.code === "23505") return { ok: false, error: "같은 날짜에 같은 번호의 비행기가 이미 있습니다" };
      throw e;
    }
    return { ok: true, room_id: rid };
  });

  A.create_preset = guard(async (b) => createPresetRoom(sql, Number(b.preset_num), b.room_date, b.admin_id));

  A.update_room = guard(async (b) => {
    if (!b.room_id) return { ok: false, error: "필수값 누락" };
    const patch = {};
    for (const k of ["items", "memo", "status"]) if (b[k] !== undefined) patch[k] = b[k];
    if (b.max_members !== undefined) patch.max_members = Number(b.max_members) || 20;
    for (const k of ["ticket_start", "ticket_end", "land_start", "land_end"]) if (b[k] !== undefined) patch[k] = kstTime(b[k]);
    if (b.status !== undefined && !["open", "closed"].includes(b.status)) return { ok: false, error: "상태 값이 올바르지 않습니다" };
    if (!Object.keys(patch).length) return { ok: true, message: "수정 완료" };
    const r = await sql`update rooms set ${sql(patch)} where room_id = ${b.room_id} returning room_id`;
    if (!r.length) return { ok: false, error: "비행기를 찾을 수 없습니다" };
    return { ok: true, message: "수정 완료" };
  });

  A.delete_room = guard(async (b) => {
    if (!b.room_id) return { ok: false, error: "필수값 누락" };
    return sql.begin(async (tx) => {
      const [r] = await tx`select room_id from rooms where room_id = ${b.room_id} for update`;
      if (!r) return { ok: false, error: "비행기를 찾을 수 없습니다" };
      const [c] = await tx`select count(*)::int as c from participations where room_id = ${b.room_id}`;
      if (c.c > 0) return { ok: false, error: "참여자가 있는 비행기는 삭제할 수 없습니다" };
      await tx`delete from rooms where room_id = ${b.room_id}`;
      return { ok: true, message: "삭제 완료" };
    });
  });

  // ───────── 참여 기록 관리 ─────────
  A.admin_update_link = guard(async (b) => {
    if (!b.room_id || !b.member_id || !b.post_url) return { ok: false, error: "필수값 누락" };
    if (String(b.post_url).indexOf("http") !== 0) return { ok: false, error: "올바른 URL을 입력하세요" };
    return sql.begin(async (tx) => {
      const [p] = await tx`select * from participations where room_id = ${b.room_id} and member_id = ${b.member_id}
                           order by ticket_at limit 1 for update`;
      if (!p) return { ok: false, error: "참여 기록을 찾을 수 없습니다" };
      const entry = `${kstStr(new Date())} | [관리자수정] ${p.post_url || ""} → ${b.post_url}`;
      const hist = p.link_history ? `${p.link_history}\n${entry}` : entry;
      await tx`update participations set post_url = ${b.post_url}, link_at = now(), link_history = ${hist} where part_id = ${p.part_id}`;
      return { ok: true, message: "링크 수정 완료" };
    });
  });

  A.admin_land = guard(async (b) => {
    if (!b.room_id || !b.member_id) return { ok: false, error: "필수값 누락" };
    return sql.begin(async (tx) => {
      const ps = await tx`select * from participations where room_id = ${b.room_id} and member_id = ${b.member_id}
                          order by ticket_at for update`;
      if (!ps.length) return { ok: false, error: "참여 기록을 찾을 수 없습니다" };
      const p = ps.find((x) => x.status !== "landed");
      if (!p) return { ok: false, error: "이미 착륙 완료된 참여자입니다" };
      await tx`update participations set status = 'landed', landed_at = now() where part_id = ${p.part_id}`;
      return { ok: true, message: `${p.nickname} 착륙 처리 완료` };
    });
  });

  A.admin_delete_part = guard(async (b) => {
    if (!b.room_id || !b.member_id) return { ok: false, error: "필수값 누락" };
    return sql.begin(async (tx) => {
      const [p] = await tx`select * from participations where room_id = ${b.room_id} and member_id = ${b.member_id}
                           order by ticket_at limit 1 for update`;
      if (!p) return { ok: false, error: "참여 기록을 찾을 수 없습니다" };
      await tx`delete from participations where part_id = ${p.part_id}`;
      return { ok: true, message: `${p.nickname} 참여 기록 삭제 완료` };
    });
  });

  return A;
}
