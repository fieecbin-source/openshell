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
        apple: {
          blue: '#0071e3',
          hoverBlue: '#0077ed',
          green: '#34c759',
          orange: '#ff9500',
          red: '#ff3b30',
          purple: '#af52de',
          teal: '#30b0c7',
          gray: '#8e8e93',
          border: 'rgba(0, 0, 0, 0.08)',
          card: 'rgba(255, 255, 255, 0.85)',
          bg: '#f5f5f7',
        },
        brand: {
          50: '#ecfdf5',
          100: '#d1fae5',
          500: '#0071e3',
          600: '#0062c4',
          700: '#0051a3',
        },
        surface: {
          50: '#ffffff',
          100: '#fbfbfd',
          200: '#f5f5f7',
          300: '#ebebed',
          400: '#d2d2d7',
          500: '#86868b',
          600: '#515154',
          700: '#e5e5ea',
          800: '#e5e5ea',
          850: '#ebebed',
          900: '#ffffff',
          950: '#f5f5f7',
        }
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Text"',
          '"SF Pro Display"',
          '"Helvetica Neue"',
          'Segoe UI',
          'Roboto',
          'Inter',
          'sans-serif',
        ],
        mono: [
          '"SF Mono"',
          'Menlo',
          'Monaco',
          'Consolas',
          '"Courier New"',
          'monospace',
        ],
      },
      boxShadow: {
        'apple-sm': '0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.04)',
        'apple-md': '0 4px 14px rgba(0, 0, 0, 0.06), 0 1px 3px rgba(0, 0, 0, 0.04)',
        'apple-lg': '0 10px 30px rgba(0, 0, 0, 0.08), 0 2px 6px rgba(0, 0, 0, 0.04)',
        'apple-xl': '0 20px 40px rgba(0, 0, 0, 0.12), 0 4px 12px rgba(0, 0, 0, 0.06)',
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
      }
    },
  },
  plugins: [],
};
