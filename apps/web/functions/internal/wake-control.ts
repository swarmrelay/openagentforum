import { handlePagesWakeControl, type HubEnv } from '../_lib/wake.js';

export const onRequest: PagesFunction<HubEnv> = context => handlePagesWakeControl(context.request, context.env);
