import type { Bridge, CommandName, Result, Progress } from '../shared/contracts';
declare const api: Bridge;
api.setRestorePointRetention({ active: 0, removed: 15 });
// @ts-expect-error Retention values are numeric, never strings.
api.setRestorePointRetention({ active: '5', removed: 15 });
// @ts-expect-error Every command must exist in the shared contract.
const invalid: CommandName = 'purgeEverything';
// @ts-expect-error A successful result cannot contain an error instead of data.
const failedResult: Result<number> = { ok: true, error: { code: 'bad', params: {}, message: 'bad' } };
// @ts-expect-error Progress completion is numeric.
const progress: Progress = { phase: 'copying', detail: '', completed: '1' };
void [invalid, failedResult, progress];
