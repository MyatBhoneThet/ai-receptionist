'use client';

import { useState, useRef, useEffect } from 'react';
import styles from './VoiceInput.module.css';

/**
 * VoiceInput — microphone button using native Web Speech API
 * @param {{ onTranscript: (text: string) => void, disabled: boolean }} props
 */
export default function VoiceInput({ onTranscript, disabled }) {
    const [listening, setListening] = useState(false);
    const [supported, setSupported] = useState(false);
    const recognitionRef = useRef(null);

    useEffect(() => {
        const SpeechRecognition =
            window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SpeechRecognition) {
            setSupported(true);
            const recognition = new SpeechRecognition();
            recognition.lang = 'en-US';
            recognition.interimResults = false;
            recognition.maxAlternatives = 1;

            recognition.onresult = (event) => {
                const transcript = event.results[0][0].transcript;
                onTranscript(transcript);
                setListening(false);
            };

            recognition.onerror = (event) => {
                console.error('[SpeechRecognition] Error:', event.error);
                setListening(false);
            };

            recognition.onend = () => {
                setListening(false);
            };

            recognitionRef.current = recognition;
        }
    }, [onTranscript]);

    const toggle = () => {
        if (!recognitionRef.current || disabled) return;
        if (listening) {
            recognitionRef.current.stop();
            setListening(false);
        } else {
            recognitionRef.current.start();
            setListening(true);
        }
    };

    if (!supported) return null;

    return (
        <button
            className={`${styles.mic} ${listening ? styles.active : ''}`}
            onClick={toggle}
            disabled={disabled}
            title={listening ? 'Stop listening' : 'Start voice input'}
            aria-label={listening ? 'Stop listening' : 'Start voice input'}
        >
            <span className={styles.icon}>{listening ? '🔴' : '🎙️'}</span>
            {listening && <span className={styles.pulse} />}
        </button>
    );
}
