const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

async function verifyTurnstileToken(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) throw new Error('TURNSTILE_SECRET_KEY belum dikonfigurasi');

  if (!token || typeof token !== 'string' || token.length > 2048) {
    return { success: false };
  }

  const body = new URLSearchParams({
    secret,
    response: token,
  });
  if (remoteIp) body.set('remoteip', remoteIp);

  const response = await fetch(TURNSTILE_VERIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) throw new Error(`Turnstile Siteverify HTTP ${response.status}`);

  const result = await response.json();

  const expectedHostname = process.env.TURNSTILE_EXPECTED_HOSTNAME;
  if (expectedHostname && result.hostname && result.hostname !== expectedHostname) {
    return { success: false };
  }

  return result;
}

async function requireTurnstile(req, res, next) {
  try {
    if (!req.body?.turnstile_token) {
      return res.status(400).json({ error: 'Verifikasi CAPTCHA wajib dilakukan' });
    }

    const result = await verifyTurnstileToken(req.body.turnstile_token, req.ip);

    if (!result.success) {
      return res.status(403).json({
        error: 'Verifikasi CAPTCHA gagal. Silakan coba lagi.',
      });
    }

    next();
  } catch (err) {
    console.error('[turnstile] verification error:', err);
    return res.status(503).json({
      error: 'Layanan CAPTCHA sedang tidak tersedia. Coba lagi beberapa saat.',
    });
  }
}

module.exports = { verifyTurnstileToken, requireTurnstile };
