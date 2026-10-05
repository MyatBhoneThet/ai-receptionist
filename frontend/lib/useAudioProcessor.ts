"use client";

import { useEffect, useState } from "react";

export interface AudioStats {
    volume: number;
    frequency: number[];
    isSpeaking: boolean;
}

const EMPTY_STATS: AudioStats = { volume: 0, frequency: [], isSpeaking: false };

export const useAudioProcessor = (isActive: boolean) => {
    const [stats, setStats] = useState<AudioStats>(EMPTY_STATS);

    useEffect(() => {
        if (!isActive) {
            setStats(EMPTY_STATS);
            return;
        }

        let cancelled = false;
        let stream: MediaStream | null = null;
        let context: AudioContext | null = null;
        let source: MediaStreamAudioSourceNode | null = null;
        let analyser: AnalyserNode | null = null;
        let frame: number | null = null;

        const stopAudio = () => {
            if (frame !== null) cancelAnimationFrame(frame);
            frame = null;
            stream?.getTracks().forEach((track) => track.stop());
            stream = null;
            source?.disconnect();
            analyser?.disconnect();
            source = null;
            analyser = null;
            if (context && context.state !== 'closed') void context.close().catch(() => {});
            context = null;
        };

        const startAudio = async () => {
            try {
                if (!navigator.mediaDevices?.getUserMedia) return;
                const requestedStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                // Permission can resolve after the utterance ends or the component unmounts.
                if (cancelled) {
                    requestedStream.getTracks().forEach((track) => track.stop());
                    return;
                }
                stream = requestedStream;
                const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
                if (!AudioContextClass) {
                    stopAudio();
                    return;
                }
                context = new AudioContextClass() as AudioContext;
                analyser = context.createAnalyser();
                analyser.fftSize = 256;
                analyser.smoothingTimeConstant = 0.7;
                source = context.createMediaStreamSource(stream);
                source.connect(analyser);
                if (context.state === 'suspended') await context.resume();
                if (cancelled || !analyser) return;

                const data = new Uint8Array(analyser.frequencyBinCount);
                const update = () => {
                    if (cancelled || !analyser) return;
                    analyser.getByteFrequencyData(data);
                    const average = data.reduce((sum, value) => sum + value, 0) / data.length;
                    const volume = Math.min(average / 128, 1);
                    setStats({ volume, frequency: Array.from(data).slice(0, 32), isSpeaking: volume > 0.05 });
                    frame = requestAnimationFrame(update);
                };
                update();
            } catch (error) {
                stopAudio();
                if (!cancelled) {
                    setStats(EMPTY_STATS);
                    console.error('[AudioProcessor] Microphone visualization unavailable:', error);
                }
            }
        };

        void startAudio();
        return () => {
            cancelled = true;
            stopAudio();
        };
    }, [isActive]);

    return stats;
};
