/**
 * Converts a duration string like "3d", "2h", "45m", "1month" to milliseconds.
 * Supports weeks (w, week, weeks), days (d, day, days), hours (h, hour, hours),
 * minutes (m, min, minute, minutes), seconds (s, sec, second, seconds), months (mo, month, months).
 * Example: "1w2d3h" = 1 week + 2 days + 3 hours.
 *
 * @param input - The duration string to parse (e.g. "3d2h", "1month", "45m").
 * @returns The total duration in milliseconds.
 */
export function parseDuration(input: string): number {
    const regex = /(\d+)\s*(mo|month|months|w|week|weeks|d|day|days|h|hour|hours|m|min|minute|minutes|s|sec|second|seconds)/gi;
    let match;
    let ms = 0;
    while ((match = regex.exec(input)) !== null) {
        const value = parseInt(match[1]!, 10);
        const unit = match[2]!.toLowerCase();
        switch (unit) {
            case 'mo':
            case 'month':
            case 'months':
                ms += value * 30 * 24 * 60 * 60 * 1000; // Approximate month as 30 days
                break;
            case 'w':
            case 'week':
            case 'weeks':
                ms += value * 7 * 24 * 60 * 60 * 1000;
                break;
            case 'd':
            case 'day':
            case 'days':
                ms += value * 24 * 60 * 60 * 1000;
                break;
            case 'h':
            case 'hour':
            case 'hours':
                ms += value * 60 * 60 * 1000;
                break;
            case 'm':
            case 'min':
            case 'minute':
            case 'minutes':
                ms += value * 60 * 1000;
                break;
            case 's':
            case 'sec':
            case 'second':
            case 'seconds':
                ms += value * 1000;
                break;
        }
    }
    return ms;
}

/**
 * Converts a duration string like "3d", "2h", "45m", "1month" to a human-readable string.
 * Example: "1d2h" => "1 day 2 hours"
 *
 * @param input - The duration string to convert (e.g. "3d2h", "1month", "45m").
 * @returns A human-readable string representing the duration (e.g. "3 days 2 hours").
 */
export function parseDurationToString(input: string): string {
    const regex = /(\d+)\s*(mo|month|months|w|week|weeks|d|day|days|h|hour|hours|m|min|minute|minutes|s|sec|second|seconds)/gi;
    let match;
    const parts: string[] = [];
    while ((match = regex.exec(input)) !== null) {
        const value = parseInt(match[1]!, 10);
        const unit = match[2]!.toLowerCase();
        let label = '';
        switch (unit) {
            case 'mo':
            case 'month':
            case 'months':
                label = value === 1 ? 'month' : 'months';
                break;
            case 'w':
            case 'week':
            case 'weeks':
                label = value === 1 ? 'week' : 'weeks';
                break;
            case 'd':
            case 'day':
            case 'days':
                label = value === 1 ? 'day' : 'days';
                break;
            case 'h':
            case 'hour':
            case 'hours':
                label = value === 1 ? 'hour' : 'hours';
                break;
            case 'm':
            case 'min':
            case 'minute':
            case 'minutes':
                label = value === 1 ? 'minute' : 'minutes';
                break;
            case 's':
            case 'sec':
            case 'second':
            case 'seconds':
                label = value === 1 ? 'second' : 'seconds';
                break;
        }
        if (label) {
            parts.push(`${value} ${label}`);
        }
    }
    return parts.join(' ');
}