"use client";

import { useEffect, useRef, useState } from "react";

export const useSpeechRecognition = (isActive: boolean) => {
    const [transcript, setTranscript] = useState("");
    const recognitionRef = useRef<any>(null);
    const keepListeningRef = useRef(false);
    const restartTimerRef = useRef<number | null>(null);

    useEffect(() => {
        if (typeof window === "undefined") return;

        const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

        if (!SpeechRecognition) {
            console.error("Speech Recognition not supported in this browser.");
            return;
        }

        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = "en-US";

        const clearRestartTimer = () => {
            if (restartTimerRef.current) {
                window.clearTimeout(restartTimerRef.current);
                restartTimerRef.current = null;
            }
        };

        const restartRecognition = () => {
            clearRestartTimer();
            restartTimerRef.current = window.setTimeout(() => {
                if (!keepListeningRef.current) return;
                try {
                    recognition.start();
                } catch (err) {
                    console.error("[SpeechRecognition] Restart error:", err);
                    keepListeningRef.current = false;
                }
            }, 250);
        };

        recognition.onresult = (event: any) => {
            let currentTranscript = "";
            for (let i = event.resultIndex; i < event.results.length; i++) {
                currentTranscript += event.results[i][0].transcript;
            }
            setTranscript(currentTranscript);
        };

        recognition.onstart = () => {
            keepListeningRef.current = true;
        };

        recognition.onend = () => {
            if (isActive && keepListeningRef.current) {
                restartRecognition();
                return;
            }
            clearRestartTimer();
        };

        recognitionRef.current = recognition;

        if (isActive) {
            keepListeningRef.current = true;
            recognition.start();
        } else {
            keepListeningRef.current = false;
            clearRestartTimer();
            recognition.stop();
        }

        return () => {
            keepListeningRef.current = false;
            clearRestartTimer();
            recognition.stop();
        };
    }, [isActive]);

    return transcript;
};
