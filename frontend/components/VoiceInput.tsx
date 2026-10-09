'use client';

import React, { useState, useRef, useEffect, MouseEvent } from 'react';
import { createSpeechSession, SpeechRecognitionLike } from '../lib/speechSession';

declare global {
    interface Window {
        SpeechRecognition: new () => SpeechRecognitionLike;
        webkitSpeechRecognition: new () => SpeechRecognitionLike;
    }
}

interface VoiceInputProps {
    onTranscript: (text: string) => void;
    onInterimTranscript?: (text: string) => void;
    onListeningChange?: (listening: boolean) => void;
    onError?: (message: string) => void;
    disabled?: boolean;
    lang?: string;
}

export default function VoiceInput(props: VoiceInputProps) {
    const { disabled = false, lang = 'en-US' } = props;
    const [listening, setListening] = useState(false);
    const [supported, setSupported] = useState(false);
    const callbacksRef = useRef(props);
    callbacksRef.current = props;
    const sessionRef = useRef<ReturnType<typeof createSpeechSession> | null>(null);

    useEffect(() => {
        setSupported(Boolean(window.SpeechRecognition || window.webkitSpeechRecognition));
        return () => {
            sessionRef.current?.dispose();
            sessionRef.current = null;
        };
    }, []);

    useEffect(() => {
        // Sending text or switching language ends the old session without a late transcript.
        sessionRef.current?.dispose();
        sessionRef.current = null;
    }, [disabled, lang]);

    const toggle = (event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        if (disabled || !supported) return;
        if (listening) {
            sessionRef.current?.stop();
            return;
        }

        sessionRef.current?.dispose();
        const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        // Avoid transcribing the concierge's speech as the next customer message.
        window.speechSynthesis?.cancel();
        const session = createSpeechSession(new Recognition(), {
            lang,
            onTranscript: (text) => callbacksRef.current.onTranscript(text),
            onInterimTranscript: (text) => callbacksRef.current.onInterimTranscript?.(text),
            onListeningChange: (next) => {
                setListening(next);
                callbacksRef.current.onListeningChange?.(next);
            },
            onEnd: () => {
                if (sessionRef.current === session) sessionRef.current = null;
            },
            onError: (error) => {
                const message = error === 'not-allowed' || error === 'service-not-allowed'
                    ? 'Microphone permission is needed for voice input. You can still type below.'
                    : error === 'no-speech'
                        ? 'No speech was detected. Tap the microphone to try again.'
                        : 'Voice input stopped. Please try again or type your message.';
                callbacksRef.current.onError?.(message);
            },
        });
        sessionRef.current = session;
        session.start();
    };

    return (
        <button
            type="button"
            className={`relative flex h-14 w-14 shrink-0 items-center justify-center rounded-full transition-all duration-500 overflow-hidden ${listening
                ? 'bg-gold text-ink shadow-lg'
                : 'bg-white text-ink border border-parchment hover:bg-parchment hover:border-gold hover:text-gold shadow-sm'
                } ${!supported ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} active:scale-95 disabled:opacity-50 disabled:grayscale`}
            onClick={toggle}
            onMouseDown={(event) => event.preventDefault()}
            disabled={disabled || !supported}
            title={!supported ? 'Speech recognition not supported' : (listening ? 'Stop listening' : 'Start voice input')}
            aria-label={listening ? 'Stop listening' : 'Start voice input'}
            aria-pressed={listening}
        >
            {listening && <span className="absolute inset-0 animate-ping bg-gold/40" />}
            <span className="relative z-10 text-xl">
                <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                </svg>
            </span>
        </button>
    );
}
