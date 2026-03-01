'use client';

import { useState, useRef } from 'react';

export default function TextInput({ onSend, disabled }) {
    const [value, setValue] = useState('');
    const inputRef = useRef(null);

    const handleSend = () => {
        const trimmed = value.trim();
        if (!trimmed || disabled) return;
        onSend(trimmed);
        setValue('');
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    return (
        <div className="group relative flex items-center w-full transition-all duration-300">
            <input
                ref={inputRef}
                className="w-full rounded-2xl bg-slate-800/50 px-6 py-4 pr-16 text-sm text-white placeholder-slate-500 outline-none ring-1 ring-slate-700/50 transition-all focus:bg-slate-800 focus:ring-primary-500/50 focus:shadow-[0_0_20px_rgba(139,92,246,0.1)] disabled:opacity-50"
                type="text"
                placeholder="Message AI Receptionist..."
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={disabled}
                aria-label="Chat input"
            />
            <button
                className="absolute right-2 flex h-11 w-11 items-center justify-center rounded-xl bg-primary-600 text-white shadow-lg shadow-primary-500/20 transition-all hover:bg-primary-500 active:scale-95 disabled:grayscale disabled:opacity-50 disabled:active:scale-100"
                onClick={handleSend}
                disabled={disabled || !value.trim()}
                aria-label="Send message"
            >
                <svg className="h-5 w-5 rotate-90" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
            </button>
        </div>
    );
}

