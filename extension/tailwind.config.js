/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/**/*.{ts,tsx,html}",
    "./src/popup/index.html",
    "./src/options/index.html"
  ],
  theme: {
    extend: {
      colors: {
        player: {
          bg: "#0d0f12",
          surface: "#181b20",
          control: "#242831",
          border: "#2f3542",
          text: "#f1f2f6",
        }
      }
    },
  },
  plugins: [],
}
