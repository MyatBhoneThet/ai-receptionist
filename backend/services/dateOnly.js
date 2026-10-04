export function formatDateKey(value) {
    if (!value) return value || '';
    if (typeof value === 'string') return value.slice(0, 10);
    if (value instanceof Date) {
        const yyyy = value.getFullYear();
        const mm = String(value.getMonth() + 1).padStart(2, '0');
        const dd = String(value.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    }
    return String(value).slice(0, 10);
}

export function formatDisplayDateValue(value) {
    if (!value) return '';
    if (typeof value === 'string') {
        const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (isoMatch) {
            const [, yyyy, mm, dd] = isoMatch;
            return `${dd}-${mm}-${yyyy}`;
        }
        return value;
    }
    if (value instanceof Date) {
        const yyyy = value.getFullYear();
        const mm = String(value.getMonth() + 1).padStart(2, '0');
        const dd = String(value.getDate()).padStart(2, '0');
        return `${dd}-${mm}-${yyyy}`;
    }
    return String(value);
}
