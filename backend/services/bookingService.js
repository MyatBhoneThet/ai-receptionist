const SERVICE_TOKENS = /\b(?:meeting(?:\s+rooms?)?s?|conference(?:\s+rooms?)?s?|boardrooms?|hotel(?:\s+rooms?)?s?|restaurants?|dining(?:\s+rooms?)?|accommodation|suites?|dinner|lunch|breakfast|tables?|rooms?|stay)\b/g;
const TYPE_LABEL = /\b(?:type(?:\s+of\s+(?:(?:the|my|a)\s+)?(?:reservation|booking))?|(?:reservation|booking)(?:\s+type)?|service(?:\s+type)?)\s*(?:is|are|:|=|should be|will be|would be|to)\s*(?:(?:a|an|the)\s+)?$/;

function classify(token) {
    if (/^(meeting|conference|boardroom)/.test(token)) return { type: 'meeting', rank: /room/.test(token) ? 3.5 : 3 };
    if (/^hotel|^accommodation/.test(token)) return { type: 'hotel', rank: /room/.test(token) ? 3.5 : 3 };
    if (/^restaurant/.test(token)) return { type: 'restaurant', rank: 3 };
    if (/^(dining|dinner|lunch|breakfast)/.test(token)) return { type: 'restaurant', rank: 2 };
    if (/^suite/.test(token)) return { type: 'hotel', rank: 2 };
    return { type: /^table/.test(token) ? 'restaurant' : 'hotel', rank: 1 };
}

/** Resolve declared types and corrections before incidental room/table words. */
export function resolveBookingService(message) {
    const text = String(message || '').toLowerCase().replace(/[’]/g, "'");
    const mentions = [];
    for (const match of text.matchAll(SERVICE_TOKENS)) {
        const prefix = text.slice(0, match.index);
        const previous = mentions.at(-1);
        const between = previous ? text.slice(previous.end, match.index) : '';
        const alternative = /^\s*(?:or|and|nor|\/)\s*(?:(?:a|an|the)\s+)?$/.test(between);
        const negated = /\b(?:not|no|neither|nor|instead of|rather than|isn't|aren't|wasn't|weren't|(?:don't|do not|doesn't|does not)\s+(?:want|need|mean)(?:\s+to\s+(?:book|reserve))?)\s*(?:(?:a|an|the)\s+)?$/.test(prefix)
            || (previous?.negated && alternative);
        const labelled = TYPE_LABEL.test(prefix)
            || (previous?.labelled && alternative);
        const correction = /\b(?:actually|instead|i mean|rather|correction(?: is)?|should be)\s*[,:\s]*(?:(?:a|an|the)\s+)?$/.test(prefix)
            || /\b(?:change|switch|correct|make|set)\b[^.!?]*\b(?:to|into|as)\s*(?:(?:a|an|the)\s+)?$/.test(prefix);
        const { type, rank } = classify(match[0]);
        const priority = correction ? 5 : (labelled ? 4 : rank);
        const alternativePriority = alternative && previous && !previous.negated && !negated
            ? Math.max(previous.rank, priority) : priority;
        if (alternative && previous && !previous.negated && !negated) previous.rank = alternativePriority;
        mentions.push({
            type, end: match.index + match[0].length, negated, labelled,
            rank: alternativePriority,
        });
    }
    const positive = mentions.filter((mention) => !mention.negated);
    const strongest = Math.max(0, ...positive.map((mention) => mention.rank));
    const candidates = [...new Set(positive.filter((mention) => mention.rank === strongest).map((mention) => mention.type))];
    return {
        service_type: candidates.length === 1 ? candidates[0] : '',
        candidates,
        ambiguous: candidates.length > 1,
    };
}

export function hasBookingServiceExpression(message) {
    const text = String(message || '').toLowerCase();
    return /\b(?:meeting|conference|boardroom|hotel|restaurant|dining|dinner|lunch|breakfast|table|room|suite|stay|accommodation)s?\b/.test(text)
        || /\b(?:type(?: of (?:the |my |a )?(?:reservation|booking))?|service(?: type)?|(?:reservation|booking) type)\s*(?:is|:|=|should be)\b/.test(text);
}
