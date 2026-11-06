import type { Bridge, CommandName, Commands, Result, Progress, ProgressPhase } from '../shared/contracts';
import { IPC_SCHEMA } from '../shared/ipc-schema.mjs';
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
// @ts-expect-error Progress phase must be a known ProgressPhase union member.
const badPhase: ProgressPhase = 'unknown-phase';
const schemaCheck: Record<CommandName, ((value: unknown) => boolean)[]> = IPC_SCHEMA;
type AssertAllCommandsInBridge = Exclude<CommandName, keyof Commands> extends never ? true : never;
const bridgeCheck: AssertAllCommandsInBridge = true;
void [invalid, failedResult, progress, badPhase, schemaCheck, bridgeCheck];
