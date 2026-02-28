'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import ChatWindow from '../components/ChatWindow';
import VoiceInput from '../components/VoiceInput';
import TextInput from '../components/TextInput';
import BookingSummary from '../components/BookingSummary';
import ConfirmModal from '../components/ConfirmModal';
import { sendMessage } from '../lib/api';
import styles from './page.module.css';

/**
 * Speak a string using Web Speech Synthesis
 */
function speakText(text) {
    if (!window.speechSynthesis || !text) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.pitch = 1;
    utterance.volume = 1;
    window.speechSynthesis.speak(utterance);
}

export default function Page() {
    const [sessionId] = useState(() => {
        if (typeof window !== 'undefined') {
            const stored = localStorage.getItem('ai_receptionist_session');
            if (stored) return stored;
            const newId = uuidv4();
            localStorage.setItem('ai_receptionist_session', newId);
            return newId;
        }
        return uuidv4();
    });

    const [messages, setMessages] = useState([]);
    const [loading, setLoading] = useState(false);
    const [currentData, setCurrentData] = useState(null);
    const [currentIntent, setCurrentIntent] = useState('');
    const [missingFields, setMissingFields] = useState([]);
    const [confidence, setConfidence] = useState(0);
    const [showConfirm, setShowConfirm] = useState(false);
    const isSpeakingRef = useRef(false);

    const handleSend = useCallback(async (text) => {
        if (!text.trim() || loading) return;

        // Append user message immediately
        setMessages((prev) => [...prev, { role: 'user', content: text }]);
        setLoading(true);

        try {
            const response = await sendMessage(sessionId, text);

            // Append assistant response
            setMessages((prev) => [...prev, { role: 'assistant', content: response.message }]);

            // Update booking state
            setCurrentData(response.data);
            setCurrentIntent(response.intent);
            setMissingFields(response.missing_fields || []);
            setConfidence(response.confidence);

            // Speak the response
            if (response.speak) {
                isSpeakingRef.current = true;
                speakText(response.speak);
            }

            // Show confirm modal if all fields collected and intent is bookable
            const bookable = ['book_restaurant', 'book_hotel', 'book_meeting'];
            if (
                bookable.includes(response.intent) &&
                (!response.missing_fields || response.missing_fields.length === 0)
            ) {
                // Small delay so user reads the confirmation message first
                setTimeout(() => setShowConfirm(true), 800);
            }
        } catch (err) {
            console.error('[handleSend] Error:', err);
            setMessages((prev) => [
                ...prev,
                { role: 'assistant', content: "Sorry, something went wrong. Please try again." },
            ]);
            speakText("Sorry, something went wrong.");
        } finally {
            setLoading(false);
        }
    }, [loading, sessionId]);

    const handleVoiceTranscript = useCallback((text) => {
        handleSend(text);
    }, [handleSend]);

    const handleConfirmed = () => {
        setShowConfirm(false);
        setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: '✅ Your booking is confirmed! Is there anything else?' },
        ]);
        speakText('All done! Your booking is confirmed.');
        setCurrentData(null);
        setCurrentIntent('');
        setMissingFields([]);
    };

    const handleCancelConfirm = () => {
        setShowConfirm(false);
        setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: "No problem! What would you like to change?" },
        ]);
        speakText("No problem. What would you like to change?");
    };

    return (
        <main className={styles.main}>
            {/* Sidebar — booking summary */}
            <aside className={styles.sidebar}>
                <div className={styles.logo}>
                    <span>🏨</span>
                    <div>
                        <div className={styles.logoTitle}>AI Receptionist</div>
                        <div className={styles.logoSub}>Hotel & Restaurant</div>
                    </div>
                </div>

                <BookingSummary
                    data={currentData}
                    missing_fields={missingFields}
                    intent={currentIntent}
                    confidence={confidence}
                />

                {currentData && (
                    <button
                        className={styles.reset}
                        onClick={() => {
                            localStorage.removeItem('ai_receptionist_session');
                            window.location.reload();
                        }}
                    >
                        New Booking
                    </button>
                )}
            </aside>

            {/* Main chat panel */}
            <section className={styles.chat}>
                <header className={styles.header}>
                    <div className={styles.status}>
                        <span className={`${styles.dot} ${loading ? styles.loading : styles.online}`} />
                        {loading ? 'Thinking...' : 'Online'}
                    </div>
                </header>

                <ChatWindow messages={messages} />

                <footer className={styles.footer}>
                    <VoiceInput onTranscript={handleVoiceTranscript} disabled={loading} />
                    <TextInput onSend={handleSend} disabled={loading} />
                </footer>
            </section>

            {/* Confirm modal */}
            {showConfirm && (
                <ConfirmModal
                    sessionId={sessionId}
                    summary={currentData}
                    onConfirm={handleConfirmed}
                    onCancel={handleCancelConfirm}
                />
            )}
        </main>
    );
}
