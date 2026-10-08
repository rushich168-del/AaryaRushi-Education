// Set PROJECT_REF to the new AaryaRushi Education Supabase project (step 4). Builds fail closed until then.
export const PROJECT_REF = 'REPLACE_WITH_NEW_PROJECT_REF'
export const BACKEND_URL = `https://${PROJECT_REF}.supabase.co`

// A browser build may contain only a public key for the approved KSC project.
// Decoding legacy JWT metadata here is a build guard, not signature verification.
export function stagingEnvironment(env) {
  if (env.VITE_SUPABASE_URL !== BACKEND_URL) throw new Error('Staging requires the approved backend URL (set PROJECT_REF).')
  const key = env.VITE_SUPABASE_ANON_KEY || ''
  let publicKey = /^sb_publishable_[A-Za-z0-9_-]+$/.test(key)
  if (!publicKey) {
    try {
      const parts = key.split('.')
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
      publicKey = parts.length === 3 && payload.role === 'anon' && payload.ref === PROJECT_REF
    } catch { /* Reject malformed or private keys without printing them. */ }
  }
  if (!publicKey) throw new Error('Staging requires a public publishable key or matching anon key; private keys are forbidden.')
  return { VITE_SUPABASE_URL: BACKEND_URL, VITE_SUPABASE_ANON_KEY: key, VITE_PUBLIC_PREVIEW: 'false' }
}

// B4.7 in-browser paper preparation: the self-hosted Telugu OCR engine is WebAssembly
// ('wasm-unsafe-eval' allows compiling it, not JavaScript eval) running in same-origin workers;
// Review Center crops are shown from short-lived signed URLs of the private KSC bucket (backend host)
// and as blob: images (PDF source regions).
export const stagingCsp = (backend = BACKEND_URL) => `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://checkout.razorpay.com; worker-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: ${backend} https://*.razorpay.com; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' ${backend} https://api.razorpay.com https://lumberjack.razorpay.com; frame-src https://api.razorpay.com https://checkout.razorpay.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`

export const stagingHeaders = `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: ${stagingCsp()}
  X-Robots-Tag: noindex, nofollow
`
