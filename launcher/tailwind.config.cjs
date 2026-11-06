/** @type {import('tailwindcss').Config} */
// 颜色全部指向 src/theme.css 由 design/tokens.json 生成的 CSS 变量，
// 这样 [data-theme="midnight"] 切换时，所有 Tailwind 生成的颜色自动跟随，
// 桌面端 React 与 Android 原生端共享同一份 design/tokens.json 色值。
module.exports = {
  content: ['./src/**/*.{js,jsx}', './index.html'],
  darkMode: ['selector', '[data-theme="midnight"]'],
  theme: {
    extend: {
      colors: {
        base: {
          900: 'rgb(var(--mc-bg900-rgb) / <alpha-value>)',
          800: 'rgb(var(--mc-bg800-rgb) / <alpha-value>)',
          700: 'rgb(var(--mc-bg700-rgb) / <alpha-value>)',
          600: 'rgb(var(--mc-bg700-rgb) / <alpha-value>)',
          500: 'rgb(var(--mc-bg500-rgb) / <alpha-value>)'
        },
        accent: {
          DEFAULT: 'rgb(var(--mc-accent-rgb) / <alpha-value>)',
          dim: 'var(--mc-accent-dim)',
          glow: 'var(--mc-accent-glow)'
        },
        mc: {
          text: 'var(--mc-text)',
          textMuted: 'var(--mc-text-muted)',
          surface: 'var(--mc-surface)',
          border: 'var(--mc-border)',
          green: 'rgb(var(--mc-green-rgb) / <alpha-value>)',
          gold: 'rgb(var(--mc-gold-rgb) / <alpha-value>)',
          red: 'rgb(var(--mc-red-rgb) / <alpha-value>)',
          cyan: 'rgb(var(--mc-cyan-rgb) / <alpha-value>)',
          violet: 'rgb(var(--mc-violet-rgb) / <alpha-value>)',
          orange: '#fb923c'
        }
      },
      fontFamily: {
        display: ['"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['"Cascadia Code"', '"JetBrains Mono"', 'Consolas', 'monospace']
      },
      borderRadius: {
        sm: 'var(--mc-r-sm)',
        md: 'var(--mc-r-md)',
        lg: 'var(--mc-r-lg)',
        xl: 'var(--mc-r-xl)'
      },
      transitionTimingFunction: {
        smooth: 'var(--mc-t-ease)'
      },
      transitionDuration: {
        fast: 'var(--mc-t-fast)',
        base: 'var(--mc-t-base)',
        slow: 'var(--mc-t-slow)'
      },
      boxShadow: {
        glow: '0 0 24px -4px var(--mc-accent-glow)',
        panel: '0 8px 32px -8px rgba(0, 0, 0, 0.6)'
      },
      backdropBlur: { xs: '2px' },
      keyframes: {
        'fade-in': { '0%': { opacity: 0, transform: 'translateY(8px)' }, '100%': { opacity: 1, transform: 'translateY(0)' } },
        'pulse-soft': { '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.55 } },
        'scale-in': { '0%': { opacity: 0, transform: 'scale(0.96)' }, '100%': { opacity: 1, transform: 'scale(1)' } }
      },
      animation: {
        'fade-in': 'fade-in 0.35s ease-out both',
        'pulse-soft': 'pulse-soft 2s ease-in-out infinite',
        'scale-in': 'scale-in 0.22s cubic-bezier(0.22, 1, 0.36, 1) both'
      }
    }
  },
  plugins: []
}
