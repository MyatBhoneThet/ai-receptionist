"use client";

import { useEffect, useRef, useState } from "react";
import { createSpeechSession, SpeechRecognitionLike } from './speechSession';

export const useSpeechRecognition = (isActive: boolean, onEnd?: () => void) => {
    const [transcript, setTranscript] = useState('');
    const onEndRef = useRef(onEnd);
    onEndRef.current = onEnd;

    useEffect(() => {
        if (!isActive) return;
        const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!Recognition) {
            onEndRef.current?.();
            return;
        }
        setTranscript('');
        const session = createSpeechSession(new Recognition() as SpeechRecognitionLike, {
            lang: 'en-US',
            onTranscript: setTranscript,
            onInterimTranscript: (text) => { if (text) setTranscript(text); },
            onListeningChange: () => {},
            onEnd: () => onEndRef.current?.(),
        });
        session.start();
        return () => session.dispose();
    }, [isActive]);

    return transcript;
};
