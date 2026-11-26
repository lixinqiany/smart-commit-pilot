import * as vscode from 'vscode';

// Match the extension's available UI languages when formatting dates and relative time.
export const displayLocale = /^(en|zh)(-|$)/i.test(vscode.env.language) ? vscode.env.language : 'en';

export function formatRelativeTime(date: Date): string {
    const elapsedSeconds = Math.round((date.getTime() - Date.now()) / 1000);
    const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
        ['year', 60 * 60 * 24 * 365],
        ['month', 60 * 60 * 24 * 30],
        ['week', 60 * 60 * 24 * 7],
        ['day', 60 * 60 * 24],
        ['hour', 60 * 60],
        ['minute', 60],
    ];

    const formatter = new Intl.RelativeTimeFormat(displayLocale, { numeric: 'auto' });
    for (const [unit, seconds] of units) {
        if (Math.abs(elapsedSeconds) >= seconds) {
            return formatter.format(Math.round(elapsedSeconds / seconds), unit);
        }
    }
    return formatter.format(elapsedSeconds, 'second');
}
