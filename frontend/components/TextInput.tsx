'use client';

import React, { useState, useRef, KeyboardEvent, ChangeEvent } from 'react';

interface TextInputProps {
    onSend: (text: string) => void;
    disabled?: boolean;
    value?: string;
    onChangeValue?: (v: string) => void;
}

export default function TextInput({ onSend, disabled, value: controlled, onChangeValue }: TextInputProps) {
    const [internal, setInternal] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    const value = controlled !== undefined ? controlled : internal;

    const setValue = (v: string) => {
        if (onChangeValue) onChangeValue(v);
        else setInternal(v);
    };

    const handleSend = () => {
        const trimmed = value.trim();
        if (!trimmed || disabled) return;
        onSend(trimmed);
        setValue('');
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
        setValue(e.target.value);
    };

    return (
        <div className="group relative flex items-center w-full transition-all duration-500">
            <input
                ref={inputRef}
                className="w-full rounded-full bg-white px-8 py-5 pr-16 text-sm text-ink placeholder-ink/30 outline-none border border-parchment shadow-sm transition-all focus:border-gold focus:ring-4 focus:ring-gold/10 disabled:opacity-50 serif"
                type="text"
                placeholder="Ask your concierge anything..."
                value={value}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                disabled={disabled}
                aria-label="Chat input"
            />
            <button
                className="absolute right-3 flex h-10 w-10 items-center justify-center rounded-full bg-ink text-white shadow-md transition-all hover:bg-gold hover:scale-110 active:scale-95 disabled:grayscale disabled:opacity-20 disabled:active:scale-100"
                onClick={handleSend}
                disabled={disabled || !value.trim()}
                aria-label="Send message"
            >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
            </button>
        </div>
    );
}
