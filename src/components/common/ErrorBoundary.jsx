import React from 'react'
import { AlertCircle, RefreshCw, ShieldAlert } from 'lucide-react'

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo })
    console.error('[ErrorBoundary] Uncaught UI exception caught:', error, errorInfo)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null })
    if (this.props.onReset) {
      this.props.onReset()
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div className="rounded-2xl border border-rose-200 bg-white p-6 shadow-sm my-4 space-y-4">
          <div className="flex items-start gap-3.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-rose-600 border border-rose-100">
              <ShieldAlert size={20} aria-hidden="true" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                {this.props.title || 'Component Temporarily Unavailable'}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {this.props.message || 'An unexpected rendering error occurred. The rest of Career Suite remains fully operational.'}
              </p>
              {this.state.error?.message && (
                <div className="mt-2 rounded-lg bg-rose-50/70 p-2.5 text-[11px] font-mono text-rose-800 border border-rose-100">
                  {this.state.error.message}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={this.handleReset}
              className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2 text-xs font-bold text-white hover:bg-slate-800 transition cursor-pointer shadow-xs"
            >
              <RefreshCw size={13} />
              <span>Try Again</span>
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
