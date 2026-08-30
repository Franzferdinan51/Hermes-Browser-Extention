const LOCAL_PATH_RE = /^(?:[A-Za-z]:[\\/]|\/|~[\\/])/;
const REMOTE_URL_RE = /^https?:\/\//i;

function cleanSource(value = '') {
  return String(value || '').trim().replace(/^MEDIA:/i, '').trim();
}

function artifactName(source = '') {
  const clean = cleanSource(source).replace(/[?#].*$/, '').replace(/[\\/]$/, '');
  const value = clean.split(/[\\/]/).pop() || 'Generated file';
  try { return decodeURIComponent(value); } catch { return value; }
}

export function toFileUrl(source = '') {
  const clean = cleanSource(source).replace(/\\/g, '/');
  if (!LOCAL_PATH_RE.test(clean)) return '';
  if (clean.startsWith('/')) return `file://${encodeURI(clean)}`;
  return `file:///${encodeURI(clean)}`;
}

export function describeArtifact(source = '') {
  const clean = cleanSource(source);
  const name = artifactName(clean);
  const extension = /\.([a-z0-9]{1,12})$/i.exec(name)?.[1]?.toLowerCase() || '';
  const kind = REMOTE_URL_RE.test(clean) ? 'remote' : LOCAL_PATH_RE.test(clean) ? 'local' : 'unknown';
  return { source: clean, name, extension, kind };
}

export function artifactActionState(artifact = {}, { localGateway = false } = {}) {
  if (artifact.kind === 'remote') {
    return { canDownload: true, canOpen: true, unavailableReason: '' };
  }
  if (artifact.kind === 'local' && localGateway) {
    return { canDownload: true, canOpen: true, unavailableReason: '' };
  }
  return {
    canDownload: false,
    canOpen: false,
    unavailableReason: 'This file lives on the connected runtime. The gateway has not exposed a downloadable URL yet.',
  };
}
