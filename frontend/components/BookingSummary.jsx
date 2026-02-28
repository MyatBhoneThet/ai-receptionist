'use client';

import styles from './BookingSummary.module.css';

const LABELS = {
    service_type: 'Service',
    date: 'Date',
    start_time: 'Start Time',
    end_time: 'End Time',
    people: 'Guests',
    location: 'Location',
    notes: 'Notes',
};

const ICONS = {
    restaurant: '🍽️',
    hotel: '🏨',
    meeting: '📅',
};

/**
 * BookingSummary — real-time card showing extracted booking fields
 * @param {{ data: Object, missing_fields: string[], intent: string, confidence: number }} props
 */
export default function BookingSummary({ data, missing_fields = [], intent, confidence }) {
    if (!data || !intent || intent === 'unknown') return null;

    const icon = ICONS[data.service_type] || '📋';
    const pct = Math.round((confidence || 0) * 100);

    return (
        <div className={styles.card}>
            <div className={styles.header}>
                <span className={styles.icon}>{icon}</span>
                <div>
                    <div className={styles.title}>
                        {data.service_type
                            ? data.service_type.charAt(0).toUpperCase() + data.service_type.slice(1)
                            : 'Booking'}
                    </div>
                    <div className={styles.confidence}>
                        <div
                            className={styles.bar}
                            style={{ width: `${pct}%`, background: pct >= 85 ? '#22d3ee' : pct >= 60 ? '#f59e0b' : '#ef4444' }}
                        />
                        <span>{pct}% confident</span>
                    </div>
                </div>
            </div>

            <ul className={styles.fields}>
                {Object.entries(LABELS).map(([key, label]) => {
                    const val = data[key];
                    const missing = missing_fields.includes(key);
                    if (!val && !missing) return null;
                    return (
                        <li key={key} className={missing ? styles.missing : styles.filled}>
                            <span className={styles.label}>{label}</span>
                            <span className={styles.value}>
                                {missing ? '—' : String(val)}
                            </span>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
