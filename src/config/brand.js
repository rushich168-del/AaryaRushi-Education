// Single source of truth for everything brand-specific in AaryaRushi Education.
// Change values here to re-brand the whole platform for another institute.
// Contact details below are demo placeholders.

export const brand = {
  name: 'AaryaRushi Education',
  shortName: 'AaryaRushi',
  initials: 'AR',
  tagline: 'Learn. Practise. Succeed.',
  description:
    'AaryaRushi Education is a demo learning platform for coaching institutes: courses, online tests, results and fee payments in one place.',
  domain: 'aaryarushi-education.pages.dev',

  logo: {
    mark: '/brand/logo-mark.svg', // square monogram (favicon, avatars, checkout)
    markLight: '/brand/logo-mark-light.svg', // monogram for dark backgrounds
  },

  images: {
    hero: '/brand/hero.svg',
    studentWelcome: '/brand/student-welcome.svg',
  },

  // Indigo + amber. CSS uses these through --brand-* variables (see applyBrandTheme).
  colors: {
    primary: '#312e81', // indigo 900
    primary2: '#3730a3', // indigo 800
    primary3: '#4338ca', // indigo 700 (hover)
    ink: '#1e1b4b', // indigo 950 (headings / dark text)
    accent: '#f59e0b', // amber 500
    accent2: '#d97706', // amber 600 (hover)
    accentSoft: '#fef3c7', // amber 100
    accentInk: '#92400e', // amber 800 (text on light backgrounds)
  },

  contact: {
    phone: '+91 90000 00000',
    phoneHref: 'tel:+919000000000',
    email: 'hello@aaryarushi-education.example',
    address: '2nd floor, Demo Towers, Main Road',
    city: 'Demo City',
    mapQuery: '',
  },

  centres: [
    { name: 'Demo City', tag: 'Main centre', address: '2nd floor, Demo Towers, Main Road' },
    { name: 'North Campus', tag: 'Branch', address: 'Near Central Library, North Avenue' },
    { name: 'Online', tag: 'Live classes', address: 'Join live classes from anywhere' },
  ],

  payments: {
    provider: 'Razorpay',
    checkoutName: 'AaryaRushi Education',
  },
}

const VAR_MAP = {
  primary: 'brand-primary',
  primary2: 'brand-primary-2',
  primary3: 'brand-primary-3',
  ink: 'brand-ink',
  accent: 'brand-accent',
  accent2: 'brand-accent-2',
  accentSoft: 'brand-accent-soft',
  accentInk: 'brand-accent-ink',
}

function hexToRgb(hex) {
  const value = hex.replace('#', '')
  const n = parseInt(value.length === 3 ? value.replace(/./g, (c) => c + c) : value, 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

// Writes the brand colours as CSS variables on <html>. styles.css holds the same
// defaults so the first paint already matches.
export function applyBrandTheme(target = document.documentElement) {
  for (const [key, name] of Object.entries(VAR_MAP)) {
    const hex = brand.colors[key]
    if (!hex) continue
    target.style.setProperty(`--${name}`, hex)
    target.style.setProperty(`--${name}-rgb`, hexToRgb(hex))
  }
}

export default brand
