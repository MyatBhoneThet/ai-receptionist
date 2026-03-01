'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import ChatWindow from '../components/ChatWindow';
import VoiceInput from '../components/VoiceInput';
import TextInput from '../components/TextInput';
import BookingSummary from '../components/BookingSummary';
import ConfirmModal from '../components/ConfirmModal';
import { sendMessage } from '../lib/api';

/**
 * Speak a string using Web Speech Synthesis
 */
function speakText(text) {
    if (!window.speechSynthesis || !text) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);

    utterance.rate = 1;
    utterance.pitch = 1.3;
    utterance.volume = 1.0;

    const getBestVoice = () => {
        const voices = window.speechSynthesis.getVoices();
        const priorityPatterns = ['Siri', 'Google US English Female', 'Samantha', 'Victoria', 'Female', 'en-US'];
        for (const pattern of priorityPatterns) {
            const found = voices.find(v => v.name.includes(pattern) && !v.name.includes('Low Quality'));
            if (found) return found;
        }
        return voices[0];
    };

    const bestVoice = getBestVoice();
    if (bestVoice) utterance.voice = bestVoice;
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
    const [interimTranscript, setInterimTranscript] = useState('');
    const isSpeakingRef = useRef(false);

    const handleSend = useCallback(async (text) => {
        if (!text.trim() || loading) return;

        setMessages((prev) => [...prev, { role: 'user', content: text }]);
        setInterimTranscript('');
        setLoading(true);

        try {
            const response = await sendMessage(sessionId, text);
            setMessages((prev) => [...prev, { role: 'assistant', content: response.message }]);
            setCurrentData(response.data);
            setCurrentIntent(response.intent);
            setMissingFields(response.missing_fields || []);
            setConfidence(response.confidence);

            if (response.speak) {
                isSpeakingRef.current = true;
                speakText(response.speak);
            }

            const bookable = ['book_restaurant', 'book_hotel', 'book_meeting'];
            if (bookable.includes(response.intent) && (!response.missing_fields || response.missing_fields.length === 0)) {
                setTimeout(() => setShowConfirm(true), 800);
            }
        } catch (err) {
            console.error('[handleSend] Error:', err);
            const errorMsg = "Sorry, something went wrong. Please try again.";
            setMessages((prev) => [...prev, { role: 'assistant', content: errorMsg }]);
            speakText(errorMsg);
        } finally {
            setLoading(false);
        }
    }, [loading, sessionId]);

    const handleVoiceTranscript = useCallback((text) => {
        setInterimTranscript('');
        handleSend(text);
    }, [handleSend]);

    const handleConfirmed = () => {
        setShowConfirm(false);
        const confirmMsg = '✅ Your booking is confirmed! Is there anything else?';
        setMessages((prev) => [...prev, { role: 'assistant', content: confirmMsg }]);
        speakText(confirmMsg);
        setCurrentData(null);
        setCurrentIntent('');
        setMissingFields([]);
    };

    const handleCancelConfirm = () => {
        setShowConfirm(false);
        const cancelMsg = "No problem! What would you like to change?";
        setMessages((prev) => [...prev, { role: 'assistant', content: cancelMsg }]);
        speakText(cancelMsg);
    };

    return (
        <main className="flex h-screen w-full overflow-hidden bg-slate-950">
            {/* Sidebar — booking summary */}
            <aside className="hidden w-80 flex-col border-r border-slate-800/50 bg-slate-900/50 p-6 lg:flex">
                <div className="mb-8 flex items-center space-x-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-600 shadow-lg shadow-primary-500/20">
                        <span className="text-xl">🏨</span>
                    </div>
                    <div>
                        <h1 className="text-lg font-bold tracking-tight text-white">AI Receptionist</h1>
                        <p className="text-xs font-medium text-slate-400">Hotel & Restaurant</p>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto">
                    <BookingSummary
                        data={currentData}
                        missing_fields={missingFields}
                        intent={currentIntent}
                        confidence={confidence}
                    />
                </div>

                {currentData && (
                    <button
                        className="group mt-6 flex items-center justify-center space-x-2 rounded-xl bg-slate-800 p-3 text-sm font-semibold text-slate-300 transition-all hover:bg-slate-700 hover:text-white"
                        onClick={() => {
                            localStorage.removeItem('ai_receptionist_session');
                            window.location.reload();
                        }}
                    >
                        <span>New Booking</span>
                    </button>
                )}
            </aside>

            {/* Main chat panel */}
            <section className="relative flex flex-1 flex-col bg-glow overflow-hidden">
                <header className="flex h-20 items-center justify-between border-b border-slate-800/50 bg-slate-900/40 px-8 backdrop-blur-md">
                    <div className="flex items-center space-x-3">
                        <div className={`h-2.5 w-2.5 rounded-full ${loading ? 'animate-pulse bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]' : 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]'}`} />
                        <span className="text-sm font-semibold tracking-wide text-slate-200 uppercase">
                            {loading ? 'Thinking...' : 'Online Assistant'}
                        </span>
                    </div>

                    <div className="lg:hidden text-lg font-bold text-white">🏨 AI Receptionist</div>
                </header>

                <div className="flex-1 overflow-hidden relative">
                    <ChatWindow messages={messages} />
                </div>

                <footer className="p-6 bg-slate-900/40 backdrop-blur-xl border-t border-slate-800/50">
                    <div className="mx-auto max-w-4xl space-y-4">
                        {interimTranscript && (
                            <div className="flex items-center space-x-3 px-4 py-2 rounded-full glass-dark animate-fade-in">
                                <span className="h-2 w-2 rounded-full bg-primary-500 animate-pulse" />
                                <span className="text-sm italic text-slate-300 truncate font-light">
                                    "{interimTranscript}..."
                                </span>
                            </div>
                        )}
                        <div className="flex items-center space-x-4">
                            <VoiceInput
                                onTranscript={handleVoiceTranscript}
                                onInterimTranscript={setInterimTranscript}
                                disabled={loading}
                            />
                            <div className="flex-1">
                                <TextInput onSend={handleSend} disabled={loading} />
                            </div>
                        </div>
                    </div>
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

