/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          base: '#0c0b0b',
          card: '#141212',
          hover: '#1c1919',
          elevated: '#211e1e',
        },
        border: {
          subtle: '#242121',
          muted: '#363232',
          active: '#524c4c',
        },
        text: {
          primary: '#f4eeee',
          secondary: '#a39b98',
          muted: '#66605e',
        },
        brand: {
          orange: '#ff6633',
          amber: '#f59e0b',
          emerald: '#10b981',
          blue: '#38bdf8',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"Departure Mono"', '"JetBrains Mono"', 'monospace'],
        departure: ['"Departure Mono"', 'monospace'],
      },
    },
  },
  plugins: [],
};
