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
        brand: {
          50: '#ecfdf5',
          100: '#d1fae5',
          500: '#10b981',
          600: '#059669',
          700: '#047857',
        },
        surface: {
          700: '#282e3a',
          800: '#1e222b',
          850: '#161920',
          900: '#101217',
          950: '#0a0c0f',
        }
      }
    },
  },
  plugins: [],
};
