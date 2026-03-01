import Groq from 'groq-sdk';
import { SYSTEM_PROMPT } from './prompt.js';

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

export async function chat(history, userMessage, today, state = {}) {
    // Minimal state (token-efficient)
    const minimalState = {
        service_type: state?.service_type || "",
        date: state?.date || "",
        start_time: state?.start_time || "",
        end_time: state?.end_time || "",
        people: state?.people ?? null,
        location: state?.location || "",
    };

    // Limit history safely
    const trimmedHistory = Array.isArray(history)
        ? history.slice(-4)
        : [];

    const messages = [
        {
            role: 'system',
            content: SYSTEM_PROMPT,
        },
        ...trimmedHistory.map((h) => ({
            role: h.role,
            content: h.content,
        })),
        {
            role: 'user',
            content: JSON.stringify({
                today,
                state: minimalState,
                message: userMessage,
            }),
        },
    ];

    try {
        const completion = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',

            messages,

            temperature: 0.2, // slightly more stable for structured output
            max_tokens: 150,  // small bump for safer JSON completion

            response_format: { type: 'json_object' },
        });

        const raw = completion?.choices?.[0]?.message?.content;

        if (!raw) throw new Error('Empty LLM response');

        const parsed = JSON.parse(raw);

        // ✅ Enforce structure (very important)
        return {
            message: parsed.message || "",
            speak: parsed.speak || parsed.message || "",
            intent: parsed.intent || "unknown",
            data: {
                service_type: parsed.data?.service_type || "",
                date: parsed.data?.date || "",
                start_time: parsed.data?.start_time || "",
                end_time: parsed.data?.end_time || "",
                people: parsed.data?.people ?? null,
                location: parsed.data?.location || "",
                notes: parsed.data?.notes || "",
            },
            missing_fields: parsed.missing_fields || [],
            confidence: parsed.confidence ?? 0,
        };

    } catch (err) {
        console.error('[LLM] Error:', err.message);

        return {
            message: "Sorry, something went wrong. Let's try that again.",
            speak: "Sorry, something went wrong. Let's try that again.",
            intent: "error",
            data: {
                service_type: "",
                date: "",
                start_time: "",
                end_time: "",
                people: null,
                location: "",
                notes: "",
            },
            missing_fields: [],
            confidence: 0,
        };
    }
}