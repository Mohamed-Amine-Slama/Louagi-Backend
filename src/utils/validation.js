import sanitizeHtml from 'sanitize-html';

export function validateTunisianPhone(raw) {
  if (!raw) return 'Phone number required';
  const compact = String(raw).replace(/\s/g, '');
  if (!/^(\+216)?\d{8}$/.test(compact)) return 'Use Tunisian format: +216 XXXXXXXX';
  return null;
}

export function normalizeTunisianPhone(raw) {
  const compact = String(raw || '').replace(/\s/g, '');
  return compact.startsWith('+216') ? compact : `+216${compact}`;
}

export function validatePassword(password) {
  if (!password || password.length < 8) return 'Min 8 characters';
  if (!/[A-Z]/.test(password)) return 'Needs 1 uppercase letter';
  if (!/\d/.test(password)) return 'Needs 1 digit';
  return null;
}

export function validateEmail(email) {
  if (!email) return 'Email required';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Invalid email';
  return null;
}

export function validateName(name) {
  if (!name || String(name).trim().length < 2) return 'Name too short';
  if (String(name).length > 60) return 'Name too long';
  return null;
}

export function validateOtp(code) {
  if (!/^\d{6}$/.test(code || '')) return 'Enter the 6-digit code';
  return null;
}

export function validatePlate(plate) {
  if (!plate) return 'Plate required';
  if (!/^[A-Z0-9\s-]{4,12}$/i.test(plate)) return 'Invalid plate';
  return null;
}

export function validateSeatCount(n, max = 8) {
  const value = Number(n);
  if (!Number.isInteger(value) || value < 1 || value > max) return `1-${max} seats only`;
  return null;
}

export function validateFileSize(bytes, maxMb) {
  if (Number(bytes) > maxMb * 1024 * 1024) return `File exceeds ${maxMb} MB`;
  return null;
}

export function sanitize(value) {
  if (value == null) return '';
  return sanitizeHtml(String(value), {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: 'discard',
    enforceHtmlBoundary: true,
  })
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, 500);
}
