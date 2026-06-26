/** @type {import('tailwindcss').Config} */
module.exports = {
  // Scan every page + JS (classes also live inside inline <script> template
  // literals), plus the server-rendered routes in src (blog/desaparecidos emit
  // HTML with utility classes that must compile too).
  content: ['./public/**/*.html', './public/**/*.js', './src/**/*.ts'],
  theme: {
    extend: {
      colors: {
        surface: '#f9f9fc',
        'surface-dim': '#dadadc',
        'surface-bright': '#f9f9fc',
        'surface-container-lowest': '#ffffff',
        'surface-container-low': '#f3f3f6',
        'surface-container': '#eeeef0',
        'surface-container-high': '#e8e8ea',
        'surface-container-highest': '#e2e2e5',
        'on-surface': '#1a1c1e',
        'on-surface-variant': '#44474f',
        outline: '#747780',
        'outline-variant': '#c4c6d0',
        primary: '#00173a',
        'primary-container': '#0b2b5b',
        'on-primary-container': '#7a94ca',
        secondary: '#bb0027',
        'secondary-container': '#e0283c',
        'secondary-fixed': '#ffb3b1',
        critical: '#c8102e',
        warning: '#e57200',
        advisory: '#ffbc3d',
        safe: '#2e7d32',
        // Venezuela flag accents used by the SEO/blog pages
        amarillo: '#f2c200',
        naranja: '#e57200',
        rojo: '#bb0027',
        azul: '#00173a',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Public Sans', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      borderRadius: { DEFAULT: '0.25rem', md: '0.375rem', lg: '0.5rem' },
    },
  },
  // The pages use dynamic/arbitrary classes inside JS — safelist the families that
  // are generated at runtime (severity badges, status pills) so they always exist.
  safelist: [
    { pattern: /^(bg|text|border)-(primary|secondary|critical|warning|advisory|safe|on-surface|on-surface-variant|outline|outline-variant)(-container|-variant|-fixed)?$/ },
    { pattern: /^(bg|text|border)-(primary|secondary|critical|warning|advisory|safe)\/(5|10|15|20|30|40|60|70|80|90)$/ },
  ],
  plugins: [],
};
