// Adapters between the booking layer's results and the shapes the existing
// chat UI already understands.
import { displayDate } from '../platform/time.js';

const option = (item) => (item ? {
  id: item.resource?.id ?? null,
  code: item.resource?.code ?? null,
  // A room/table TYPE name. A specific unit is never promised before it is assigned.
  name: item.resource_type?.name || '',
  capacity: item.capacity,
  available: Boolean(item.available),
  reason: item.reason || null,
} : null);

export function optionSummary(item) {
  return option(item);
}

export function toLegacyAlternative(alternative) {
  if (!alternative) return null;
  return {
    date: displayDate(alternative.date),
    end_date: alternative.end_date ? displayDate(alternative.end_date) : undefined,
    start_time: alternative.start_time, end_time: alternative.end_time,
    available: alternative.available, total: alternative.available,
    selected_option: option(alternative.selected),
    recommendation_type: alternative.recommendation_type,
  };
}

export function toLegacyAvailability(result, alternative = null) {
  const preferredFull = !result.selected && result.other_available?.length;
  return {
    available: result.available,
    total: result.total,
    waitlist: !result.selected,
    waitlist_possible: Boolean(result.waitlist_possible),
    reason: result.selected ? 'available' : result.reason?.code,
    reason_message: result.selected ? '' : result.reason?.message,
    selected_option: option(result.selected),
    options: result.options.map(option),
    other_options: (result.other_available || []).map(option),
    occupied_option: preferredFull ? option(result.options.find((item) => !item.available && item.reason === 'booked')) : null,
    place_recommendation: option(result.other_available?.[0]),
    alternative: toLegacyAlternative(alternative),
    quote: result.selected?.quote || null,
    source: result.source,
    freshness: result.freshness,
  };
}
