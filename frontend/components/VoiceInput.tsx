'use client';

import React, { useState, useRef, useEffect, MouseEvent } from 'react';

// Extend the Window interface to include SpeechRecognition
declare global {
    interface Window {
        SpeechRecognition: any;
        webkitSpeechRecognition: any;
    }
}

interface VoiceInputProps {
    onTranscript: (text: string) => void;
    onInterimTranscript?: (text: string) => void;
    onListeningChange?: (listening: boolean) => void;
    disabled?: boolean;
    lang?: string;
}

export default function VoiceInput({ onTranscript, onInterimTranscript, onListeningChange, disabled, lang = 'en-US' }: VoiceInputProps) {
    const [listening, setListening] = useState(false);
    const [supported, setSupported] = useState(false);
    const recognitionRef = useRef<any>(null);
    const keepListeningRef = useRef(false);
    const restartTimerRef = useRef<number | null>(null);

    useEffect(() => {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SpeechRecognition) {
            setSupported(true);
            const recognition = new SpeechRecognition();
            recognition.continuous = true;
            recognition.lang = lang;
            recognition.interimResults = true;
            recognition.maxAlternatives = 1;

            const clearRestartTimer = () => {
                if (restartTimerRef.current) {
                    window.clearTimeout(restartTimerRef.current);
                    restartTimerRef.current = null;
                }
            };

            const restartRecognition = () => {
                clearRestartTimer();
                restartTimerRef.current = window.setTimeout(() => {
                    if (!keepListeningRef.current || disabled) return;
                    try {
                        recognition.start();
                    } catch (err) {
                        console.error('[VoiceInput] Restart error:', err);
                        keepListeningRef.current = false;
                        setListening(false);
                        if (onListeningChange) onListeningChange(false);
                    }
                }, 250);
            };

            recognition.onresult = (event: any) => {
                let finalTranscript = '';
                let interimTranscript = '';
                for (let i = event.resultIndex; i < event.results.length; ++i) {
                    if (event.results[i].isFinal) {
                        finalTranscript += event.results[i][0].transcript;
                    } else {
                        interimTranscript += event.results[i][0].transcript;
                    }
                }
                if (finalTranscript) onTranscript(finalTranscript);
                if (onInterimTranscript) onInterimTranscript(interimTranscript);
            };

            recognition.onstart = () => {
                if (disabled) return;
                setListening(true);
                if (onListeningChange) onListeningChange(true);
            };

            recognition.onerror = (event: any) => {
                console.error('[SpeechRecognition] Error:', event.error);
                if (keepListeningRef.current && ['no-speech', 'aborted', 'network'].includes(event.error)) {
                    restartRecognition();
                    return;
                }
                clearRestartTimer();
                keepListeningRef.current = false;
                setListening(false);
                if (onListeningChange) onListeningChange(false);
            };

            recognition.onend = () => {
                if (onInterimTranscript) onInterimTranscript('');
                if (keepListeningRef.current && !disabled) {
                    restartRecognition();
                    return;
                }
                clearRestartTimer();
                setListening(false);
                if (onListeningChange) onListeningChange(false);
            };

            recognitionRef.current = recognition;

            return () => {
                keepListeningRef.current = false;
                if (restartTimerRef.current) {
                    window.clearTimeout(restartTimerRef.current);
                    restartTimerRef.current = null;
                }
                recognition.stop();
            };
        }
    }, [onTranscript, onInterimTranscript, onListeningChange, disabled, lang]);

    const toggle = (e: MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        if (!supported) {
            alert("Speech recognition not supported in this browser.");
            return;
        }
        if (!recognitionRef.current || disabled) return;

        try {
            if (listening) {
                keepListeningRef.current = false;
                recognitionRef.current.stop();
                setListening(false);
                if (onListeningChange) onListeningChange(false);
            } else {
                keepListeningRef.current = true;
                recognitionRef.current.start();
                setListening(true);
                if (onListeningChange) onListeningChange(true);
            }
        } catch (err) {
            console.error('[VoiceInput] Toggle error:', err);
            keepListeningRef.current = false;
            setListening(false);
        }
    };

    return (
        <button
            type="button"
            className={`relative flex h-14 w-14 shrink-0 items-center justify-center rounded-full transition-all duration-500 overflow-hidden ${listening
                ? 'bg-gold text-ink shadow-lg'
                : 'bg-white text-ink border border-parchment hover:bg-parchment hover:border-gold hover:text-gold shadow-sm'
                } ${!supported ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} active:scale-95 disabled:opacity-50 disabled:grayscale`}
            onClick={toggle}
            disabled={disabled}
            title={!supported ? 'Speech recognition not supported' : (listening ? 'Stop listening' : 'Start voice input')}
            aria-label={listening ? 'Stop listening' : 'Start voice input'}
        >
            {listening && (
                <span className="absolute inset-0 animate-ping bg-gold/40" />
            )}
            <span className="relative z-10 text-xl">
                 <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                </svg>
            </span>
        </button>
    );
}
