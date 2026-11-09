import type { Bridge, CommandName, Commands, Result, Progress, ProgressPhase } from '../shared/contracts';
import { IPC_SCHEMA } from '../shared/ipc-schema.mjs';

// 跨进程契约静态类型测试：验证 Bridge 方法签名、IPC_SCHEMA 键集合及联合类型约束在编译期严格对齐
declare const api: Bridge;
api.setRestorePointRetention({ active: 0, removed: 15 });
// @ts-expect-error 保留策略数值字段严禁传入字符串
api.setRestorePointRetention({ active: '5', removed: 15 });
api.reorderGames(['elden-ring', 'sekiro']);
// @ts-expect-error 游戏排序必须传入字符串 ID 数组
api.reorderGames('elden-ring');
// @ts-expect-error 所有命令名称必须存在于共享契约中
const invalid: CommandName = 'purgeEverything';
// @ts-expect-error 成功结果分支不能包含 error 字段而缺失 data
const failedResult: Result<number> = { ok: true, error: { code: 'bad', params: {}, message: 'bad' } };
// @ts-expect-error 进度已完成计数必须为数值类型
const progress: Progress = { phase: 'copying', detail: '', completed: '1' };
// @ts-expect-error 进度阶段必须属于已知的 ProgressPhase 联合类型成员
const badPhase: ProgressPhase = 'unknown-phase';
const schemaCheck: Record<CommandName, ((value: unknown) => boolean)[]> = IPC_SCHEMA;
type AssertAllCommandsInBridge = Exclude<CommandName, keyof Commands> extends never ? true : never;
const bridgeCheck: AssertAllCommandsInBridge = true;
void [invalid, failedResult, progress, badPhase, schemaCheck, bridgeCheck];
