function parseTrustProxy(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.toLowerCase() === 'false') return false;

  if (/^\d+$/.test(normalized)) {
    return Number(normalized);
  }

  const allowedNames = new Set(['loopback', 'linklocal', 'uniquelocal']);
  const entries = normalized
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (
    entries.length &&
    entries.every(
      (entry) =>
        allowedNames.has(entry.toLowerCase()) ||
        /^[a-f0-9:.]+(?:\/\d{1,3})?$/i.test(entry)
    )
  ) {
    return entries.join(',');
  }

  console.warn(
    '[config] TRUST_PROXY ignorado. Use um numero de saltos, IP/CIDR ou loopback/linklocal/uniquelocal.'
  );
  return false;
}

module.exports = { parseTrustProxy };
