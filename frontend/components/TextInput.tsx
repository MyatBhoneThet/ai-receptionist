'use client';

import React, { useState, useRef, useEffect, KeyboardEvent, ChangeEvent } from 'react';

interface TextInputProps {
    onSend: (text: string) => void;
    disabled?: boolean;
    value?: string;
    onChangeValue?: (v: string) => void;
    focusRequest?: number;
}

export default function TextInput({ onSend, disabled, value: controlled, onChangeValue, focusRequest = 0 }: TextInputProps) {
    const [internal, setInternal] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    const value = controlled !== undefined ? controlled : internal;

    useEffect(() => {
        if (disabled) return;
        const input = inputRef.current;
        input?.focus({ preventScroll: true });
        if (input) input.setSelectionRange(input.value.length, input.value.length);
    }, [disabled, focusRequest]);

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
                className="h-14 w-full rounded-full bg-white px-8 py-4 pr-16 text-sm text-ink placeholder-ink/30 outline-none border border-parchment shadow-sm transition-all focus:border-gold focus:ring-4 focus:ring-gold/10 disabled:opacity-50 serif"
                type="text"
                placeholder="Ask your concierge anything..."
                value={value}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                disabled={disabled}
                aria-label="Chat input"
                autoFocus
            />
            <button
                type="button"
                className="absolute right-3 flex h-10 w-10 items-center justify-center rounded-full bg-ink text-white shadow-md transition-all hover:bg-gold hover:scale-110 active:scale-95 disabled:grayscale disabled:opacity-20 disabled:active:scale-100"
                onClick={handleSend}
                onMouseDown={(event) => event.preventDefault()}
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
