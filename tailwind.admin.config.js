/** @type {import('tailwindcss').Config} */
// Dedicated Tailwind config for the ADMINISTRATION console SPA (/console).
// Kept separate from the root tailwind.config.js so the class-based dark mode
// and admin-only design tokens never leak into (or break) the public pages.
module.exports = {
  darkMode: 'class',
  content: ['./admin-src/**/*.{ts,tsx}', './public/console/index.html'],
  theme: {
    extend: {
      colors: {
        // Neutral scale (Linear/Stripe-style). Light + dark resolve via CSS vars.
        brand: {
          50: '#eef4ff',
          100: '#dbe6ff',
          200: '#bccffe',
          300: '#8eaffc',
          400: '#5984f8',
          500: '#345ff1',
          600: '#1f43e6',
          700: '#1a33d3',
          800: '#1c2cab',
          900: '#1d2c87',
        },
        ok: '#16a34a',
        warn: '#d97706',
        danger: '#dc2626',
        info: '#0284c7',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: { DEFAULT: '0.5rem', md: '0.625rem', lg: '0.75rem', xl: '1rem' },
      boxShadow: {
        card: '0 1px 2px 0 rgb(0 0 0 / 0.04), 0 1px 3px 0 rgb(0 0 0 / 0.06)',
        drawer: '-8px 0 32px -8px rgb(0 0 0 / 0.18)',
        palette: '0 16px 48px -12px rgb(0 0 0 / 0.32)',
        pop: '0 8px 24px -8px rgb(0 0 0 / 0.20)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-in': { from: { transform: 'translateX(100%)' }, to: { transform: 'translateX(0)' } },
        'scale-in': { from: { opacity: '0', transform: 'translateY(6px) scale(.98)' }, to: { opacity: '1', transform: 'translateY(0) scale(1)' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'toast-in': { from: { opacity: '0', transform: 'translateY(12px) scale(.97)' }, to: { opacity: '1', transform: 'translateY(0) scale(1)' } },
      },
      animation: {
        'fade-in': 'fade-in .15s ease-out',
        'slide-in': 'slide-in .24s cubic-bezier(.32,.72,0,1)',
        'scale-in': 'scale-in .16s ease-out',
        'toast-in': 'toast-in .22s cubic-bezier(.32,.72,0,1)',
      },
    },
  },
  plugins: [],
};
