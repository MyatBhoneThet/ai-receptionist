'use client';

import { confirmBooking } from '../lib/api.js';
import styles from './ConfirmModal.module.css';

/**
 * ConfirmModal — final confirmation dialog before committing booking
 * @param {{ sessionId: string, summary: Object, onConfirm: () => void, onCancel: () => void }} props
 */
export default function ConfirmModal({ sessionId, summary, onConfirm, onCancel }) {
    if (!summary) return null;

    const handleConfirm = async () => {
        try {
            await confirmBooking(sessionId);
            onConfirm();
        } catch (err) {
            console.error('[ConfirmModal] Confirm error:', err);
            onConfirm(); // still clear UI
        }
    };

    return (
        <div className={styles.overlay} role="dialog" aria-modal="true">
            <div className={styles.modal}>
                <div className={styles.top}>
                    <span className={styles.check}>✅</span>
                    <h2 className={styles.title}>Confirm your booking?</h2>
                </div>

                <ul className={styles.list}>
                    {summary.service_type && (
                        <li><span>Service</span><strong>{summary.service_type}</strong></li>
                    )}
                    {summary.date && (
                        <li><span>Date</span><strong>{summary.date}</strong></li>
                    )}
                    {summary.start_time && (
                        <li><span>Time</span><strong>{summary.start_time}{summary.end_time ? ` – ${summary.end_time}` : ''}</strong></li>
                    )}
                    {summary.people && (
                        <li><span>Guests</span><strong>{summary.people}</strong></li>
                    )}
                    {summary.location && (
                        <li><span>Location</span><strong>{summary.location}</strong></li>
                    )}
                    {summary.notes && (
                        <li><span>Notes</span><strong>{summary.notes}</strong></li>
                    )}
                </ul>

                <div className={styles.actions}>
                    <button className={styles.cancel} onClick={onCancel}>
                        Edit
                    </button>
                    <button className={styles.confirm} onClick={handleConfirm}>
                        Confirm Booking
                    </button>
                </div>
            </div>
        </div>
    );
}
