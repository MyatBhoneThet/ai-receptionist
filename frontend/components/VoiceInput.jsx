'use client';

import { useState, useRef, useEffect } from 'react';

export default function VoiceInput({ onTranscript, onInterimTranscript, disabled }) {
    const [listening, setListening] = useState(false);
    const [supported, setSupported] = useState(false);
    const recognitionRef = useRef(null);

    useEffect(() => {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SpeechRecognition) {
            setSupported(true);
            const recognition = new SpeechRecognition();
            recognition.lang = 'en-US';
            recognition.interimResults = true;
            recognition.maxAlternatives = 1;

            recognition.onresult = (event) => {
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

            recognition.onerror = (event) => {
                console.error('[SpeechRecognition] Error:', event.error);
                setListening(false);
            };

            recognition.onend = () => {
                setListening(false);
                if (onInterimTranscript) onInterimTranscript('');
            };

            recognitionRef.current = recognition;
        }
    }, [onTranscript]);

    const toggle = (e) => {
        e.preventDefault();
        if (!supported) {
            alert("Speech recognition not supported in this browser.");
            return;
        }
        if (!recognitionRef.current || disabled) return;

        try {
            if (listening) {
                recognitionRef.current.stop();
            } else {
                recognitionRef.current.start();
                setListening(true);
            }
        } catch (err) {
            console.error('[VoiceInput] Toggle error:', err);
            setListening(false);
        }
    };

    return (
        <button
            type="button"
            className={`relative flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl transition-all duration-300 ${listening
                    ? 'bg-rose-500 text-white shadow-[0_0_20px_rgba(244,63,94,0.4)]'
                    : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200 shadow-lg'
                } ${!supported ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} active:scale-95 disabled:opacity-50 disabled:grayscale`}
            onClick={toggle}
            disabled={disabled}
            title={!supported ? 'Speech recognition not supported' : (listening ? 'Stop listening' : 'Start voice input')}
            aria-label={listening ? 'Stop listening' : 'Start voice input'}
        >
            {listening && (
                <span className="absolute inset-0 animate-ping rounded-2xl bg-rose-500/40" />
            )}
            <span className="relative z-10 text-xl">
                {!supported ? '🚫' : (listening ? '⏹️' : '🎙️')}
            </span>
        </button>
    );
}

