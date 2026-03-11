"use client";

import { useEffect, useRef, useState } from "react";

export interface AudioStats {
    volume: number;
    frequency: number[];
    isSpeaking: boolean;
}

export const useAudioProcessor = (isActive: boolean) => {
    const [stats, setStats] = useState<AudioStats>({ volume: 0, frequency: [], isSpeaking: false });
    const audioContextRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const animationFrameRef = useRef<number | null>(null);

    const SPEAKING_THRESHOLD = 0.05;

    useEffect(() => {
        const startAudio = async () => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                streamRef.current = stream;

                const context = new (window.AudioContext || (window as any).webkitAudioContext)();
                audioContextRef.current = context;

                const analyser = context.createAnalyser();
                analyser.fftSize = 256;
                analyserRef.current = analyser;

                const source = context.createMediaStreamSource(stream);
                source.connect(analyser);

                const bufferLength = analyser.frequencyBinCount;
                const dataArray = new Uint8Array(bufferLength);

                const update = () => {
                    if (!analyserRef.current) return;

                    analyserRef.current.getByteFrequencyData(dataArray);

                    let sum = 0;
                    for (let i = 0; i < bufferLength; i++) {
                        sum += dataArray[i];
                    }

                    const averageVolume = sum / bufferLength;
                    const normalizedVolume = averageVolume / 128;

                    setStats({
                        volume: normalizedVolume,
                        frequency: Array.from(dataArray).slice(0, 10),
                        isSpeaking: normalizedVolume > SPEAKING_THRESHOLD,
                    });

                    animationFrameRef.current = requestAnimationFrame(update);
                };

                update();
            } catch (err) {
                console.error("Error accessing microphone:", err);
            }
        };

        const stopAudio = () => {
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
            if (streamRef.current) {
                streamRef.current.getTracks().forEach((track) => track.stop());
            }
            if (audioContextRef.current) {
                audioContextRef.current.close();
            }
        };

        if (isActive) {
            startAudio();
        } else {
            stopAudio();
        }

        return () => stopAudio();
    }, [isActive]);

    return stats;
};
