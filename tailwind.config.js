/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/index.tsx'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
      colors: {
        dark: {
          900: '#080c1a',
          800: '#0B1120',
          700: '#151D30',
          600: '#1F2B40',
        },
        accent: {
          primary: '#6366f1',
          secondary: '#818cf8',
          blue: '#3b82f6',
          dark: '#312e81',
        },
      },
    },
  },
  plugins: [],
}
