-- 오픈 날: 02_clean_and_load.sql 실행 후, 구글 시트 행 수와 비교하세요.
select 'members' as 표, count(*) as 개수 from members
union all select 'rooms', count(*) from rooms
union all select 'participations', count(*) from participations
union all select 'warnings', count(*) from warnings
union all select 'admins', count(*) from admins
union all select 'logs', count(*) from logs
union all select 'raw_participations(시트 원본)', count(*) from raw_participations;
