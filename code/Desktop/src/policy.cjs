const { resolve, relative, isAbsolute } = require('node:path');
function validateRequest(base, path, body) {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid backend origin');
  if (typeof path !== 'string' || !/^\/api\/(?:health|demo\/(?:health|catalog|model-server|model|classify|release)|auth\/(?:login|me|logout|users|forgot-password|verify-otp|verify-reset|reset-password|change-password|recovery-requests(?:\/[a-f0-9-]+\/review)?)|cameras\/roads(?:\/[a-z0-9-]{1,80}\/cameras)?|traffic\/intersections(?:\/[a-f0-9-]+\/(?:configure|history))?)$/.test(path)) throw new Error('Invalid API path');
  if (path.startsWith('/api/cameras/') && body !== undefined) throw new Error('Camera endpoints are read-only');
  if (['/api/demo/health', '/api/demo/catalog'].includes(path) && body !== undefined) throw new Error('AI health is read-only');
  if (path.startsWith('/api/demo/') && !['/api/demo/health', '/api/demo/catalog'].includes(path) && body === undefined) throw new Error('AI request body required');
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const limit = path === '/api/demo/model' ? 135 * 1024 * 1024 : path === '/api/demo/classify' ? 6 * 1024 * 1024 : ['/api/demo/release', '/api/demo/model-server'].includes(path) ? 1024 : 8192;
  if (payload && Buffer.byteLength(payload) > limit) throw new Error('Request too large');
  const timeout = ['/api/demo/model', '/api/demo/model-server'].includes(path) ? 240000 : path === '/api/demo/classify' ? 35000 : ['/api/demo/health', '/api/demo/catalog'].includes(path) ? 135000 : 10000;
  return { url: url.origin + path, payload, timeout };
}
function assetPath(root, pathname) {
  const decoded = decodeURIComponent(pathname);
  const target = resolve(root, '.' + decoded);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid asset path');
  return target;
}
function validateCameraMediaPath(path) {
  if (typeof path !== 'string' || !/^\/api\/cameras\/[a-z0-9][a-z0-9-]{0,79}\/(snapshot|stream)$/.test(path)) throw new Error('Invalid camera media path');
  return path;
}
module.exports = { validateRequest, assetPath, validateCameraMediaPath };
