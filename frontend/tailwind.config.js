/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
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
