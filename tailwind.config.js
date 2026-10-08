/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        primary: '#0F172A',
        accentBlue: '#2563EB',
        accentTeal: '#14B8A6',
        slateText: '#334155',
        lightBg: '#F8FAFC',
        brand: {
          DEFAULT: 'rgb(var(--brand-primary-rgb) / <alpha-value>)',
          2: 'rgb(var(--brand-primary-2-rgb) / <alpha-value>)',
          3: 'rgb(var(--brand-primary-3-rgb) / <alpha-value>)',
        },
        ink: 'rgb(var(--brand-ink-rgb) / <alpha-value>)',
        accent: {
          DEFAULT: 'rgb(var(--brand-accent-rgb) / <alpha-value>)',
          2: 'rgb(var(--brand-accent-2-rgb) / <alpha-value>)',
          soft: 'rgb(var(--brand-accent-soft-rgb) / <alpha-value>)',
          ink: 'rgb(var(--brand-accent-ink-rgb) / <alpha-value>)',
        },
      },
      boxShadow: {
        soft: '0 18px 60px rgba(15, 23, 42, 0.09)',
      },
      fontFamily: {
        // Telugu-capable families appended so bilingual Draft text renders everywhere.
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Arial',
          'Nirmala UI', 'Noto Sans Telugu', 'Gautami', 'sans-serif'],
        telugu: ['Nirmala UI', 'Noto Sans Telugu', 'Noto Serif Telugu', 'Gautami', 'Vani',
          'Lohit Telugu', 'Pothana2000', 'Segoe UI', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
