import Groq from 'groq-sdk';
import { SYSTEM_PROMPT } from './prompt.js';

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

function formatDate(date) {
    if (!date) return "";
    if (typeof date === 'string') return date;
    if (date instanceof Date) {
        const dd = String(date.getUTCDate()).padStart(2, '0');
        const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
        const yyyy = date.getUTCFullYear();
        return `${dd}-${mm}-${yyyy}`;
    }
    return String(date);
}

export async function chat(history, userMessage, today, state = {}, customerContext = "") {
    // Minimal state (token-efficient) - Ensure all dates are strings
    const minimalState = {
        service_type: state?.service_type || "",
        date: formatDate(state?.date),
        end_date: formatDate(state?.end_date),
        start_time: state?.start_time || "",
        end_time: state?.end_time || "",
        people: state?.people ?? null,
        reservation_name: state?.reservation_name || "",
        phone_number: state?.phone_number || "",
    };

    // Limit history safely
    const trimmedHistory = Array.isArray(history)
        ? history.slice(-10)
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
                customer_context: customerContext || "",
            }),
        },
    ];

    try {
        const { data: completion, response } = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',

            messages,

            temperature: 0.08,
            max_tokens: 500,

            response_format: { type: 'json_object' },
        }).withResponse();

        const remaining = response.headers.get('x-ratelimit-remaining-tokens');
        const limited = response.headers.get('x-ratelimit-limit-tokens');
        console.log(`[LLM] Rate Limit: ${remaining} / ${limited} tokens remaining`);


        const usage = completion?.usage;
        console.log(`[LLM] Request Usage: ${usage?.prompt_tokens} prompt, ${usage?.completion_tokens} completion, ${usage?.total_tokens} total tokens`);

        const raw = completion?.choices?.[0]?.message?.content;

        if (!raw) throw new Error('Empty LLM response');

        const parsed = JSON.parse(raw);

        // ✅ Enforce structure (very important)
        return {
            message: parsed.message || "",
            speak: parsed.speak || parsed.message || "",
            intent: parsed.intent || "unknown",
            data: {
                service_type: parsed.data?.service_type || state.service_type || "",
                date: formatDate(parsed.data?.date || state.date),
                end_date: formatDate(parsed.data?.end_date || state.end_date),
                start_time: parsed.data?.start_time || state.start_time || "",
                end_time: parsed.data?.end_time || state.end_time || "",
                people: parsed.data?.people ?? state.people ?? null,
                notes: parsed.data?.notes || state.notes || "",
                reservation_name: parsed.data?.reservation_name || state.reservation_name || "",
                phone_number: parsed.data?.phone_number || state.phone_number || "",
            },
            missing_fields: parsed.missing_fields || [],
            confidence: parsed.confidence ?? 0,
        };

    } catch (err) {
        console.error('[LLM] Error:', err.message);

        return {
            message: "Sorry, something went wrong. Let's try that again.",
            speak: "Sorry, something went wrong. Let's try that again.",
            intent: "unknown",
            data: {
                service_type: "",
                date: "",
                end_date: "",
                start_time: "",
                end_time: "",
                people: null,
                notes: "",
                reservation_name: "",
                phone_number: "",
            },
            missing_fields: [],
            confidence: 0,
        };
    }
}
