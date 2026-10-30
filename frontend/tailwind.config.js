/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // 语义色板（单一来源：src/index.css 的 CSS 变量）
        canvas: 'rgb(var(--os-canvas) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--os-surface) / <alpha-value>)',
          muted: 'rgb(var(--os-surface-muted) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'rgb(var(--os-ink) / <alpha-value>)',
          secondary: 'rgb(var(--os-ink-secondary) / <alpha-value>)',
          tertiary: 'rgb(var(--os-ink-tertiary) / <alpha-value>)',
        },
        line: 'rgb(var(--os-line) / <alpha-value>)',
        accent: 'rgb(var(--os-accent) / <alpha-value>)',
        action: 'rgb(var(--os-action) / <alpha-value>)',
        'danger-action': 'rgb(var(--os-danger-action) / <alpha-value>)',
        scrim: 'rgb(var(--os-scrim) / <alpha-value>)',
        state: {
          success: 'rgb(var(--os-success) / <alpha-value>)',
          warning: 'rgb(var(--os-warning) / <alpha-value>)',
          danger: 'rgb(var(--os-danger) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Text"',
          '"Segoe UI Variable Text"',
          '"Segoe UI"',
          '"PingFang SC"',
          '"Microsoft YaHei UI"',
          '"Noto Sans CJK SC"',
          'sans-serif',
        ],
        mono: [
          '"SF Mono"',
          '"Cascadia Code"',
          'Menlo',
          'Consolas',
          '"JetBrains Mono"',
          'monospace',
        ],
      },
      fontSize: {
        'os-2xs': ['11px', { lineHeight: '16px' }],
        'os-xs': ['12px', { lineHeight: '18px' }],
        'os-sm': ['13px', { lineHeight: '20px' }],
        'os-md': ['15px', { lineHeight: '22px' }],
        'os-lg': ['17px', { lineHeight: '24px' }],
      },
      borderRadius: {
        'os-sm': '8px',
        'os-md': '10px',
        'os-lg': '14px',
        'os-xl': '18px',
      },
      boxShadow: {
        'apple-sm': '0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.04)',
        'apple-md': '0 4px 14px rgba(0, 0, 0, 0.06), 0 1px 3px rgba(0, 0, 0, 0.04)',
        'apple-lg': '0 10px 30px rgba(0, 0, 0, 0.08), 0 2px 6px rgba(0, 0, 0, 0.04)',
        'apple-xl': '0 20px 40px rgba(0, 0, 0, 0.12), 0 4px 12px rgba(0, 0, 0, 0.06)',
        'os-sm': '0 1px 3px rgb(57 90 137 / 0.08)',
        'os-md': '0 4px 14px rgb(57 90 137 / 0.12)',
        'os-lg': '0 20px 56px rgb(57 90 137 / 0.18)',
      },
      // 更新弹窗与顶栏徽标专用的轻量动效（150-200ms，避免拖慢交互）
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'zoom-in': {
          from: { opacity: '0', transform: 'scale(0.96) translateY(6px)' },
          to: { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        'pulse-dot': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out',
        'zoom-in': 'zoom-in 200ms ease-out',
        'pulse-dot': 'pulse-dot 2s ease-in-out infinite',
      },
      transitionTimingFunction: {
        os: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      },
      transitionDuration: {
        'os-fast': '120ms',
        os: '180ms',
        'os-slow': '220ms',
      },
    },
  },
  plugins: [],
};
