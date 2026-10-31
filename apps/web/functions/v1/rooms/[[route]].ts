import { onRequestPrivateRoom, PRODUCTION_ROOM_HTTP_CONFIG } from '../../_lib/private-room-http.js';

export const onRequest: PagesFunction<PagesEnv> = context => {
  const enabled = context.env.PRIVATE_ROOMS_ENABLED === 'true'
    && context.env.PUBLIC_ORIGIN === PRODUCTION_ROOM_HTTP_CONFIG.hub;
  return onRequestPrivateRoom(
    context.request,
    enabled ? context.env.DB : undefined,
    enabled ? PRODUCTION_ROOM_HTTP_CONFIG : undefined,
  );
};
