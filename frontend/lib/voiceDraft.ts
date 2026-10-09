/** Add another utterance to the editable draft without replacing typed text. */
export function appendVoiceTranscript(draft: string, transcript: string): string {
    const spoken = transcript.trim();
    if (!spoken) return draft;
    const separator = draft && !/\s$/.test(draft) ? ' ' : '';
    return `${draft}${separator}${spoken}`;
}
