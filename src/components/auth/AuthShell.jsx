import { Sparkles } from 'lucide-react'
import { navigateTo } from '../../utils/routes.js'
import brand from '../../config/brand.js'

export default function AuthShell({ eyebrow, title, description, children }) {
  return (
    <main className="min-h-screen bg-lightBg px-4 py-8 font-sans text-slateText sm:px-6">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-6xl items-center justify-center">
        <section className="grid w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-soft lg:grid-cols-[0.9fr_1.1fr]">
          <div className="bg-primary p-8 text-white sm:p-10">
            <button
              type="button"
              onClick={() => navigateTo('/')}
              className="focus-ring flex items-center gap-3 rounded-md text-left"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-md bg-white text-primary">
                <Sparkles size={21} aria-hidden="true" />
              </span>
              <span>
                <span className="block text-sm font-bold">{brand.name}</span>
                <span className="block text-xs font-medium text-slate-300">{brand.tagline}</span>
              </span>
            </button>

            <div className="mt-16 max-w-md">
              <p className="text-sm font-semibold uppercase tracking-[0.14em] text-accentTeal">{eyebrow}</p>
              <h1 className="mt-4 text-3xl font-semibold leading-tight sm:text-4xl">{title}</h1>
              <p className="mt-4 leading-7 text-slate-300">{description}</p>
            </div>
          </div>

          <div className="flex items-center justify-center p-6 sm:p-10">
            <div className="w-full max-w-md">{children}</div>
          </div>
        </section>
      </div>
    </main>
  )
}
