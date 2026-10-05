'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import ChatWindow from '../components/ChatWindow';
import VoiceInput from '../components/VoiceInput';
import TextInput from '../components/TextInput';
import BookingSummary from '../components/BookingSummary';
import ConfirmModal from '../components/ConfirmModal';
import ThinkingOrb from '../components/ThinkingOrb';
import { sendMessage, ChatResponse, BookingData, ConfirmBookingResponse } from '../lib/api';

/**
 * Speak a string using Web Speech Synthesis
 */
function speakText(text: string): void {
    if (typeof window === 'undefined' || !window.speechSynthesis || !text) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);

    utterance.rate = 0.96;
    utterance.pitch = 1.45;
    utterance.volume = 0.98;

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

interface Message {
    role: 'user' | 'assistant';
    content: string;
}

export default function Page() {
    const [sessionId, setSessionId] = useState<string>('');
    const [sessionToken, setSessionToken] = useState<string>('');

    useEffect(() => {
        const stored = localStorage.getItem('ai_receptionist_session');
        const storedToken = localStorage.getItem('ai_receptionist_session_token');
        if (stored) {
            setSessionId(stored);
            if (storedToken) setSessionToken(storedToken);
        } else {
            const newId = uuidv4();
            localStorage.setItem('ai_receptionist_session', newId);
            setSessionId(newId);
        }
    }, []);

    const [messages, setMessages] = useState<Message[]>([]);
    const [loading, setLoading] = useState<boolean>(false);
    const [currentData, setCurrentData] = useState<BookingData | null>(null);
    const [currentIntent, setCurrentIntent] = useState<string>('');
    const [missingFields, setMissingFields] = useState<string[]>([]);
    const [confidence, setConfidence] = useState<number>(0);
    const [showConfirm, setShowConfirm] = useState<boolean>(false);
    const [interimTranscript, setInterimTranscript] = useState<string>('');
    const [isListening, setIsListening] = useState<boolean>(false);
    const [speechError, setSpeechError] = useState<string>('');
    const [inputValue, setInputValue] = useState<string>('');
    const [speechLang, setSpeechLang] = useState<string>('en-US');

    const handleSend = useCallback(async (text: string) => {
        if (!text.trim() || loading) return;

        setMessages((prev) => [...prev, { role: 'user', content: text }]);
        setInterimTranscript('');
        setLoading(true);

        try {
            const response: ChatResponse = await sendMessage(sessionId, text);
            if (response.session_token) {
                setSessionToken(response.session_token);
                localStorage.setItem('ai_receptionist_session_token', response.session_token);
            }
            setMessages((prev) => [...prev, { role: 'assistant', content: response.message }]);
            // attach availability to data for UI
            const mergedData = response.data ? { ...response.data, availability: response.availability } : response.data;
            setCurrentData(mergedData);
            const hasReservation = Boolean(response.data?.id || response.data?.edit_booking_id)
                && response.data?.modify_step !== 'awaiting_lookup';
            setCurrentIntent(response.show_reservation_slip && hasReservation ? 'reservation_slip' : response.intent);
            setMissingFields(response.missing_fields || []);
            setConfidence(response.confidence);

            if (response.speak) {
                speakText(response.speak);
            }

            const bookable = ['book_restaurant', 'book_hotel', 'book_meeting'];
            if (bookable.includes(response.intent) && (!response.missing_fields || response.missing_fields.length === 0)) {
                setTimeout(() => setShowConfirm(true), 800);
            }

            // @ts-ignore
            if (response.show_cancel_confirm) {
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

    const handleVoiceTranscript = useCallback((text: string) => {
        setInterimTranscript('');
        setInputValue(text);
    }, []);

    const handleTextSend = useCallback((text: string) => {
        handleSend(text);
    }, [handleSend]);

    const handleConfirmed = (response: ConfirmBookingResponse) => {
        const isCancel = currentIntent === 'cancel_booking' || currentIntent === 'cancel';
        setShowConfirm(false);
        const confirmMsg = response.message || (isCancel
            ? '🗑️ Your booking has been cancelled. Is there anything else I can help with?'
            : 'Your booking is confirmed! Have a nice day!');
        if (response.session_token) {
            setSessionToken(response.session_token);
            localStorage.setItem('ai_receptionist_session_token', response.session_token);
        }
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
        <>
            <main className="flex h-screen w-full overflow-hidden bg-parchment">
                {/* 1. Left Sidebar — Brand & Identity */}
                <aside className="hidden w-72 flex-col border-r border-parchment material-parchment p-8 lg:flex">
                    <div className="mb-12 flex flex-col items-center text-center">
                        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-white shadow-sm border border-parchment">
                            <span className="text-3xl">🏨</span>
                        </div>
                        <h1 className="text-2xl font-bold tracking-tight text-ink serif lowercase">
                            Lumière <span className="text-xs absolute -mt-1 ml-1 opacity-50 not-italic">AI</span>
                        </h1>
                        <p className="mt-1 text-[10px] font-bold tracking-widest text-gold uppercase">
                            Grand Concierge
                        </p>
                    </div>

                    <nav className="flex-1 space-y-6">
                        <section>
                            <h3 className="text-[10px] font-bold uppercase tracking-widest text-ink/40 mb-3 ml-2">Services</h3>
                            <div className="space-y-1">
                                <div 
                                    className="flex items-center space-x-3 rounded-lg px-3 py-2 text-sm font-medium text-ink transition hover:bg-white leading-none group cursor-pointer"
                                    onClick={() => handleTextSend("I'd like to book a hotel room")}
                                >
                                    <span className="opacity-50 group-hover:opacity-100 serif">01.</span>
                                    <span>Hotel Rooms</span>
                                </div>
                                <div 
                                    className="flex items-center space-x-3 rounded-lg px-3 py-2 text-sm font-medium text-ink transition hover:bg-white leading-none group cursor-pointer"
                                    onClick={() => handleTextSend("I'd like to book a table at the restaurant")}
                                >
                                    <span className="opacity-50 group-hover:opacity-100 serif">02.</span>
                                    <span>Restaurant</span>
                                </div>
                                <div 
                                    className="flex items-center space-x-3 rounded-lg px-3 py-2 text-sm font-medium text-ink transition hover:bg-white leading-none group cursor-pointer"
                                    onClick={() => handleTextSend("I'd like to book a meeting room")}
                                >
                                    <span className="opacity-50 group-hover:opacity-100 serif">03.</span>
                                    <span>Meetings</span>
                                </div>
                            </div>
                        </section>
                    </nav>

                    <div className="pt-8 mt-auto border-t border-parchment">
                        <p className="text-[10px] text-ink/40 leading-relaxed">
                            "Excellence is not an act, but a habit."
                        </p>
                    </div>
                </aside>

                {/* 2. Center Stage — Main Chat Window */}
                <section className="relative flex flex-1 flex-col overflow-hidden">
                    <header className="flex h-20 items-center justify-between border-b border-parchment bg-white/40 px-8 backdrop-blur-md">
                        <div className="flex items-center space-x-4">
                            <div className="relative">
                                <div className="h-10 w-10 rounded-full bg-paper flex items-center justify-center text-sm border border-parchment overflow-hidden">
                                     <img src="https://api.dicebear.com/7.x/notionists/svg?seed=Anya&backgroundColor=f9f7f2" alt="Concierge" />
                                </div>
                                <div className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-white ${loading ? 'bg-amber-400' : 'bg-emerald-500'}`} />
                            </div>
                            <div>
                                <h2 className="text-sm font-bold text-ink leading-tight">Lady Anya</h2>
                                <p className="text-[10px] font-medium text-gold uppercase tracking-tighter">Receptionist</p>
                            </div>
                        </div>

                        <div className="flex items-center space-x-2 lg:hidden">
                             <span className="text-lg serif font-bold">Lumière</span>
                        </div>
                    </header>

                    <div className="flex-1 overflow-hidden relative">
                        <ChatWindow messages={messages} />
                    </div>

                    <footer className="shrink-0 p-4 sm:p-6 lg:p-8 bg-gradient-to-t from-white/80 to-transparent">
                        <div className="mx-auto max-w-3xl">
                            <ThinkingOrb isThinking={loading || isListening} isListening={isListening} />
                            {interimTranscript && (
                                <div className="flex items-center space-x-3 px-4 py-2 mb-4 rounded-full bg-white/60 border border-parchment animate-fade-in shadow-sm">
                                    <span className="h-1.5 w-1.5 rounded-full bg-gold animate-pulse" />
                                    <span className="text-xs text-ink/60 font-light truncate">
                                        "{interimTranscript}..."
                                    </span>
                                </div>
                            )}
                            <div className="flex items-center space-x-4">
                                <VoiceInput
                                    onTranscript={handleVoiceTranscript}
                                    onInterimTranscript={setInterimTranscript}
                                    onListeningChange={(next) => {
                                        setIsListening(next);
                                        if (next) setSpeechError('');
                                    }}
                                    onError={setSpeechError}
                                    disabled={loading}
                                    lang={speechLang}
                                />
                                <div className="min-w-0 flex-1 space-y-3">
                                    <div className="flex items-center gap-2">
                                        <label htmlFor="speech-language" className="text-[10px] font-bold uppercase tracking-widest text-ink/50">Voice lang</label>
                                        <select
                                            id="speech-language"
                                            className="rounded-full border border-parchment bg-white px-3 py-1 text-xs text-ink/70"
                                            value={speechLang}
                                            onChange={(e) => setSpeechLang(e.target.value)}
                                        >
                                            <option value="en-US">English (US)</option>
                                            <option value="es-ES">Español</option>
                                            <option value="fr-FR">Français</option>
                                            <option value="th-TH">ไทย</option>
                                        </select>
                                    </div>
                                    <TextInput onSend={handleTextSend} disabled={loading} value={inputValue} onChangeValue={setInputValue} />
                                </div>
                            </div>
                            {speechError && <p className="mt-3 text-xs text-ink/70" role="alert">{speechError}</p>}
                        </div>
                    </footer>
                </section>

                {/* 3. Right Sidebar — Summary & Stats */}
                <aside className="hidden w-96 flex-col border-l border-parchment material-parchment p-8 xl:flex">
                     <div className="flex-1 overflow-y-auto custom-scrollbar pr-1">
                        <BookingSummary
                            data={currentData}
                            missing_fields={missingFields}
                            intent={currentIntent}
                            confidence={confidence}
                            sessionId={sessionId}
                            sessionToken={sessionToken}
                            availability={(currentData as any)?.availability}
                            onSuggestDate={(date) => handleTextSend(`Please move my booking to ${date}`)}
                        />

                    </div>

                    <div className="mt-8">
                         <button
                            className="w-full flex items-center justify-center space-x-2 rounded-full border border-ink/10 p-4 text-xs font-bold text-ink/60 transition-all hover:bg-ink hover:text-white"
                            onClick={() => {
                                localStorage.removeItem('ai_receptionist_session');
                                localStorage.removeItem('ai_receptionist_session_token');
                                window.location.reload();
                            }}
                        >
                            <span>Clear Conversation</span>
                        </button>
                    </div>
                </aside>

                {/* Confirm modal */}
                {showConfirm && (
                <ConfirmModal
                    sessionId={sessionId}
                    sessionToken={sessionToken}
                    summary={currentData}
                    intent={currentIntent}
                    onConfirm={handleConfirmed}
                        onCancel={handleCancelConfirm}
                    />
                )}
            </main>
        </>
    );
}
