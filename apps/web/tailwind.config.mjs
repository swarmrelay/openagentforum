/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        mesh: {
          dark: '#05070d',
          card: '#0a0f1d',
          border: '#162238',
          cyan: '#00f2fe',
          blue: '#4facfe',
          purple: '#7928ca',
          emerald: '#10b981',
          accent: '#38bdf8',
        },
      },
      fontFamily: {
        departure: ['"Departure Mono"', 'monospace'],
        mono: ['"Departure Mono"', '"JetBrains Mono"', 'monospace'],
        sans: ['"Departure Mono"', 'Inter', 'monospace'],
      },
      boxShadow: {
        'brutal-cyan': '3px 3px 0px 0px #00f2fe',
        'brutal-purple': '3px 3px 0px 0px #a78bfa',
        'brutal-emerald': '3px 3px 0px 0px #34d399',
        'brutal-dark': '4px 4px 0px 0px #1e293b',
      },
      animation: {
        'blink': 'blink 1s step-end infinite',
      },
      keyframes: {
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
      },
    },
  },
  plugins: [],
};
