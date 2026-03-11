"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState, useMemo } from "react";
import { Mic, MicOff } from "lucide-react";
import { useAudioProcessor } from "../lib/useAudioProcessor";
import { useSpeechRecognition } from "../lib/useSpeechRecognition";

export const SpeechOrb = () => {
    const [isActive, setIsActive] = useState(false);
    const { volume, frequency, isSpeaking } = useAudioProcessor(isActive);
    const transcript = useSpeechRecognition(isActive);

    const borderRadius = useMemo(() => {
        if (!isSpeaking) return "50% 50% 50% 50%";

        const f0 = frequency[0] || 0;
        const f1 = frequency[1] || 0;
        const f2 = frequency[2] || 0;
        const f3 = frequency[3] || 0;

        const b1 = 45 + (f0 % 15);
        const b2 = 55 - (f1 % 15);
        const b3 = 65 + (f2 % 15);
        const b4 = 35 - (f3 % 15);

        return `${b1}% ${b2}% ${b3}% ${b4}% / ${b4}% ${b3}% ${b2}% ${b1}%`;
    }, [isSpeaking, frequency]);

    const orbColor = useMemo(() => {
        if (!isSpeaking) return "rgba(59, 130, 246, 0.5)";
        const intensity = Math.min(volume * 2, 1);
        const red = Math.floor(59 + intensity * 150);
        const green = Math.floor(130 - intensity * 100);
        const blue = 246;
        return `rgba(${red}, ${green}, ${blue}, ${0.6 + intensity * 0.4})`;
    }, [isSpeaking, volume]);

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-black text-white p-8">
            <div className="relative flex items-center justify-center scale-125 md:scale-150">
                <AnimatePresence>
                    {isSpeaking && (
                        <>
                            <motion.div
                                initial={{ opacity: 0, scale: 0.8 }}
                                animate={{
                                    opacity: [0.4, 0.8, 0.4],
                                    scale: [1, 1.1 + volume * 0.3, 1],
                                    borderColor: orbColor,
                                }}
                                exit={{ opacity: 0, scale: 0.5 }}
                                transition={{ duration: 0.2, repeat: Infinity }}
                                className="absolute -inset-4 rounded-full border-2 border-blue-500/50 blur-[2px]"
                            />
                            <motion.div
                                initial={{ scale: 1, opacity: 0.5 }}
                                animate={{ scale: 1.5 + volume * 0.5, opacity: 0 }}
                                transition={{ duration: 0.8, repeat: Infinity, ease: "easeOut" }}
                                className="absolute w-48 h-48 rounded-full border border-blue-400/30"
                            />
                        </>
                    )}
                </AnimatePresence>

                <motion.div
                    animate={{
                        borderRadius: borderRadius,
                        scale: isSpeaking ? 1.1 + volume * 0.4 : 1,
                        boxShadow: isSpeaking
                            ? `0 0 ${50 + volume * 150}px ${orbColor}`
                            : "0 0 30px rgba(59, 130, 246, 0.3)",
                    }}
                    transition={{
                        type: "spring",
                        stiffness: 260,
                        damping: 20,
                        mass: 0.5
                    }}
                    style={{
                        background: isSpeaking
                            ? `radial-gradient(circle at 30% 30%, #fff, ${orbColor})`
                            : "radial-gradient(circle at 30% 30%, #3b82f6, #1d4ed8)",
                    }}
                    className="w-40 h-40 flex items-center justify-center relative z-10 overflow-hidden shadow-2xl cursor-pointer"
                    onClick={() => setIsActive(!isActive)}
                >
                    <motion.div
                        animate={{
                            opacity: isSpeaking ? [0.4, 0.8, 0.4] : 0.2,
                            scale: isSpeaking ? [1, 1.2, 1] : 1,
                        }}
                        transition={{ duration: 1, repeat: Infinity }}
                        className="absolute inset-0 bg-white/20 blur-xl rounded-full"
                    />
                    {isActive ? <MicOff size={24} className="text-white/50" /> : <Mic size={24} className="text-white/50" />}
                </motion.div>
            </div>

            <div className="mt-24 w-full max-w-2xl text-center min-h-[4rem]">
                <motion.p
                    key={transcript}
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    className="text-2xl md:text-3xl font-medium text-white drop-shadow-lg tracking-tight"
                >
                    {isActive ? (transcript || "Listening...") : "Tap the orb to start"}
                </motion.p>
            </div>
        </div>
    );
};
