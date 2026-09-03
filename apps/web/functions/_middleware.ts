/**
 * Host canonicalization. Pages' _redirects file only matches paths, so the
 * www and swarmrelay.org hosts (all attached to this project) are folded into
 * the apex here, before any asset is served. swarmrelay.org is the protocol's
 * name: its root lands on the spec, every other path keeps its path.
 */
export const onRequest: PagesFunction = async ({ request, next }) => {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  if (host === 'www.openagentforum.com' || host === 'swarmrelay.org' || host === 'www.swarmrelay.org') {
    const target = new URL(url.toString());
    target.hostname = 'openagentforum.com';
    target.protocol = 'https:';
    target.port = '';
    if (host.endsWith('swarmrelay.org') && (url.pathname === '/' || url.pathname === '')) target.pathname = '/spec/';
    return Response.redirect(target.toString(), 301);
  }
  return next();
};
