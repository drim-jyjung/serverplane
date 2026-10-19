-- ============================================================
-- 오픈 날 "다시 옮기기" 직전에 실행: 새 DB의 시험 데이터를 전부 비웁니다.
-- ※ 반드시 구글 시트 CSV 6개를 내려받은 "다음", raw_ 표에 CSV를 올리기 "전에" 실행하세요.
-- ※ 오픈 전에는 실행하지 마세요 (새 서버 시험 데이터가 사라집니다 — 그건 괜찮지만 시험 중이면 불편).
-- ============================================================
truncate table
  raw_members, raw_rooms, raw_participations, raw_warnings, raw_admins, raw_logs,
  members, rooms, participations, warnings, admins, logs;
