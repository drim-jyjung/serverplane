// 관리자 로그인 확인표(토큰): 로그인에 성공하면 서버가 "도장 찍힌 표"를 주고,
// 관리자 전용 요청은 이 표가 있어야만 처리한다. 표는 12시간 후 만료.
// 도장(서명)은 서버에만 있는 비밀번호(ADMIN_SECRET)로 찍기 때문에 위조할 수 없다.
import { createHmac, timingSafeEqual } from "node:crypto";

const enc = (s) => Buffer.from(s).toString("base64url");

export function signAdminToken(secret, admin, ttlMs = 12 * 3600 * 1000, now = Date.now()) {
  const p = enc(JSON.stringify({ a: admin.admin_id, n: admin.nickname, e: now + ttlMs }));
  const sig = createHmac("sha256", secret).update(p).digest("base64url");
  return `${p}.${sig}`;
}

export function verifyAdminToken(secret, token, now = Date.now()) {
  if (!secret || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const good = createHmac("sha256", secret).update(parts[0]).digest();
  const given = Buffer.from(parts[1], "base64url");
  if (given.length !== good.length || !timingSafeEqual(given, good)) return null;
  let d;
  try { d = JSON.parse(Buffer.from(parts[0], "base64url").toString()); } catch { return null; }
  if (!d || !d.a || !(d.e > now)) return null;
  return { admin_id: d.a, nickname: d.n };
}
