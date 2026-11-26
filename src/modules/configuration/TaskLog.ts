import { randomUUID } from 'node:crypto';
import { ModelResponseError } from '../adaptor/BaseAdaptor';
import { tokenUsage, type TokenBreakdown } from '../adaptor/tokenUsage';
import type { MessageCreationResponse, Usage } from '../adaptor/unified-protocols/response';

type Fields = Record<string, string | number | boolean | null | undefined>;
type Status = 'completed' | 'cancelled' | 'skipped' | 'failed';

export class TaskLog {
    private readonly taskId = randomUUID();
    private readonly started = performance.now();
    private readonly tokens: TokenBreakdown = { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    private modelCalls = 0;
    private callsWithoutTotal = 0;
    private reportedTotalTokens = 0;
    private status: Status = 'completed';
    private reason?: string;

    private constructor(private readonly log: (line: string) => void, private readonly operation: string, context: Fields) {
        this.write('task.started', context);
    }

    static async run<T>(log: (line: string) => void, operation: string, context: Fields, run: (task: TaskLog) => Promise<T>): Promise<T> {
        const task = new TaskLog(log, operation, context);
        try {
            return await run(task);
        } catch (error) {
            task.status = 'failed';
            task.reason = error instanceof Error ? error.name : undefined;
            throw error;
        } finally {
            task.finish();
        }
    }

    progress(step: string, detail: Fields = {}) {
        this.write('task.progress', { step, ...detail });
    }

    stop(status: 'cancelled' | 'skipped', reason?: string) {
        this.status = status;
        this.reason = reason;
    }

    async modelCall(detail: { provider: string; model: string; step: string; attempt: number }, signal: AbortSignal,
        request: () => Promise<MessageCreationResponse>): Promise<MessageCreationResponse> {
        const call = ++this.modelCalls;
        const started = performance.now();
        this.write('model.started', { call, ...detail });
        let usage: Usage | null = null;
        let status: Status = 'completed';
        try {
            const result = await request();
            usage = result.usage;
            return result;
        } catch (error) {
            status = signal.aborted ? 'cancelled' : 'failed';
            if (error instanceof ModelResponseError) { usage = error.usage; }
            throw error;
        } finally {
            const { tokens, totalTokens, reportedTokens } = tokenUsage(usage);
            for (const key of Object.keys(tokens) as (keyof TokenBreakdown)[]) {
                const previous = this.tokens[key];
                const current = tokens[key];
                this.tokens[key] = previous === null || current === null ? null : previous + current;
            }
            this.reportedTotalTokens += reportedTokens;
            if (totalTokens === null) { this.callsWithoutTotal++; }
            this.write('model.usage', { call, ...detail, status, durationMs: Math.round(performance.now() - started),
                tokens, totalTokens, ...(totalTokens === null ? { reportedTotalTokens: reportedTokens } : {}) });
        }
    }

    private finish() {
        this.write('task.finished', {
            status: this.status, reason: this.reason, durationMs: Math.round(performance.now() - this.started),
            modelCalls: this.modelCalls, callsWithoutTotal: this.callsWithoutTotal, tokens: this.tokens,
            totalTokens: this.callsWithoutTotal ? null : this.reportedTotalTokens,
            ...(this.callsWithoutTotal ? { reportedTotalTokens: this.reportedTotalTokens } : {}),
        });
    }

    private write(event: string, detail: Record<string, unknown>) {
        this.log(JSON.stringify({ timestamp: new Date().toISOString(), taskId: this.taskId, operation: this.operation, event, ...detail }));
    }
}
