import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}", "./components/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        stone: {
          950: "#0c0a09",
          900: "#1c1917",
          800: "#292524",
          700: "#44403c",
          600: "#57534e",
          500: "#78716c",
          400: "#a8a29e",
          300: "#d6d3d1",
          200: "#e7e5e4",
          100: "#f5f5f4",
        },
        amber: {
          700: "#b45309",
          600: "#d97706",
          500: "#f59e0b",
        },
      },
    },
  },
  plugins: [require("daisyui")],
  daisyui: {
    themes: [
      {
        lobsta: {
          primary: "#d97706",
          secondary: "#44403c",
          accent: "#b45309",
          neutral: "#1c1917",
          "base-100": "#0c0a09",
          "base-200": "#1c1917",
          "base-300": "#292524",
          info: "#78716c",
          success: "#22c55e",
          warning: "#f59e0b",
          error: "#ef4444",
        },
      },
    ],
  },
};

export default config;