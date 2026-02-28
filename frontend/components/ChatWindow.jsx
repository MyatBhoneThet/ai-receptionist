'use client';

import { useEffect, useRef } from 'react';
import styles from './ChatWindow.module.css';

/**
 * ChatWindow — renders the scrollable message thread
 * @param {{ messages: Array<{role: string, content: string, speak?: string}> }} props
 */
export default function ChatWindow({ messages }) {
    const bottomRef = useRef(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    return (
        <div className={styles.window}>
            {messages.length === 0 && (
                <div className={styles.empty}>
                    <span>👋</span>
                    <p>Hi! I'm your AI receptionist. How can I help you today?</p>
                    <p className={styles.hint}>
                        Try: "Book a table for 2 tonight" or tap the mic to speak.
                    </p>
                </div>
            )}
            {messages.map((msg, i) => (
                <div
                    key={i}
                    className={`${styles.bubble} ${msg.role === 'user' ? styles.user : styles.assistant
                        }`}
                >
                    {msg.role === 'assistant' && (
                        <div className={styles.avatar}>🏨</div>
                    )}
                    <div className={styles.text}>{msg.content}</div>
                </div>
            ))}
            <div ref={bottomRef} />
        </div>
    );
}
