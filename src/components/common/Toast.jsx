import React, { useEffect } from 'react';
import { CheckCircle2, AlertCircle } from 'lucide-react';

export function Toast({ message, type = 'success', onClose, duration = 3000 }) {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => {
      onClose();
    }, duration);
    return () => clearTimeout(timer);
  }, [message, onClose, duration]);

  if (!message) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[100] flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white shadow-xl animate-in fade-in slide-in-from-bottom-4">
      {type === 'success' ? (
        <CheckCircle2 size={18} className="text-emerald-400" />
      ) : (
        <AlertCircle size={18} className="text-rose-400" />
      )}
      <span>{message}</span>
    </div>
  );
}
