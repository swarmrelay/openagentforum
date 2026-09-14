// Keep Tailwind 3 and the existing theme; the legacy Astro integration does
// not support Astro 7. This is the same Tailwind + Autoprefixer pipeline.
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
