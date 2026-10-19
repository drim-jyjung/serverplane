// 비행기방 서버 핵심 로직 (Apps Script plane_api_v2.gs 의 크루 화면용 기능을 DB로 옮긴 것)
// 규칙: 날짜는 항상 한국시간(KST). 같은 방에 같은 사람이 같은 유형으로 두 번 탑승 금지(DB 색인이 최종 방어).
import { randomUUID } from "node:crypto";

export const APP_VERSION = "vercel-2026-10-14";

// 사용자에게 그대로 보여줄 수 있는 오류 (트랜잭션 되돌림용)
class UserError extends Error {}
const fail = (msg) => { throw new UserError(msg); };

// ───────── 한국시간 도우미 ─────────
const pad = (n) => String(n).padStart(2, "0");
function kstParts(d) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(d);
  const o = {};
  for (const p of f) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute };
}
export function kstDate(d = new Date()) {
  const p = kstParts(d);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}
function kstStr(v) { // "2026-10-14 10:05" 형태
  if (!v) return "";
  const p = kstParts(new Date(v));
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
}
function fmtDisp(v) { // "10/14 10:05"
  if (!v) return "-";
  const p = kstParts(new Date(v));
  return `${p.mo}/${p.d} ${pad(p.h)}:${pad(p.mi)}`;
}
function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
// 이번 주 = 월요일 10:00 ~ 일요일 22:00 (KST)  — Apps Script weekRange 와 동일
export function weekRange(now = new Date()) {
  const kst = kstDate(now);
  const day = weekdayOf(kst);
  const mon = addDaysStr(kst, day === 0 ? -6 : 1 - day);
  const sun = addDaysStr(mon, 6);
  return { start: new Date(`${mon}T10:00:00+09:00`), end: new Date(`${sun}T22:00:00+09:00`) };
}

const str = (v) => (v === null || v === undefined ? "" : String(v));
const trim = (v) => String(v ?? "").trim();

// ───────── 주간 출석 현황 (필참 = 서로 다른 날 착륙 2일, 일반 티켓만, 6번 프리셋 제외) ─────────
async function weekStatus(sql, memberId, now = new Date()) {
  const wr = weekRange(now);
  const today = kstDate(now);
  const rows = await sql`
    select room_date::text as rd, status
    from participations
    where member_id = ${memberId}
      and coalesce(ticket_type,'normal') = 'normal'
      and coalesce(preset_num, 0) <> 6
      and ticket_at >= ${wr.start} and ticket_at <= ${wr.end}`;
  const landed = new Set();
  let todayParticipated = false;
  for (const r of rows) {
    if (r.rd === today) todayParticipated = true;
    if (r.status === "landed") landed.add(r.rd);
  }
  return { week_land_count: landed.size, today_participated: todayParticipated };
}

