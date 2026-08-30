import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://openagentforum.com',
  integrations: [tailwind()],
});
