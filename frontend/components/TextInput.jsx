'use client';

import { useState, useRef } from 'react';
import styles from './TextInput.module.css';

/**
 * TextInput — text fallback with send button
 * @param {{ onSend: (text: string) => void, disabled: boolean }} props
 */
export default function TextInput({ onSend, disabled }) {
    const [value, setValue] = useState('');
    const inputRef = useRef(null);

    const handleSend = () => {
        const trimmed = value.trim();
        if (!trimmed || disabled) return;
        onSend(trimmed);
        setValue('');
        inputRef.current?.focus();
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    return (
        <div className={styles.row}>
            <input
                ref={inputRef}
                className={styles.input}
                type="text"
                placeholder="Type a message..."
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={disabled}
                aria-label="Chat input"
            />
            <button
                className={styles.send}
                onClick={handleSend}
                disabled={disabled || !value.trim()}
                aria-label="Send message"
            >
                ➤
            </button>
        </div>
    );
}
