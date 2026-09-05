const encoder = new TextEncoder();

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value || '')));
  return bytesToHex(new Uint8Array(digest));
}

export function readBearerToken(request) {
  const authorization = request.headers.get('Authorization') || '';
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] || null;
}

export function fixedTimeHexEqual(left, right) {
  const a = String(left || '').toLowerCase();
  const b = String(right || '').toLowerCase();
  const length = Math.max(a.length, b.length, 64);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function verifyDeviceToken(request, expectedDigest) {
  if (!expectedDigest) return { ok: false, reason: 'device_auth_not_configured' };
  const token = readBearerToken(request);
  if (!token) return { ok: false, reason: 'device_token_required' };
  const actualDigest = await sha256Hex(token);
  return fixedTimeHexEqual(actualDigest, expectedDigest)
    ? { ok: true }
    : { ok: false, reason: 'device_token_invalid' };
}
