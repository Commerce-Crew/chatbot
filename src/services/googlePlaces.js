/**
 * Google Places API - fetch opening hours for a place.
 * Uses Place Details (Legacy) with field opening_hours.
 * Set GOOGLE_PLACES_API_KEY in env.
 */
const { log } = require('../utils/logger');

const BASE_URL = 'https://maps.googleapis.com/maps/api/place/details/json';

function getApiKey(tenant) {
    return tenant?.googlePlacesApiKey || process.env.GOOGLE_PLACES_API_KEY || '';
}

/**
 * Fetch opening hours for a place. Returns a single string suitable for chatbot context.
 * @param {string} placeId - Google Place ID
 * @param {object} [tenant] - optional tenant with googlePlacesApiKey
 * @returns {Promise<string>} - e.g. "Monday: 9:00 AM – 6:00 PM\nTuesday: ..." or ""
 */
async function fetchOpeningHours(placeId, tenant = null) {
    const apiKey = getApiKey(tenant);
    const id = String(placeId || '').trim();
    if (!id || !apiKey) {
        return '';
    }

    const url = new URL(BASE_URL);
    url.searchParams.set('place_id', id);
    url.searchParams.set('fields', 'opening_hours');
    url.searchParams.set('key', apiKey);

    try {
        const response = await fetch(url.toString(), { method: 'GET' });
        if (!response.ok) {
            log('GOOGLE_PLACES', `Place Details HTTP ${response.status}`);
            return '';
        }
        const data = await response.json();
        if (data.status !== 'OK') {
            log('GOOGLE_PLACES', `Place Details status: ${data.status}`);
            return '';
        }
        const hours = data.result?.opening_hours;
        if (!hours) return '';

        const weekdayText = hours.weekday_text;
        if (Array.isArray(weekdayText) && weekdayText.length > 0) {
            return weekdayText.join('\n');
        }
        return '';
    } catch (err) {
        log('GOOGLE_PLACES', 'Fetch error', err.message);
        return '';
    }
}

module.exports = { fetchOpeningHours, getApiKey };
