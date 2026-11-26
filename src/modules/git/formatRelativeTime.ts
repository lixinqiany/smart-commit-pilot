import * as vscode from 'vscode';

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

    const formatter = new Intl.RelativeTimeFormat(vscode.env.language, { numeric: 'auto' });
    for (const [unit, seconds] of units) {
        if (Math.abs(elapsedSeconds) >= seconds) {
            return formatter.format(Math.round(elapsedSeconds / seconds), unit);
        }
    }
    return formatter.format(elapsedSeconds, 'second');
}
