import Groq from 'groq-sdk';
import { SYSTEM_PROMPT } from './prompt.js';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export async function chat(history, userMessage, today, state = {}) {
    const messages = [
        {
            role: 'system',
            content: `${SYSTEM_PROMPT}

IMPORTANT:
- You MUST respond in valid JSON.
- Always include the word "json" in your response.
- Output ONLY a JSON object.
`,
        },

        ...history.slice(-20).map((h) => ({
            role: h.role,
            content: h.content,
        })),

        {
            role: 'user',
            content: `
Today is ${today}

Current booking state (json):
${JSON.stringify(state)}

User message:
${userMessage}

Respond ONLY in JSON.
`,
        },
    ];

    const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages,
        temperature: 0.3,
        max_tokens: 500,
        response_format: { type: 'json_object' },
    });

    const raw = completion.choices[0].message.content;

    try {
        return JSON.parse(raw);
    } catch (err) {
        console.error('[LLM] Failed to parse Groq JSON response:', raw);

        return {
            message: "Sorry, something went wrong.",
            speak: "Please try again",
            intent: "unknown",
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