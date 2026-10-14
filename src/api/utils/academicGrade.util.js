// Academic identities shared by the published catalogue and re-enrollment.
// Only the class label can disambiguate legacy PERIODO records.
function normalizeAcademicGrade(grade, className = '') {
  const raw = String(grade || '').trim();
  const plain = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
  const normalized = plain(raw);
  if (normalized === 'MATERNAL') return 'Maternal';
  if (raw === '.') return '7º Ano';
  const year = normalized.match(/^(\d+)\s*[º°O]?\s*ANO$/) || normalized.match(/^(\d+)$/);
  if (year) return `${Number(year[1])}º Ano`;
  const periodPattern = /^(I{1,3}|\d+)\s*[º°O]?\s*PERIODO\b/;
  const period = normalized.match(periodPattern) ||
    (normalized === 'PERIODO' ? plain(className).match(periodPattern) : null);
  if (period) {
    const roman = { I: 1, II: 2, III: 3 };
    return `${roman[period[1]] || Number(period[1])}º Período`;
  }
  return normalized === 'PERIODO' ? 'PERIODO' : raw;
}

function isNumberedPeriod(grade) {
  return /^\d+º Período$/.test(normalizeAcademicGrade(grade));
}

module.exports = { normalizeAcademicGrade, isNumberedPeriod };
