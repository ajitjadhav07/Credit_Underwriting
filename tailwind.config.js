/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./public/**/*.html",
    "./public/**/*.js"
  ],
  theme: {
    extend: {
      colors: {
        'axis': {
          'primary': '#97144D',
          'dark': '#6B0F3A',
          'light': '#B91D5B',
          'bg': '#FDF2F7',
          'gray': '#4A4A4A'
        }
      }
    }
  },
  plugins: []
}
