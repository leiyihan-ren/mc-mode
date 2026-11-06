/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx}', './index.html'],
  theme: {
    extend: {
      colors: {
        base: { 900: '#0a0e17', 800: '#0f1522', 700: '#151d2e', 600: '#1c2740', 500: '#263353' },
        accent: { DEFAULT: '#5eead4', dim: '#2dd4bf', glow: '#14b8a6' },
        mc: { green: '#3ddc84', gold: '#fbbf24', red: '#f87171', blue: '#60a5fa', purple: '#a78bfa', orange: '#fb923c' }
      },
      fontFamily: {
        display: ['"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['"Cascadia Code"', '"JetBrains Mono"', 'Consolas', 'monospace']
      },
      boxShadow: {
        glow: '0 0 24px -4px rgba(94, 234, 212, 0.45)',
        panel: '0 8px 32px -8px rgba(0, 0, 0, 0.6)'
      },
      backdropBlur: { xs: '2px' },
      keyframes: {
        'fade-in': { '0%': { opacity: 0, transform: 'translateY(8px)' }, '100%': { opacity: 1, transform: 'translateY(0)' } },
        'pulse-soft': { '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.55 } }
      },
      animation: {
        'fade-in': 'fade-in 0.35s ease-out both',
        'pulse-soft': 'pulse-soft 2s ease-in-out infinite'
      }
    }
  },
  plugins: []
}
