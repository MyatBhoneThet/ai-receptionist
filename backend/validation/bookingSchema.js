import { z } from 'zod';

export const BookingResponseSchema = z.object({
    message: z.string().default(""),
    speak: z.string().default(""),

    intent: z.enum([
        'book_restaurant',
        'book_hotel',
        'book_meeting',
        'check_availability',
        'modify_booking',
        'cancel_booking',
        'greeting',
        'unknown',
    ]).default('unknown'),

    data: z.object({
        service_type: z.string().default(""),
        date: z.string().default(""),
        start_time: z.string().default(""),
        end_time: z.string().default(""),
        people: z.number().nullable().optional(),
        location: z.string().default(""),
        notes: z.string().default(""),
    }).default({}),

    missing_fields: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1).default(0.5),
});

export function validateBookingResponse(raw) {
    const result = BookingResponseSchema.safeParse(raw);

    if (!result.success) {
        console.error('[Validation] LLM response failed schema:', result.error.flatten());

        return {
            success: false,
            data: {
                message: "Sorry, I didn't understand that.",
                speak: "Sorry, I didn't understand that. Can you repeat?",
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
            },
        };
    }

    return {
        success: true,
        data: result.data,
    };
}