// ───────── 동작들 ─────────
export function makeActions(sql) {
  const A = {};

  A.version = async () => ({ ok: true, app: "비행기방", version: APP_VERSION });

  A.login = async (b) => {
    const nickname = trim(b.nickname), insta = trim(b.insta_id);
    if (!nickname || !insta) return { ok: false, error: "닉네임과 인스타 아이디를 입력해주세요" };
    const [m] = await sql`
      select * from members where btrim(nickname) = ${nickname} and btrim(insta_id) = ${insta} limit 1`;
    if (!m) return { ok: false, error: "등록되지 않은 계정입니다" };
    if (m.status === "locked") return { ok: false, error: "locked", message: "계정이 잠금 상태입니다" };
    if (m.status === "inactive") return { ok: false, error: "inactive", message: "비활성 계정입니다" };
    await sql`update members set last_login_at = now() where member_id = ${m.member_id}`;

    const isWarned = m.status === "warned";
    let warnExpires = null;
    const warnings = [];
    if (isWarned) {
      const ws = await sql`
        select w.warn_id, w.reason, w.room_id, w.warned_at, w.expires_at,
               r.room_date::text as room_date, r.room_number
        from warnings w left join rooms r on r.room_id = w.room_id
        where w.member_id = ${m.member_id} and w.status = 'active'
        order by w.warned_at`;
      for (const w of ws) {
        if (!warnExpires) warnExpires = fmtDisp(w.expires_at);
        warnings.push({
          warn_id: w.warn_id, reason: w.reason, room_id: str(w.room_id),
          room_date: str(w.room_date), room_number: w.room_number ?? "",
          warned_at: fmtDisp(w.warned_at), expires_at: fmtDisp(w.expires_at),
        });
      }
    }
    return {
      ok: true,
      member: {
        member_id: m.member_id, nickname: m.nickname, insta_id: m.insta_id,
        status: m.status, grade: m.grade, warning_count: m.warning_count,
        excellent_count: Number(m.excellent_count) || 0,
        excellent_granted_at: m.excellent_granted_at ? String(m.excellent_granted_at.toISOString?.().slice(0, 10) ?? m.excellent_granted_at) : "",
        honorary_count: Number(m.honorary_count) || 0,
        honorary_granted_at: m.honorary_granted_at ? String(m.honorary_granted_at.toISOString?.().slice(0, 10) ?? m.honorary_granted_at) : "",
        is_warned: isWarned, warn_expires: warnExpires, warnings,
      },
    };
  };

  A.get_rooms = async (b) => {
    const myMid = b?.member_id ? String(b.member_id) : null;
    const now = new Date();
    const today = kstDate(now);
    const kstHour = kstParts(now).h;
    const yd = kstHour < 11 ? addDaysStr(today, -1) : today; // 11시 전엔 어제 방도 보임
    const rooms = await sql`
      select r.*, r.room_date::text as rd,
             count(p.part_id)::int as total_joined,
             (count(p.part_id) filter (where coalesce(p.ticket_type,'normal') = 'normal'))::int as normal_joined,
             (count(p.part_id) filter (where p.status = 'landed'))::int as landed_count
      from rooms r left join participations p on p.room_id = r.room_id
      where r.room_date in (${today}::date, ${yd}::date) and r.status <> 'closed'
      group by r.room_id
      order by r.room_date, r.room_number`;
    let mine = new Map();
    if (myMid && rooms.length) {
      const ids = rooms.map((r) => r.room_id);
      const mp = await sql`
        select room_id, status, ticket_type from participations
        where member_id = ${myMid} and room_id in ${sql(ids)}
        order by ticket_at`;
      for (const p of mp) if (!mine.has(p.room_id)) mine.set(p.room_id, p);
    }
    const out = [];
    for (const r of rooms) {
      if (r.land_end && now >= r.land_end) {
        const hideAfter = new Date(r.land_end.getTime() + 3600 * 1000);
        if (r.total_joined === 0 || now >= hideAfter) continue;
      }
      const my = mine.get(r.room_id);
      out.push({
        room_id: r.room_id, room_date: r.rd, room_number: r.room_number, items: r.items,
        max_members: Number(r.max_members) >= 9999 ? "무제한" : r.max_members,
        ticket_start: kstStr(r.ticket_start), ticket_end: kstStr(r.ticket_end),
        land_start: kstStr(r.land_start), land_end: kstStr(r.land_end),
        ticket_start_fmt: fmtDisp(r.ticket_start), ticket_end_fmt: fmtDisp(r.ticket_end),
        land_start_fmt: fmtDisp(r.land_start), land_end_fmt: fmtDisp(r.land_end),
        status: r.status, joined: r.normal_joined, total_joined: r.total_joined,
        landed_count: r.landed_count, memo: r.memo || "", preset_num: r.preset_num || "",
        my_status: my ? my.status : null,
        my_ticket_type: my ? my.ticket_type || "normal" : null,
      });
    }
    return { ok: true, rooms: out };
  };

  A.get_room_detail = async (b) => {
    if (!b.room_id) return { ok: false, error: "필수값 누락" };
    const [r] = await sql`select *, room_date::text as rd from rooms where room_id = ${b.room_id}`;
    if (!r) return { ok: false, error: "비행기를 찾을 수 없습니다" };
    const ps = await sql`select * from participations where room_id = ${b.room_id} order by ticket_at`;
    const out = {
      ok: true,
      room: {
        room_id: r.room_id, room_date: r.rd, room_number: r.room_number, items: r.items,
        max_members: r.max_members, memo: r.memo || "", status: r.status, preset_num: r.preset_num || "",
        ticket_start: kstStr(r.ticket_start), ticket_end: kstStr(r.ticket_end),
        land_start: kstStr(r.land_start), land_end: kstStr(r.land_end),
        ticket_start_fmt: fmtDisp(r.ticket_start), ticket_end_fmt: fmtDisp(r.ticket_end),
        land_start_fmt: fmtDisp(r.land_start), land_end_fmt: fmtDisp(r.land_end),
      },
      participants: ps.map((p) => ({
        part_id: p.part_id, member_id: p.member_id, nickname: p.nickname, insta_id: p.insta_id,
        post_url: p.post_url || "", ticket_at: fmtDisp(p.ticket_at), landed_at: fmtDisp(p.landed_at),
        status: p.status, ticket_type: p.ticket_type || "normal",
      })),
    };
    if (b.member_id) out.my_week = await weekStatus(sql, String(b.member_id));
    return out;
  };

  A.get_my_week_count = async (b) => {
    if (!b.member_id) return { ok: false, error: "필수값 누락" };
    const w = await weekStatus(sql, String(b.member_id));
    return { ok: true, ...w };
  };

  // 탑승: 방 행을 잠가서(for update) 정원 초과·중복 탑승이 동시에 일어나도 한 명씩 순서대로 처리
  A.ticket = async (b) => {
    const room_id = b.room_id, member_id = b.member_id, tt = b.ticket_type || "normal";
    if (!room_id || !member_id) return { ok: false, error: "필수값 누락" };
    try {
      return await sql.begin(async (tx) => {
        const [r] = await tx`select * from rooms where room_id = ${room_id} for update`;
        if (!r) fail("비행기를 찾을 수 없습니다");
        if (r.status === "closed") fail("마감된 비행기입니다");
        const now = new Date();
        if (r.ticket_start && now < r.ticket_start) fail("티켓팅 시작 전입니다");
        if (r.ticket_end && now >= r.ticket_end) fail("티켓팅이 마감되었습니다");

        const [c] = await tx`
          select (count(*) filter (where coalesce(ticket_type,'normal') = 'normal'))::int as normal_count,
                 (count(*) filter (where member_id = ${member_id} and coalesce(ticket_type,'normal') = ${tt}))::int as same
          from participations where room_id = ${room_id}`;
        if (c.same > 0) fail("이미 이 유형으로 참여한 비행기입니다");

        const [m] = await tx`select * from members where member_id = ${member_id} for update`;
        if (!m) fail("멤버를 찾을 수 없습니다");
        if (m.status === "locked") fail("잠금 상태로 탑승할 수 없습니다");
        if (tt !== "staff" && m.status === "warned") fail("경고 보유 중입니다. 차감 후 탑승 가능합니다.");

        const maxM = Number(r.max_members) || 20;
        if (tt === "normal" && maxM < 9999 && c.normal_count >= maxM)
          fail(`정원이 가득 찼습니다 (${c.normal_count}/${maxM})`);

        if (tt === "excellent") {
          if ((Number(m.excellent_count) || 0) <= 0) fail("우수 티켓이 없습니다");
          await tx`update members set excellent_count = excellent_count - 1 where member_id = ${member_id}`;
        }
        if (tt === "honorary") {
          if ((Number(m.honorary_count) || 0) <= 0) fail("명예 티켓이 없습니다");
          await tx`update members set honorary_count = honorary_count - 1 where member_id = ${member_id}`;
        }

        const instant = tt === "excellent" || tt === "honorary" || tt === "staff";
        const postUrl = b.post_url || "";
        await tx`
          insert into participations
            (part_id, room_id, room_date, room_number, member_id, nickname, insta_id, post_url,
             ticket_at, landed_at, status, ticket_type, created_at, link_at, preset_num, link_history)
          values
            (${randomUUID()}, ${room_id}, ${r.room_date}, ${r.room_number}, ${member_id},
             ${b.nickname || m.nickname}, ${b.insta_id || m.insta_id}, ${postUrl},
             now(), ${instant ? now : null}, ${instant ? "landed" : "ticketed"}, ${tt}, now(),
             ${postUrl ? now : null}, ${r.preset_num}, '')`;
        return { ok: true, message: instant ? "탑승 및 즉시 착륙 완료" : "탑승 완료", instant_land: instant };
      });
    } catch (e) {
      if (e instanceof UserError) return { ok: false, error: e.message };
      if (e?.code === "23505") return { ok: false, error: "이미 이 유형으로 참여한 비행기입니다" };
      throw e;
    }
  };

  const linkCommon = async (b, isUpdate) => {
    if (!b.room_id || !b.member_id || !b.post_url) return { ok: false, error: "필수값 누락" };
    if (String(b.post_url).indexOf("http") !== 0) return { ok: false, error: "올바른 URL을 입력하세요" };
    try {
      return await sql.begin(async (tx) => {
        const [r] = await tx`select ticket_end from rooms where room_id = ${b.room_id}`;
        if (r?.ticket_end && new Date() >= r.ticket_end)
          fail(isUpdate ? "티켓팅 마감 후 링크를 수정할 수 없습니다" : "티켓팅 마감 후 링크를 등록할 수 없습니다");
        const [p] = await tx`
          select * from participations where room_id = ${b.room_id} and member_id = ${b.member_id}
          order by ticket_at limit 1 for update`;
        if (!p) fail("탑승 기록이 없습니다");
        if (p.status === "landed") fail(isUpdate ? "착륙 완료 후 수정할 수 없습니다" : "착륙 완료 후 링크를 수정할 수 없습니다");
        if (!isUpdate) {
          if (p.post_url) fail("이미 링크가 등록되어 있습니다. 수정 버튼을 이용해주세요.");
          await tx`update participations set post_url = ${b.post_url}, link_at = now() where part_id = ${p.part_id}`;
          return { ok: true, message: "링크 등록 완료" };
        }
        const entry = `${kstStr(new Date())} | ${p.post_url || ""} → ${b.post_url}`;
        const hist = p.link_history ? `${p.link_history}\n${entry}` : entry;
        await tx`update participations set post_url = ${b.post_url}, link_at = now(), link_history = ${hist}
                 where part_id = ${p.part_id}`;
        return { ok: true, message: "링크 수정 완료" };
      });
    } catch (e) {
      if (e instanceof UserError) return { ok: false, error: e.message };
      throw e;
    }
  };
  A.register_link = (b) => linkCommon(b, false);
  A.update_link = (b) => linkCommon(b, true);

  A.land = async (b) => {
    if (!b.room_id || !b.member_id) return { ok: false, error: "필수값 누락" };
    try {
      return await sql.begin(async (tx) => {
        const [r] = await tx`select land_start, land_end from rooms where room_id = ${b.room_id}`;
        if (!r) fail("비행기를 찾을 수 없습니다");
        const now = new Date();
        if (r.land_start && now < r.land_start) fail("아직 착륙 시간이 아닙니다");
        if (r.land_end && now >= r.land_end) fail("착륙 시간이 마감되었습니다");
        const [p] = await tx`
          select * from participations where room_id = ${b.room_id} and member_id = ${b.member_id}
          order by ticket_at limit 1 for update`;
        if (!p) fail("탑승 기록이 없습니다");
        if (p.status === "landed") fail("이미 착륙 완료된 비행기입니다");
        await tx`update participations set status = 'landed', landed_at = now() where part_id = ${p.part_id}`;
        return { ok: true, message: "착륙 완료!" };
      });
    } catch (e) {
      if (e instanceof UserError) return { ok: false, error: e.message };
      throw e;
    }
  };

  return A;
}

export { UserError };
